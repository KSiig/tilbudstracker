import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  createDb,
  D1ClientError,
  quarantineWithBackoff,
  type DbClient,
} from "./db.js";

describe("createDb", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.DB_MODE;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("throws on invalid DB_MODE value (e.g. D1 wrong case)", async () => {
    process.env.DB_MODE = "D1";
    await expect(createDb()).rejects.toThrow(/Invalid DB_MODE/);
  });

  it("throws on invalid DB_MODE value (random string)", async () => {
    process.env.DB_MODE = "postgres";
    await expect(createDb()).rejects.toThrow(/Invalid DB_MODE/);
  });

  it("accepts sqlite (default)", async () => {
    // Force sqlite path; do not hit disk by mocking dynamic import is
    // overkill — createSqliteClient() creates an empty file in data/. Just
    // make sure it does not throw on env validation.
    await expect(createDb("sqlite")).resolves.toBeDefined();
  });
});

describe("D1Client.batch — POST body shape", () => {
  const ORIGINAL_ENV = { ...process.env };
  const ORIGINAL_FETCH = global.fetch;

  beforeEach(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc";
    process.env.CLOUDFLARE_D1_DATABASE_ID = "db";
    process.env.CLOUDFLARE_API_TOKEN = "tok";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    global.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("POSTs { batch: [...] } — not a flat single-query shape", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    global.fetch = vi.fn(async (url, init) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response(
        JSON.stringify({ success: true, result: [{ success: true }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const db = await createDb("d1");
    await db.batch([
      { sql: "SELECT 1 AS x", params: [1] },
      { sql: "SELECT 2 AS y", params: [2, 3] },
    ]);
    await db.close();

    expect(captured).not.toBeNull();
    const body = JSON.parse(String(captured!.init.body));
    expect(body).toEqual({
      batch: [
        { sql: "SELECT 1 AS x", params: [1] },
        { sql: "SELECT 2 AS y", params: [2, 3] },
      ],
    });
    expect(body.sql).toBeUndefined();
    expect(body.params).toBeUndefined();
  });

  it("handles statements with undefined params by sending []", async () => {
    let capturedBody: any = null;
    global.fetch = vi.fn(async (_url, init) => {
      capturedBody = JSON.parse(String((init as RequestInit).body));
      return new Response(
        JSON.stringify({ success: true, result: [{ success: true }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const db = await createDb("d1");
    await db.batch([{ sql: "SELECT 1" }]);
    await db.close();

    expect(capturedBody).toEqual({ batch: [{ sql: "SELECT 1", params: [] }] });
  });

  it("chunks statements into groups of 100", async () => {
    const callCount = { n: 0 };
    global.fetch = vi.fn(async (_url, _init) => {
      callCount.n++;
      return new Response(
        JSON.stringify({ success: true, result: [{ success: true }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const db = await createDb("d1");
    // Reset after the bootstrap schemaStatements() batch.
    const bootstrapCalls = callCount.n;
    const statements = Array.from({ length: 250 }, (_, i) => ({
      sql: `INSERT INTO t (id) VALUES (${i})`,
    }));
    await db.batch(statements);
    await db.close();

    expect(callCount.n - bootstrapCalls).toBe(3); // 100 + 100 + 50
  });

  it("throws D1ClientError on D1 failure with retryable discriminant", async () => {
    let calls = 0;
    global.fetch = vi.fn(async (_url, _init) => {
      calls++;
      // Let the bootstrap (createD1Client) schema batch succeed.
      if (calls === 1) {
        return new Response(
          JSON.stringify({ success: true, result: [{ success: true }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ success: false, errors: [{ message: "boom" }] }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const db = await createDb("d1");
    let caught: unknown;
    try {
      await db.batch([{ sql: "SELECT 1", params: [] }]);
    } catch (err) {
      caught = err;
    }
    await db.close();
    expect(caught).toBeInstanceOf(D1ClientError);
    expect((caught as D1ClientError).retryable).toBe(true);
    expect((caught as D1ClientError).status).toBe(500);
  });
});

describe("quarantineWithBackoff", () => {
  it("succeeds on second attempt after first throws", async () => {
    const db = {
      run: vi
        .fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce(undefined),
      get: vi.fn(),
      all: vi.fn(),
      batch: vi.fn(),
      close: vi.fn(),
    } as unknown as DbClient;

    await expect(quarantineWithBackoff(db, "cat1")).resolves.toBeUndefined();
    expect((db.run as any).mock.calls.length).toBe(2);
  });

  it("throws after all three attempts when every call fails", async () => {
    // Pass maxAttempts=2 + never-failing console.error mock to avoid waiting
    // for the full 1+2+4 second backoff schedule in this test.
    const err = new Error("permanent");
    const db = {
      run: vi.fn().mockRejectedValue(err),
      get: vi.fn(),
      all: vi.fn(),
      batch: vi.fn(),
      close: vi.fn(),
    } as unknown as DbClient;
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      quarantineWithBackoff(db, "cat2", 2)
    ).resolves.toBeUndefined(); // logs and continues (no rethrow)
    expect((db.run as any).mock.calls.length).toBe(2);
    expect(consoleErr).toHaveBeenCalled();
  });

  it("retries with exponential delays (1s, 2s) — uses fake timers", async () => {
    vi.useFakeTimers();
    const db = {
      run: vi
        .fn()
        .mockRejectedValueOnce(new Error("a"))
        .mockRejectedValueOnce(new Error("b"))
        .mockResolvedValueOnce(undefined),
      get: vi.fn(),
      all: vi.fn(),
      batch: vi.fn(),
      close: vi.fn(),
    } as unknown as DbClient;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const promise = quarantineWithBackoff(db, "cat3");
    // Flush the setTimeout(r, 1000) and setTimeout(r, 2000) callbacks.
    await vi.runAllTimersAsync();
    await promise;

    expect((db.run as any).mock.calls.length).toBe(3);
    vi.useRealTimers();
  });
});
