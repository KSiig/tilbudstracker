#!/usr/bin/env tsx
/**
 * SII-73 Pass 3 CLI entry point.
 *
 * Usage:
 *   pnpm normalize:llm             # write assignments to the configured DB
 *   pnpm normalize:llm --dry-run   # print proposed clusters, no DB writes
 *
 * The `--dry-run` flag makes ONE live paid API request to the configured
 * MiniMax endpoint and prints the proposed clusters to stdout. It does not
 * open or write to any database. Set `MINIMAX_API_KEY_PERSONAL` in the env
 * for the request to succeed.
 */
import { createDb } from "../db.js";
import {
  buildRequestBody,
  clusterHeadings,
  defaultConfig,
  parseResponse,
  type LlmConfig,
} from "./llm.js";

function getFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

async function runDryRun(config: LlmConfig): Promise<void> {
  const sample = [
    "Dansk hel kylling",
    "Rose Fersk Dansk Hel Kylling",
    "Dansk hakket oksekød 8-12%",
    "Rose hakket dansk kyllingekød",
  ];
  console.log("[dry-run] sending", sample.length, "headings");
  const body = buildRequestBody(config, sample);
  console.log("[dry-run] request body keys:", Object.keys(body).sort().join(","));
  const resp = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    console.error(`[dry-run] http ${resp.status}`);
    process.exit(1);
  }
  const data = await resp.json();
  const clusters = parseResponse(data);
  console.log(`[dry-run] ${clusters.length} clusters:`);
  for (const c of clusters) {
    console.log("  -", c.title, "→", c.member_indices.map((i) => sample[i]).join(" | "));
  }
}

async function runWrite(config: LlmConfig): Promise<void> {
  const db = await createDb();
  const { normalizeLlm } = await import("./llm.js");
  const result = await normalizeLlm(db, config);
  console.log(JSON.stringify(result, null, 2));
  await db.close();
}

const dryRun = getFlag("dry-run");
const config = defaultConfig();
if (!config.apiKey) {
  console.error(
    "MINIMAX_API_KEY_PERSONAL is not set; pass it via the env or .env file before running.",
  );
  process.exit(1);
}
if (dryRun) {
  await runDryRun(config);
} else {
  await runWrite(config);
}
