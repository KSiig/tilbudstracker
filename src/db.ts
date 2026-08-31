import type BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "..", "data", "tilbud.db");

const CLOUDFLARE_D1_QUERY_URL = (accountId: string, databaseId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

/** Maximum statements per D1 REST batch call. Decision E2. */
export const D1_BATCH_CHUNK_SIZE = 100;

/** AbortSignal timeout for single D1 execute() (decision: keep 30s). */
const D1_EXECUTE_TIMEOUT_MS = 30_000;

/** AbortSignal timeout for D1 batch() (decision E3: 120s). */
const D1_BATCH_TIMEOUT_MS = 120_000;

export type DbMode = "sqlite" | "d1";

export interface DbClient {
  run(sql: string, params?: any[]): Promise<void>;
  get<T>(sql: string, params?: any[]): Promise<T | undefined>;
  all<T>(sql: string, params?: any[]): Promise<T[]>;
  batch(statements: Array<{ sql: string; params?: any[] }>): Promise<void>;
  close(): Promise<void>;
}

/**
 * Typed error for D1 client failures. The `retryable` discriminant lets callers
 * (e.g. the Cloud Function handler in SII-15) decide whether to retry without
 * parsing error messages.
 */
export class D1ClientError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "D1ClientError";
  }
}

/**
 * Soft-delete a catalog row by setting `quarantined = 1`. Retries up to
 * `maxAttempts` times with exponential backoff (1s, 2s, 4s, ...). Decision E4.
 *
 * If all attempts fail, the orphan is logged to console and the function
 * resolves normally (no rethrow) so the scrape loop can continue. Manual
 * cleanup later.
 */
export async function quarantineWithBackoff(
  db: DbClient,
  id: string,
  maxAttempts = 3
): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await db.run("UPDATE catalogs SET quarantined = 1 WHERE id = ?", [id]);
      return;
    } catch (err) {
      lastErr = err;
      if (i === maxAttempts - 1) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  console.error(
    `[quarantineWithBackoff] Failed to quarantine catalog ${id} after ${maxAttempts} attempts. Orphan left in D1.`,
    lastErr
  );
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS stores (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT,
    category TEXT,
    website TEXT,
    color TEXT,
    logoUrl TEXT,
    isTracked INTEGER NOT NULL DEFAULT 0,
    firstSeenAt TEXT NOT NULL,
    lastScrapedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS catalogs (
    id TEXT PRIMARY KEY,
    storeId TEXT NOT NULL REFERENCES stores(id),
    label TEXT,
    offerCount INTEGER,
    pageCount INTEGER,
    publishedAt TEXT,
    validFrom TEXT NOT NULL,
    validUntil TEXT NOT NULL,
    scrapedAt TEXT NOT NULL,
    quarantined INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS offers (
    id TEXT PRIMARY KEY,
    catalogId TEXT NOT NULL REFERENCES catalogs(id),
    storeId TEXT NOT NULL REFERENCES stores(id),
    heading TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    prePrice REAL,
    currency TEXT NOT NULL DEFAULT 'DKK',
    unitSymbol TEXT,
    siUnit TEXT,
    siFactor REAL,
    sizeFrom REAL,
    sizeTo REAL,
    piecesFrom INTEGER,
    piecesTo INTEGER,
    computedUnitPrice REAL,
    unitPriceKind TEXT,
    normalizedUnitPrice REAL,
    normalizedAt TEXT,
    normalizationNote TEXT,
    validFrom TEXT NOT NULL,
    validUntil TEXT NOT NULL,
    imageUrl TEXT,
    scrapedAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_offers_store_valid ON offers(storeId, validFrom);
  CREATE INDEX IF NOT EXISTS idx_offers_heading ON offers(heading);
  CREATE INDEX IF NOT EXISTS idx_offers_catalog ON offers(catalogId);
  CREATE INDEX IF NOT EXISTS idx_catalogs_store ON catalogs(storeId);
`;

class SqliteClient implements DbClient {
  constructor(private readonly db: BetterSqlite3.Database) {}

  async run(sql: string, params: any[] = []): Promise<void> {
    this.db.prepare(sql).run(...params);
  }

  async get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async all<T>(sql: string, params: any[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async batch(statements: Array<{ sql: string; params?: any[] }>): Promise<void> {
    const runAll = this.db.transaction((stmts: Array<{ sql: string; params?: any[] }>) => {
      for (const { sql, params = [] } of stmts) {
        this.db.prepare(sql).run(...params);
      }
    });
    runAll(statements);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

class D1Client implements DbClient {
  constructor(
    private readonly accountId: string,
    private readonly databaseId: string,
    private readonly apiToken: string
  ) {}

  private async execute(
    sql: string,
    params: any[] = []
  ): Promise<Array<{ results: any[]; success: boolean; meta: any }>> {
    let res: Response;
    try {
      res = await fetch(CLOUDFLARE_D1_QUERY_URL(this.accountId, this.databaseId), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql, params }),
        signal: AbortSignal.timeout(D1_EXECUTE_TIMEOUT_MS),
      });
    } catch (err) {
      // Network errors and aborts are retryable.
      throw new D1ClientError(
        `D1 execute network error: ${(err as Error).message}`,
        true,
        undefined,
        err
      );
    }

    const text = await res.text();
    let body: {
      result: Array<{ results: any[]; success: boolean; meta: any }>;
      success: boolean;
      errors?: Array<{ message: string }>;
    };
    try {
      body = JSON.parse(text);
    } catch {
      throw new D1ClientError(
        `D1 query failed (${res.status}): ${text.slice(0, 500)}`,
        res.status >= 500 || res.status === 408 || res.status === 429,
        res.status
      );
    }

    if (!res.ok || !body.success) {
      throw new D1ClientError(
        `D1 query failed (${res.status}): ${JSON.stringify(body.errors ?? body)}`,
        res.status >= 500 || res.status === 408 || res.status === 429,
        res.status
      );
    }

    return body.result;
  }

  /**
   * POST a batch of statements using the Cloudflare `{ batch: [...] }` shape.
   * Throws `D1ClientError` on failure. Network/5xx/408/429 are marked retryable.
   */
  private async executeBatch(
    statements: Array<{ sql: string; params?: any[] }>
  ): Promise<void> {
    if (statements.length === 0) return;
    const body = JSON.stringify({
      batch: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })),
    });
    let res: Response;
    try {
      res = await fetch(CLOUDFLARE_D1_QUERY_URL(this.accountId, this.databaseId), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(D1_BATCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new D1ClientError(
        `D1 batch network error: ${(err as Error).message}`,
        true,
        undefined,
        err
      );
    }

    const text = await res.text();
    let parsed: {
      success: boolean;
      result?: Array<{ success: boolean }>;
      errors?: Array<{ message: string }>;
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new D1ClientError(
        `D1 batch failed (${res.status}): ${text.slice(0, 500)}`,
        res.status >= 500 || res.status === 408 || res.status === 429,
        res.status
      );
    }

    if (!res.ok || !parsed.success) {
      throw new D1ClientError(
        `D1 batch failed (${res.status}): ${JSON.stringify(parsed.errors ?? parsed)}`,
        res.status >= 500 || res.status === 408 || res.status === 429,
        res.status
      );
    }
  }

  async run(sql: string, params: any[] = []): Promise<void> {
    await this.execute(sql, params);
  }

  async get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
    const [first] = await this.execute(sql, params);
    return first?.results?.[0] as T | undefined;
  }

  async all<T>(sql: string, params: any[] = []): Promise<T[]> {
    const [first] = await this.execute(sql, params);
    return (first?.results ?? []) as T[];
  }

  async batch(statements: Array<{ sql: string; params?: any[] }>): Promise<void> {
    // D1 REST `/query` accepts the `{ batch: [...] }` shape; chunk it to
    // D1_BATCH_CHUNK_SIZE (decision E2) so a single offer catalog with many
    // offers can fit.
    for (let i = 0; i < statements.length; i += D1_BATCH_CHUNK_SIZE) {
      const chunk = statements.slice(i, i + D1_BATCH_CHUNK_SIZE);
      await this.executeBatch(chunk);
    }
  }

  async close(): Promise<void> {
    // Nothing to close for a stateless REST client.
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function createSqliteClient(): Promise<DbClient> {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return new SqliteClient(db);
}

function schemaStatements(): Array<{ sql: string }> {
  return SCHEMA_SQL.split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((sql) => ({ sql }));
}

async function createD1Client(): Promise<DbClient> {
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const databaseId = requireEnv("CLOUDFLARE_D1_DATABASE_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const client = new D1Client(accountId, databaseId, apiToken);
  await client.batch(schemaStatements());
  return client;
}

export async function createDb(mode?: DbMode): Promise<DbClient> {
  const envMode = process.env.DB_MODE;
  if (envMode && envMode !== "sqlite" && envMode !== "d1") {
    throw new Error(`Invalid DB_MODE: ${envMode}. Expected "sqlite" or "d1".`);
  }
  const resolvedMode: DbMode = mode ?? (envMode as DbMode | undefined) ?? "sqlite";

  if (resolvedMode === "d1") {
    return createD1Client();
  }

  return createSqliteClient();
}
