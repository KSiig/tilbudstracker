import type { DbClient } from "../db.js";
import { buildPrompt } from "./prompt.js";

/**
 * Configurable LLM endpoint + auth. The defaults match MiniMax's OpenAI-compat
 * surface; tests pass a stubbed `fetch` so they never hit the network.
 */
export interface LlmConfig {
  apiKey: string; // from $MINIMAX_API_KEY_PERSONAL
  baseUrl: string; // "https://api.minimax.io/v1"
  model: string; // "MiniMax-M3"
}

export interface ClusterResult {
  title: string;
  member_indices: number[];
}

/**
 * Tool definition that forces the model to return JSON via tool_calls. The
 * response is then guaranteed JSON in `tool_calls[0].function.arguments` — no
 * markdown fences to strip, no `<think>` blocks to peel off. Combined with
 * `thinking: { type: "disabled" }`, no reasoning tokens appear in `content`.
 *
 * Source: https://platform.minimax.io/docs/api-reference/text-openai-api
 *         (thinking-control + tools rows).
 */
const CLUSTERS_TOOL = {
  type: "function" as const,
  function: {
    name: "record_clusters",
    description: "Record the cluster assignments discovered by the model.",
    parameters: {
      type: "object",
      properties: {
        clusters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Canonical short product name.",
              },
              member_indices: {
                type: "array",
                items: { type: "integer", minimum: 0 },
                description: "0-based indices into the input headings.",
              },
            },
            required: ["title", "member_indices"],
            additionalProperties: false,
          },
        },
      },
      required: ["clusters"],
      additionalProperties: false,
    },
  },
};

/**
 * One raw offer row we read from the DB before clustering.
 */
interface UnassignedOffer {
  id: string;
  heading: string;
}

/**
 * Build the request body sent to the LLM. Exported so tests can assert the
 * exact shape (thinking disabled, tool_choice forcing `record_clusters`,
 * reasoning_split=true).
 */
export function buildRequestBody(
  config: LlmConfig,
  headings: string[],
): Record<string, unknown> {
  return {
    model: config.model,
    messages: [
      {
        role: "system",
        content:
          "You are a precise data-cleaning assistant. Always call the record_clusters tool exactly once with your final answer.",
      },
      { role: "user", content: buildPrompt(headings) },
    ],
    // Disable internal thinking so it does not appear in `content` or
    // `reasoning_details`. Per the MiniMax docs, on M3 this is accepted and
    // takes effect.
    thinking: { type: "disabled" },
    // Force structured output: the model must call this tool. Output is
    // guaranteed JSON in `tool_calls[0].function.arguments`.
    tools: [CLUSTERS_TOOL],
    tool_choice: { type: "function", function: { name: "record_clusters" } },
    // Separate any residual reasoning into `reasoning_details` (defensive).
    reasoning_split: true,
    max_completion_tokens: 4096,
  };
}

/**
 * Parse the LLM response into clusters. Tolerates empty / malformed responses
 * by returning `[]` — the caller treats that as "no clusters this batch".
 */
export function parseResponse(json: any): ClusterResult[] {
  const toolCall = json?.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.function?.name !== "record_clusters") return [];
  let args: any;
  try {
    // The API returns `arguments` as a JSON string per OpenAI's tool-call shape.
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return [];
  }
  if (!Array.isArray(args?.clusters)) return [];
  return args.clusters.filter(
    (c: any) =>
      c &&
      typeof c.title === "string" &&
      Array.isArray(c.member_indices) &&
      c.member_indices.every((i: unknown) => Number.isInteger(i)) &&
      c.member_indices.length >= 2, // singletons are not useful for Pass 3
  );
}

/**
 * Send one prompt and parse the result. `fetchImpl` defaults to global `fetch`
 * so tests can stub it without monkey-patching globals.
 */
export async function clusterHeadings(
  config: LlmConfig,
  headings: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<ClusterResult[]> {
  const resp = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildRequestBody(config, headings)),
  });
  if (!resp.ok) {
    throw new Error(`llm_http_${resp.status}`);
  }
  const data = await resp.json();
  return parseResponse(data);
}

/**
 * Sleep helper so tests can fast-forward without touching real timers.
 */
export function throttle(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface NormalizeLlmResult {
  promptsSent: number;
  clustersCreated: number;
  offersNormalized: number;
  capReached: boolean;
  remainder: number;
}

/**
 * Per-invocation cap. The Cloud Function has a 300s timeout. The default of
 * 60 leaves room for the prior daily scrape (~30s), per-call latency
 * (~3s), and the 350ms post-call throttle; see `.env.example` for the math.
 * The weekly scheduler invokes this; each run picks up a fresh slice and the
 * remainder waits for the next run.
 */
export const DEFAULT_CAP = 60;

/**
 * Resolve the `NORMALIZE_LLM_CAP` env value to a positive integer, falling
 * back to {@link DEFAULT_CAP} when missing, non-finite, non-positive, or
 * non-integer. A bad cap would let the loop burn past the Cloud Function
 * 300s timeout; this validator keeps the loop safely bounded.
 */
export function parseCap(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_CAP;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.warn(
      `[normalize:llm] NORMALIZE_LLM_CAP=${JSON.stringify(value)} is invalid; falling back to DEFAULT_CAP=${DEFAULT_CAP}`
    );
    return DEFAULT_CAP;
  }
  return n;
}

/**
 * Max headings per prompt. Keeps the per-call token budget predictable and
 * well below the 10M TPM rate limit even with batches of 20.
 */
const BATCH_SIZE = 20;

interface Deps {
  db: DbClient;
  config: LlmConfig;
  cap: number;
  now: () => string; // ISO timestamp for created_at
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  rng: () => number; // for noise sampling
}

/**
 * Read un-normalized offers and assign cluster IDs via the LLM. Returns a
 * summary — the CLI prints it.
 */
export async function normalizeLlm(
  dbOrDeps: DbClient | Deps,
  configOverride?: Partial<LlmConfig>,
): Promise<NormalizeLlmResult> {
  const isDeps = (x: unknown): x is Deps =>
    typeof x === "object" && x !== null && "db" in (x as object);
  const deps: Deps = isDeps(dbOrDeps)
    ? dbOrDeps
    : {
        db: dbOrDeps,
        config: defaultConfig(configOverride),
        cap: parseCap(process.env.NORMALIZE_LLM_CAP),
        now: () => new Date().toISOString(),
        fetchImpl: fetch,
        sleep: throttle,
        rng: Math.random,
      };

  const { db, config, cap, now, fetchImpl, sleep, rng } = deps;
  const noiseFn = rng ?? Math.random;

  // 1. Read all un-normalized, non-bundle-spawned offers.
  const rows = await db.all<UnassignedOffer>(
    `SELECT id, heading FROM offers WHERE normalized_id IS NULL AND is_split = 0 ORDER BY id`,
  );
  const total = rows.length;

  if (total === 0) {
    return {
      promptsSent: 0,
      clustersCreated: 0,
      offersNormalized: 0,
      capReached: false,
      remainder: 0,
    };
  }

  // 2. Group into batches of ≤ BATCH_SIZE. Each batch keeps its own indices;
  //    we add 3-5 noise headings (also from the unassigned pool) to reduce the
  //    chance the model returns a near-trivial cluster based on overlap.
  let promptsSent = 0;
  let clustersCreated = 0;
  let offersNormalized = 0;
  let capReached = false;

  let cursor = 0;
  while (cursor < total && promptsSent < cap) {
    const slice = rows.slice(cursor, cursor + BATCH_SIZE);
    const noiseCount = 3 + Math.floor(noiseFn() * 3); // 3..5
    const noisePool = rows
      .filter((r) => !slice.some((s) => s.id === r.id))
      .sort(() => noiseFn() - 0.5)
      .slice(0, Math.min(noiseCount, total - slice.length));
    const combined = [...slice, ...noisePool];

    let clusters: ClusterResult[];
    try {
      clusters = await clusterHeadings(config, combined.map((r) => r.heading), fetchImpl);
    } catch (err) {
      console.error("[normalize:llm] call failed (continuing):", err);
      cursor += BATCH_SIZE;
      promptsSent += 1;
      await sleep(350);
      continue;
    }
    promptsSent += 1;

    // 3. Write one offers_normalized row per cluster, then point the
    //    member offers at it. Skip clusters that reference noise indices
    //    outside the slice — those are singletons, not useful for Pass 3.
    //    Also dedupe across clusters: if the model assigns the same offer
    //    to two clusters, the first claim wins and the duplicate is dropped
    //    from subsequent clusters. Without this, an offer could be linked to
    //    two different `offers_normalized` rows by the same prompt run.
    const sliceIds = new Set(slice.map((r) => r.id));
    const idByIndex = new Map(combined.map((r, i) => [i, r.id] as const));
    const claimed = new Set<string>();

    for (const cluster of clusters) {
      const memberIds = cluster.member_indices
        .map((i) => idByIndex.get(i))
        .filter((id): id is string => typeof id === "string" && sliceIds.has(id) && !claimed.has(id));
      if (memberIds.length < 2) continue;

      const normRow = await db.get<{ id: number }>(
        `INSERT INTO offers_normalized (title, created_at, created_by, notes)
         VALUES (?, ?, 'system:llm', NULL)
         RETURNING id`,
        [cluster.title, now()],
      );
      if (!normRow) continue;

      await db.batch(
        memberIds.map((id) => ({
          sql: `UPDATE offers SET normalized_id = ? WHERE id = ? AND normalized_id IS NULL`,
          params: [normRow.id, id],
        })),
      );
      for (const id of memberIds) claimed.add(id);
      clustersCreated += 1;
      offersNormalized += memberIds.length;
    }

    cursor += BATCH_SIZE;
    await sleep(350);
  }

  if (cursor < total && promptsSent >= cap) {
    capReached = true;
    console.log(`cap reached: skipping ${total - cursor} remaining offers`);
  }

  return {
    promptsSent,
    clustersCreated,
    offersNormalized,
    capReached,
    remainder: capReached ? total - cursor : 0,
  };
}

export function defaultConfig(override?: Partial<LlmConfig>): LlmConfig {
  return {
    apiKey: process.env.MINIMAX_API_KEY_PERSONAL ?? "",
    baseUrl: process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1",
    model: process.env.MINIMAX_MODEL ?? "MiniMax-M3",
    ...override,
  };
}
