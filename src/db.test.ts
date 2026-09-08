import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
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
    // Wrap `captured` in a mutable holder so TypeScript can narrow it after
    // the fetch callback runs (callback-assigned `let` values stay typed as
    // their original literal — `null` here — which would make `captured.init`
    // type as `never` under strict null checks).
    const captured: { value: { url: string; init: RequestInit } | null } = {
      value: null,
    };
    global.fetch = vi.fn(async (url, init) => {
      captured.value = { url: String(url), init: init as RequestInit };
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

    expect(captured.value).not.toBeNull();
    const body = JSON.parse(String(captured.value!.init.body));
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
    const calls: string[] = [];
    global.fetch = vi.fn(async (_url, init) => {
      let sql = "";
      try {
        const body = JSON.parse(String((init as RequestInit).body));
        sql = body.sql ?? body.batch?.[0]?.sql ?? "";
      } catch {
        /* ignore */
      }
      calls.push(sql);
      // Let the bootstrap path (schema batch, PRAGMA, ALTER TABLE, sqlite_master
      // reads done by ensureIndex) all succeed; only fail when the user's own
      // SQL arrives.
      if (
        sql.startsWith("PRAGMA") ||
        sql.startsWith("CREATE TABLE") ||
        sql.startsWith("ALTER TABLE") ||
        sql.startsWith("CREATE INDEX") ||
        sql.includes("FROM sqlite_master")
      ) {
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

describe("D1 column migrations (forward-compatible schema runner)", () => {
  const ORIGINAL_FETCH = global.fetch;
  const ORIGINAL_ENV = { ...process.env };

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

  // Wrap `rows` in the { results: [...] } envelope that D1Client.all() reads.
  const OK = (rows: any[] = [{ success: true }]) =>
    new Response(
      JSON.stringify({ success: true, result: [{ results: rows, success: true }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  it("does NOT run ALTER TABLE when catalogs.quarantined already exists", async () => {
    const sqlsSeen: string[] = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const sql: string = body.sql ?? body.batch?.[0]?.sql ?? "";
      sqlsSeen.push(sql);
      if (sql.startsWith("PRAGMA table_info(catalogs)")) {
        // Column already present → migration should be a no-op.
        return OK([{ name: "quarantined" }, { name: "scrapedAt" }]);
      }
      return OK();
    }) as unknown as typeof fetch;

    await createDb("d1");

    expect(sqlsSeen.some((s) => s.startsWith("PRAGMA table_info"))).toBe(true);
    expect(sqlsSeen.some((s) => s.startsWith("ALTER TABLE catalogs"))).toBe(
      false
    );
  });

  it("runs ALTER TABLE ADD COLUMN when catalogs.quarantined is missing", async () => {
    const sqlsSeen: string[] = [];
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const sql: string = body.sql ?? body.batch?.[0]?.sql ?? "";
      sqlsSeen.push(sql);
      if (sql.startsWith("PRAGMA table_info(catalogs)")) {
        // Column missing — migration should add it.
        return OK([{ name: "id" }, { name: "scrapedAt" }]);
      }
      return OK();
    }) as unknown as typeof fetch;

    await createDb("d1");

    const alter = sqlsSeen.find((s) => s.startsWith("ALTER TABLE catalogs"));
    expect(alter).toBeDefined();
    expect(alter).toMatch(/ADD COLUMN quarantined/);
    expect(alter).toMatch(/INTEGER NOT NULL DEFAULT 0/);
  });

  it("runs migrations after the schema batch (PRAGMA never precedes schema)", async () => {
    const callOrder: string[] = [];
    // Per-table mock: return the right "already present" columns so all
    // migrations become no-ops on this run. The point of this test is the
    // *order* (schema → pragma → optional alter), not which migrations fire.
    const existingColsByTable: Record<string, Array<{ name: string }>> = {
      catalogs: [{ name: "quarantined" }],
      offers: [
        { name: "normalized_id" },
        { name: "is_split" },
        { name: "bundle_ids" },
      ],
    };
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      if (body.batch) {
        callOrder.push("schema-batch");
      } else if (body.sql?.startsWith("PRAGMA")) {
        callOrder.push("pragma");
      } else if (body.sql?.startsWith("ALTER TABLE")) {
        callOrder.push("alter");
      }
      const pragmaMatch = body.sql?.match(/^PRAGMA table_info\((\w+)\)/);
      if (pragmaMatch) {
        return OK(existingColsByTable[pragmaMatch[1]] ?? []);
      }
      return OK();
    }) as unknown as typeof fetch;

    await createDb("d1");

    expect(callOrder[0]).toBe("schema-batch");
    expect(callOrder.slice(1)).toContain("pragma");
    expect(callOrder).not.toContain("alter");
  });
});

// ---------------------------------------------------------------------------
// SII-68 — M3 heading normalization schema (offers_normalized +
// offers.normalized_id / is_split / bundle_ids + index). Local sqlite path:
// createSqliteClient() must run runColumnMigrations() so existing DBs upgrade
// forward-compatibly. These tests cover a freshly-bootstrapped DB and the
// idempotent migration path against a "legacy" DB.
// ---------------------------------------------------------------------------
describe("SII-68 schema — local sqlite path", () => {
  const DB_DIR = path.resolve(process.cwd(), "data");
  const DB_FILE = path.join(DB_DIR, "tilbud.db");

  beforeEach(async () => {
    await fs.rm(DB_FILE, { force: true });
    await fs.mkdir(DB_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(DB_FILE, { force: true });
  });

  it("PRAGMA table_info(offers) includes normalized_id, is_split, bundle_ids", async () => {
    const db = await createDb("sqlite");
    const cols = await db.all<{ name: string }>(`PRAGMA table_info(offers)`);
    const names = cols.map((c) => c.name);
    expect(names).toContain("normalized_id");
    expect(names).toContain("is_split");
    expect(names).toContain("bundle_ids");
    await db.close();
  });

  it("PRAGMA table_info(offers_normalized) lists the 6 expected columns and types", async () => {
    const db = await createDb("sqlite");
    const cols = await db.all<{ name: string; type: string; notnull: number; pk: number }>(
      `PRAGMA table_info(offers_normalized)`
    );
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(cols.length).toBe(6);
    expect(byName.id?.type).toBe("INTEGER");
    expect(byName.id?.pk).toBe(1);
    expect(byName.title?.type).toBe("TEXT");
    expect(byName.title?.notnull).toBe(1);
    expect(byName.created_at?.type).toBe("TEXT");
    expect(byName.created_at?.notnull).toBe(1);
    expect(byName.created_by?.type).toBe("TEXT");
    expect(byName.created_by?.notnull).toBe(1);
    expect(byName.notes?.type).toBe("TEXT");
    expect(byName.superseded_by?.type).toBe("INTEGER");
    await db.close();
  });

  it("sqlite_master DDL for offers_normalized contains the created_by CHECK clause", async () => {
    const db = await createDb("sqlite");
    const row = await db.get<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE name = 'offers_normalized'`
    );
    expect(row?.sql).toBeDefined();
    expect(row!.sql).toMatch(
      /CHECK\s*\(\s*created_by\s+IN\s*\(\s*'system:regex'\s*,\s*'system:llm'\s*,\s*'user'\s*\)\s*\)/i
    );
    await db.close();
  });

  it("sqlite_master indexes include idx_offers_normalized_id on offers", async () => {
    const db = await createDb("sqlite");
    const rows = await db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='offers'`
    );
    const names = rows.map((r) => r.name);
    expect(names).toContain("idx_offers_normalized_id");
    await db.close();
  });

  it("runColumnMigrations() adds the three new columns to a legacy offers table (idempotent upgrade)", async () => {
    // Seed a "legacy" sqlite file: same schema as pre-SII-68 (no new columns
    // on offers, no offers_normalized table). Then run createDb("sqlite") —
    // runColumnMigrations() should ADD COLUMN for each new column and CREATE
    // TABLE IF NOT EXISTS for offers_normalized (via the schema bootstrap).
    const { default: Database } = await import("better-sqlite3");
    const legacy = new Database(DB_FILE);
    legacy.exec(`
      CREATE TABLE offers (
        id TEXT PRIMARY KEY,
        catalogId TEXT NOT NULL,
        storeId TEXT NOT NULL,
        heading TEXT NOT NULL,
        price REAL NOT NULL,
        validFrom TEXT NOT NULL,
        validUntil TEXT NOT NULL,
        scrapedAt TEXT NOT NULL
      );
    `);
    legacy.close();

    const db = await createDb("sqlite");
    const cols = await db.all<{ name: string }>(`PRAGMA table_info(offers)`);
    const names = cols.map((c) => c.name);
    expect(names).toContain("normalized_id");
    expect(names).toContain("is_split");
    expect(names).toContain("bundle_ids");

    // offers_normalized should also exist now.
    const tables = await db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='offers_normalized'`
    );
    expect(tables.length).toBe(1);
    await db.close();

    // Second invocation must be a no-op (idempotent).
    const db2 = await createDb("sqlite");
    const cols2 = await db2.all<{ name: string }>(`PRAGMA table_info(offers)`);
    expect(cols2.map((c) => c.name)).toEqual(expect.arrayContaining(names));
    await db2.close();
  });
});
