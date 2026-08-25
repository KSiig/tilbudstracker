import type BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "..", "data", "tilbud.db");

const CLOUDFLARE_D1_QUERY_URL = (accountId: string, databaseId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

export type DbMode = "sqlite" | "d1";

export interface DbClient {
  run(sql: string, params?: any[]): Promise<void>;
  get<T>(sql: string, params?: any[]): Promise<T | undefined>;
  all<T>(sql: string, params?: any[]): Promise<T[]>;
  batch(statements: Array<{ sql: string; params?: any[] }>): Promise<void>;
  close(): Promise<void>;
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
    scrapedAt TEXT NOT NULL
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
    const res = await fetch(CLOUDFLARE_D1_QUERY_URL(this.accountId, this.databaseId), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await res.text();
    let body: {
      result: Array<{ results: any[]; success: boolean; meta: any }>;
      success: boolean;
      errors?: Array<{ message: string }>;
    };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`D1 query failed (${res.status}): ${text.slice(0, 500)}`);
    }

    if (!res.ok || !body.success) {
      throw new Error(
        `D1 query failed (${res.status}): ${JSON.stringify(body.errors ?? body)}`
      );
    }

    return body.result;
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
    if (statements.length === 0) return;
    const sql = statements.map((s) => s.sql.trim().replace(/;$/, "")).join(";\n");
    const params = statements.flatMap((s) => s.params ?? []);
    await this.execute(sql, params);
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
