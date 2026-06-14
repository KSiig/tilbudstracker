import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "..", "data", "tilbud.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
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
  `);
}
