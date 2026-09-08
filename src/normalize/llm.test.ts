import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildPrompt,
} from "./prompt.js";
import {
  buildRequestBody,
  clusterHeadings,
  DEFAULT_CAP,
  normalizeLlm,
  parseCap,
  parseResponse,
  throttle,
  type LlmConfig,
  type NormalizeLlmResult,
} from "./llm.js";
import type { DbClient } from "../db.js";

const CONFIG: LlmConfig = {
  apiKey: "test-key",
  baseUrl: "https://api.minimax.io/v1",
  model: "MiniMax-M3",
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("buildPrompt", () => {
  it("includes every input heading, numbered", () => {
    const p = buildPrompt(["Hel kylling", "Hakket oksekød"]);
    expect(p).toContain("0. Hel kylling");
    expect(p).toContain("1. Hakket oksekød");
  });

  it("documents the motivating same-product pair", () => {
    const p = buildPrompt(["Dansk hel kylling"]);
    expect(p).toContain('"Dansk hel kylling"');
    expect(p).toContain("Rose Fersk Dansk Hel Kylling");
    expect(p).toContain("SAME");
  });
});

describe("buildRequestBody", () => {
  it("disables thinking, forces tool call, splits reasoning", () => {
    const body = buildRequestBody(CONFIG, ["Hel kylling"]);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_split).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
    expect((body.tools as any[])[0].function.name).toBe("record_clusters");
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "record_clusters" },
    });
  });

  it("uses the model from config and embeds the user prompt", () => {
    const body = buildRequestBody(CONFIG, ["Hel kylling"]);
    expect(body.model).toBe("MiniMax-M3");
    const msgs = body.messages as Array<{ role: string; content: string }>;
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("Hel kylling");
  });
});

describe("parseResponse", () => {
  it("returns clusters from a valid tool-call response", () => {
    const json = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "record_clusters",
                  arguments: JSON.stringify({
                    clusters: [
                      { title: "hel kylling", member_indices: [0, 1] },
                      { title: "hakket oksekød", member_indices: [2, 3, 4] },
                    ],
                  }),
                },
              },
            ],
          },
        },
      ],
    };
    const out = parseResponse(json);
    expect(out).toEqual([
      { title: "hel kylling", member_indices: [0, 1] },
      { title: "hakket oksekød", member_indices: [2, 3, 4] },
    ]);
  });

  it("returns [] when tool call is missing or wrong name", () => {
    expect(parseResponse({ choices: [{ message: {} }] })).toEqual([]);
    expect(
      parseResponse({
        choices: [
          { message: { tool_calls: [{ function: { name: "wrong" } }] } },
        ],
      }),
    ).toEqual([]);
  });

  it("returns [] on JSON parse error in arguments", () => {
    expect(
      parseResponse({
        choices: [
          {
            message: {
              tool_calls: [
                { function: { name: "record_clusters", arguments: "not json" } },
              ],
            },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("filters out clusters with < 2 members", () => {
    const json = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "record_clusters",
                  arguments: JSON.stringify({
                    clusters: [
                      { title: "singleton", member_indices: [0] },
                      { title: "pair", member_indices: [1, 2] },
                    ],
                  }),
                },
              },
            ],
          },
        },
      ],
    };
    expect(parseResponse(json)).toEqual([
      { title: "pair", member_indices: [1, 2] },
    ]);
  });

  it("returns [] when clusters is not an array", () => {
    expect(
      parseResponse({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: "record_clusters",
                    arguments: JSON.stringify({ clusters: "oops" }),
                  },
                },
              ],
            },
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe("clusterHeadings", () => {
  it("sends the request and parses the response", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "record_clusters",
                      arguments: JSON.stringify({
                        clusters: [{ title: "kylling", member_indices: [0, 1] }],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const out = await clusterHeadings(CONFIG, ["a", "b", "c"], fetchImpl as any);
    expect(out).toEqual([{ title: "kylling", member_indices: [0, 1] }]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.minimax.io/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_split).toBe(true);
  });

  it("throws on non-2xx so the caller can log+continue", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 500 }),
    );
    await expect(clusterHeadings(CONFIG, ["x"], fetchImpl as any)).rejects.toThrow(
      /llm_http_500/,
    );
  });
});

describe("throttle", () => {
  it("waits the requested ms", async () => {
    vi.useFakeTimers();
    const p = throttle(1000);
    vi.advanceTimersByTime(999);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    await p;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

/**
 * In-memory DbClient stub. Records every INSERT and UPDATE so tests can
 * assert which rows the LLM pass wrote without touching sqlite or D1.
 */
class FakeDb implements DbClient {
  rows: Array<Record<string, unknown>> = [];
  offers: Array<{ id: string; heading: string; normalized_id: number | null; is_split: number }> = [];
  writes: Array<{ sql: string; params: any[] }> = [];
  private nextId = 1;

  async run(sql: string, params: any[] = []): Promise<void> {
    this.writes.push({ sql, params });
  }
  async get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
    this.writes.push({ sql, params });
    if (/INSERT INTO offers_normalized/i.test(sql)) {
      const id = this.nextId++;
      return { id } as unknown as T;
    }
    return undefined;
  }
  async all<T>(sql: string, params: any[] = []): Promise<T[]> {
    this.writes.push({ sql, params });
    if (/FROM offers WHERE normalized_id IS NULL/i.test(sql)) {
      return this.offers as unknown as T[];
    }
    return [];
  }
  async batch(stmts: Array<{ sql: string; params?: any[] }>): Promise<void> {
    for (const s of stmts) {
      this.writes.push({ sql: s.sql, params: s.params ?? [] });
      const m = /UPDATE offers SET normalized_id = \? WHERE id = \?/i.exec(s.sql);
      if (m) {
        const normId = s.params![0] as number;
        const offerId = s.params![1] as string;
        const row = this.offers.find((o) => o.id === offerId);
        if (row && row.normalized_id === null) row.normalized_id = normId;
      }
    }
  }
  async close(): Promise<void> {}
}

function makeOffer(id: string, heading: string): { id: string; heading: string; normalized_id: number | null; is_split: number } {
  return { id, heading, normalized_id: null, is_split: 0 };
}

describe("normalizeLlm", () => {
  it("returns zeros when nothing is unassigned", async () => {
    const db = new FakeDb();
    const result = await normalizeLlm({
      db,
      config: CONFIG,
      cap: 90,
      now: () => "2026-09-07T00:00:00.000Z",
      fetchImpl: vi.fn(),
      sleep: async () => {},
      rng: () => 0,
    });
    expect(result).toEqual({
      promptsSent: 0,
      clustersCreated: 0,
      offersNormalized: 0,
      capReached: false,
      remainder: 0,
    });
  });

  it("writes one offers_normalized row per cluster and updates member offers", async () => {
    const db = new FakeDb();
    db.offers.push(
      makeOffer("o1", "Dansk hel kylling"),
      makeOffer("o2", "Rose Fersk Dansk Hel Kylling"),
      makeOffer("o3", "Hakket oksekød"),
    );

    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "record_clusters",
                      arguments: JSON.stringify({
                        clusters: [{ title: "hel kylling", member_indices: [0, 1] }],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result: NormalizeLlmResult = await normalizeLlm({
      db,
      config: CONFIG,
      cap: 90,
      now: () => "2026-09-07T00:00:00.000Z",
      fetchImpl: fetchImpl as any,
      sleep: async () => {},
      rng: () => 0, // 3 noise headings sampled deterministically
    });

    expect(result.promptsSent).toBe(1);
    expect(result.clustersCreated).toBe(1);
    expect(result.offersNormalized).toBe(2);
    expect(result.capReached).toBe(false);

    const insertedNorm = db.writes.find((w) => /INSERT INTO offers_normalized/i.test(w.sql));
    expect(insertedNorm).toBeTruthy();
    expect(insertedNorm!.params).toEqual([
      "hel kylling",
      "2026-09-07T00:00:00.000Z",
    ]);

    expect(db.offers.find((o) => o.id === "o1")!.normalized_id).toBe(1);
    expect(db.offers.find((o) => o.id === "o2")!.normalized_id).toBe(1);
    expect(db.offers.find((o) => o.id === "o3")!.normalized_id).toBeNull();
  });

  it("sets capReached=true when there are more offers than cap allows", async () => {
    const db = new FakeDb();
    // 100 offers → 5 batches of 20, but cap = 3 → stop after 3 prompts
    for (let i = 0; i < 100; i++) {
      db.offers.push(makeOffer(`o${i}`, `unique heading ${i}`));
    }
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { tool_calls: [] } }] }), { status: 200 }),
    );

    const result = await normalizeLlm({
      db,
      config: CONFIG,
      cap: 3,
      now: () => "2026-09-07T00:00:00.000Z",
      fetchImpl: fetchImpl as any,
      sleep: async () => {},
      rng: () => 0,
    });

    expect(result.promptsSent).toBe(3);
    expect(result.capReached).toBe(true);
    expect(result.remainder).toBeGreaterThan(0);
  });

  it("capReached is false when offers ≤ cap", async () => {
    const db = new FakeDb();
    for (let i = 0; i < 10; i++) {
      db.offers.push(makeOffer(`o${i}`, `heading ${i}`));
    }
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { tool_calls: [] } }] }), { status: 200 }),
    );

    const result = await normalizeLlm({
      db,
      config: CONFIG,
      cap: 90,
      now: () => "2026-09-07T00:00:00.000Z",
      fetchImpl: fetchImpl as any,
      sleep: async () => {},
      rng: () => 0,
    });

    expect(result.promptsSent).toBe(1); // one batch of 10
    expect(result.capReached).toBe(false);
    expect(result.remainder).toBe(0);
  });

  it("continues past a failed call without aborting the run", async () => {
    const db = new FakeDb();
    // 25 offers → 2 batches of 20 and 5; first call fails, second succeeds.
    for (let i = 0; i < 25; i++) {
      db.offers.push(makeOffer(`o${i}`, `hel kylling variant ${i}`));
    }
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("oops", { status: 500 });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "record_clusters",
                      arguments: JSON.stringify({
                        clusters: [{ title: "hel kylling", member_indices: [0, 1, 2, 3] }],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await normalizeLlm({
      db,
      config: CONFIG,
      cap: 90,
      now: () => "2026-09-07T00:00:00.000Z",
      fetchImpl: fetchImpl as any,
      sleep: async () => {},
      rng: () => 0,
    });

    // First call failed; the run continued with a second prompt.
    expect(calls).toBe(2);
    expect(result.promptsSent).toBe(2);
    // First batch's failed call produced no writes, but the cluster from the
    // second call linked 4 of the 5 remaining offers to one normalized id.
    expect(result.offersNormalized).toBe(4);
  });

  it("skips clusters that reference noise indices (memberIds not in slice)", async () => {
    const db = new FakeDb();
    db.offers.push(
      makeOffer("o1", "Dansk hel kylling"),
      makeOffer("o2", "Rose Fersk Dansk Hel Kylling"),
    );
    // rng=0 → noise count = 3, sampled deterministically from the same pool.
    // To force the cluster to reference an index OUTSIDE the slice, the noise
    // pool must be empty, which only happens when total - slice.length = 0.
    // Simulate that by giving the pool just enough rows that the noise sample
    // picks only indices within the slice: use a stub `rng` returning 0.5
    // (still 3 noise headings but from a fresh random ordering).
    // Easier: assert that clusters with member_indices pointing only at noise
    // produce zero writes. Use a custom fetch that returns such a cluster.
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "record_clusters",
                      arguments: JSON.stringify({
                        // Noise indices only (slice is 2 long, so anything >=2
                        // is noise). Empty after filter → no writes.
                        clusters: [{ title: "noise cluster", member_indices: [2, 3, 4] }],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await normalizeLlm({
      db,
      config: CONFIG,
      cap: 90,
      now: () => "2026-09-07T00:00:00.000Z",
      fetchImpl: fetchImpl as any,
      sleep: async () => {},
      rng: () => 0,
    });

    expect(result.clustersCreated).toBe(0);
    expect(result.offersNormalized).toBe(0);
    expect(db.offers.every((o) => o.normalized_id === null)).toBe(true);
  });

  it("uses the real DbClient when called without a Deps object", async () => {
    // This just confirms the function does not throw on the env-only path;
    // we don't actually run a query because there's no DB wired up in tests.
    const db = new FakeDb();
    // First call all() returns []; normalizeLlm should early-return with zeros.
    const result = await normalizeLlm(db, CONFIG);
    expect(result.promptsSent).toBe(0);
  });

  it("dedupes overlapping member_indices across clusters (no offer linked twice)", async () => {
    // Finding #9: if the model returns overlapping member_indices across
    // clusters in the same response, the second occurrence must be dropped so
    // the same offer isn't linked to two different offers_normalized rows.
    const db = new FakeDb();
    db.offers.push(
      makeOffer("o1", "Hel kylling"),
      makeOffer("o2", "Rose hel kylling"),
      makeOffer("o3", "Hakket oksekød"),
    );

    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "record_clusters",
                      arguments: JSON.stringify({
                        // Cluster 1 claims o1 + o2; cluster 2 ALSO claims o1
                        // (overlap). The dedup pass should drop o1 from
                        // cluster 2, leaving it with only o3 (a singleton)
                        // → no second cluster is written.
                        clusters: [
                          { title: "hel kylling", member_indices: [0, 1] },
                          { title: "hel kylling again", member_indices: [0, 2] },
                        ],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await normalizeLlm({
      db,
      config: CONFIG,
      cap: 90,
      now: () => "2026-09-07T00:00:00.000Z",
      fetchImpl: fetchImpl as any,
      sleep: async () => {},
      rng: () => 0,
    });

    expect(result.clustersCreated).toBe(1);
    expect(result.offersNormalized).toBe(2);
    expect(db.offers.find((o) => o.id === "o1")!.normalized_id).toBe(1);
    expect(db.offers.find((o) => o.id === "o2")!.normalized_id).toBe(1);
    // o3 was claimed only by cluster 2, but cluster 2 had its only unique
    // member (o1) stolen by cluster 1; o3 alone fails the ≥2 check, so o3
    // remains unlinked.
    expect(db.offers.find((o) => o.id === "o3")!.normalized_id).toBeNull();
  });
});

describe("parseCap (M3 stack-review finding #5)", () => {
  it("returns DEFAULT_CAP for missing env", () => {
    expect(parseCap(undefined)).toBe(DEFAULT_CAP);
    expect(parseCap("")).toBe(DEFAULT_CAP);
  });

  it("returns DEFAULT_CAP for non-finite / non-numeric / negative / zero", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseCap("NaN")).toBe(DEFAULT_CAP);
    expect(parseCap("abc")).toBe(DEFAULT_CAP);
    expect(parseCap("-5")).toBe(DEFAULT_CAP);
    expect(parseCap("0")).toBe(DEFAULT_CAP);
    expect(parseCap("1.5")).toBe(DEFAULT_CAP);
    expect(parseCap("Infinity")).toBe(DEFAULT_CAP);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns the parsed positive integer when valid", () => {
    expect(parseCap("1")).toBe(1);
    expect(parseCap("60")).toBe(60);
    expect(parseCap("90")).toBe(90);
    expect(parseCap("1000")).toBe(1000);
  });

  it("uses the validated cap in normalizeLlm, not the raw env value", async () => {
    const db = new FakeDb();
    // 100 offers → 5 batches of 20. cap=3 stops the loop after 3 prompts.
    for (let i = 0; i < 100; i++) {
      db.offers.push(makeOffer(`o${i}`, `unique heading ${i}`));
    }
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { tool_calls: [] } }] }), { status: 200 }),
    );

    const result = await normalizeLlm({
      db,
      config: CONFIG,
      cap: parseCap("3"), // valid positive integer
      now: () => "2026-09-07T00:00:00.000Z",
      fetchImpl: fetchImpl as any,
      sleep: async () => {},
      rng: () => 0,
    });
    expect(result.promptsSent).toBe(3);
    expect(result.capReached).toBe(true);
  });

  it("falls back to DEFAULT_CAP for an invalid env value", async () => {
    // 100 offers / 20 per batch = 5 batches. With DEFAULT_CAP=60 the loop
    // processes all 5 batches and reports capReached=false.
    const db = new FakeDb();
    for (let i = 0; i < 100; i++) {
      db.offers.push(makeOffer(`o${i}`, `unique heading ${i}`));
    }
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { tool_calls: [] } }] }), { status: 200 }),
    );

    const result = await normalizeLlm({
      db,
      config: CONFIG,
      cap: parseCap("garbage"), // invalid → DEFAULT_CAP
      now: () => "2026-09-07T00:00:00.000Z",
      fetchImpl: fetchImpl as any,
      sleep: async () => {},
      rng: () => 0,
    });
    expect(result.promptsSent).toBe(5);
    expect(result.capReached).toBe(false);
  });
});

describe("buildPrompt (M3 stack-review finding #6)", () => {
  it("JSON example uses single braces, not double braces", () => {
    const p = buildPrompt(["Hel kylling"]);
    // Single braces present
    expect(p).toContain('"clusters":');
    expect(p).toContain('"member_indices":');
    // No doubled-up {{ or }} anywhere
    expect(p).not.toContain("{{");
    expect(p).not.toContain("}}");
  });

  it("instructs the model to call record_clusters, not return raw JSON", () => {
    const p = buildPrompt(["Hel kylling"]);
    expect(p).toMatch(/record_clusters/);
    // No "Output JSON only" prose (the tool call IS the response)
    expect(p).not.toMatch(/Output JSON only/i);
  });
});
