import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, type DbClient } from "../db.js";
import { normalizeBundles } from "./bundle.cli.js";

// Per-suite temp sqlite path so we don't race db.test.ts on data/tilbud.db.
const TEMP_DIR = mkdtempSync(path.join(os.tmpdir(), "tilbud-bundle-test-"));
const DB_FILE = path.join(TEMP_DIR, "tilbud.db");

async function seedBundleCandidate(
  db: DbClient,
  id: string,
  heading: string,
): Promise<void> {
  // One shared catalog + store + offers row. The CLI runs `WHERE is_split = 0
  // AND normalized_id IS NULL` to find candidates, so any non-bundle row is
  // eligible until the CLI marks it.
  const now = new Date().toISOString();
  await db.run(
    `INSERT OR IGNORE INTO stores (id, name, firstSeenAt) VALUES ('store-1', 'Netto', ?)`,
    [now]
  );
  await db.run(
    `INSERT OR IGNORE INTO catalogs (id, storeId, validFrom, validUntil, scrapedAt)
     VALUES ('cat-1', 'store-1', '2026-01-01', '2026-01-08', ?)`,
    [now]
  );
  await db.run(
    `INSERT OR IGNORE INTO offers
       (id, catalogId, storeId, heading, price, validFrom, validUntil, scrapedAt,
        is_split, normalized_id)
     VALUES (?, 'cat-1', 'store-1', ?, 9.95, '2026-01-01', '2026-01-08', ?, 0, NULL)`,
    [id, heading, now]
  );
}

describe("normalizeBundles (end-to-end against sqlite)", () => {
  beforeEach(async () => {
    process.env.TILBUD_DB_PATH = DB_FILE;
    await fs.rm(DB_FILE, { force: true });
    await fs.rm(`${DB_FILE}-wal`, { force: true });
    await fs.rm(`${DB_FILE}-shm`, { force: true });
  });

  afterEach(async () => {
    delete process.env.TILBUD_DB_PATH;
    await fs.rm(DB_FILE, { force: true });
    await fs.rm(`${DB_FILE}-wal`, { force: true });
    await fs.rm(`${DB_FILE}-shm`, { force: true });
  });

  afterAll(async () => {
    await fs.rm(TEMP_DIR, { recursive: true, force: true });
  });

  it("splits a valid bundle into 3 per-product rows and marks the original", async () => {
    const db = await createDb("sqlite");
    await seedBundleCandidate(
      db,
      "bundle-1",
      "1,2 kg Hakket Dansk Grise- og Kalvekød 8-12 %, 900-1200 g Hamburgerryg af Dansk Gris eller 1,8 kg Rose Dansk Hel Kylling",
    );

    const result = await normalizeBundles(db);
    expect(result.bundlesDetected).toBe(1);
    expect(result.newOffersCreated).toBe(3);

    const original = await db.get<{ is_split: number; bundle_ids: string | null }>(
      `SELECT is_split, bundle_ids FROM offers WHERE id = 'bundle-1'`
    );
    expect(original?.is_split).toBe(1);
    const ids = JSON.parse(original!.bundle_ids!) as string[];
    expect(ids).toHaveLength(3);

    const perProduct = await db.all<{
      id: string;
      is_split: number;
      bundle_split_id: string | null;
      position: number | null;
    }>(
      `SELECT id, is_split, bundle_split_id, position FROM offers
       WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY position`,
      ids
    );
    expect(perProduct).toHaveLength(3);
    for (const row of perProduct) {
      expect(row.is_split).toBe(0);
      expect(row.bundle_split_id).toBe("bundle-1");
      expect(row.position).toBeGreaterThanOrEqual(0);
    }

    await db.close();
  });

  it("rejects a bundle where a segment lacks a unit token (finding #4)", async () => {
    const db = await createDb("sqlite");
    await seedBundleCandidate(
      db,
      "bundle-bad",
      "Hakket Dansk Grise- og Kalvekød 8-12 %, 900-1200 g Hamburgerryg af Dansk Gris eller 1,8 kg Rose Dansk Hel Kylling",
    );

    const result = await normalizeBundles(db);
    // The whole-heading `isBundle` check rejects this (per segment requires
    // a unit) → CLI does nothing.
    expect(result.bundlesDetected).toBe(0);
    expect(result.newOffersCreated).toBe(0);

    const original = await db.get<{ is_split: number; bundle_ids: string | null }>(
      `SELECT is_split, bundle_ids FROM offers WHERE id = 'bundle-bad'`
    );
    expect(original?.is_split).toBe(0);
    expect(original?.bundle_ids).toBeNull();

    await db.close();
  });

  it("is idempotent: a second run produces no new rows (finding #3)", async () => {
    const db = await createDb("sqlite");
    await seedBundleCandidate(
      db,
      "bundle-1",
      "1,2 kg Hakket Dansk Grise- og Kalvekød 8-12 %, 900-1200 g Hamburgerryg af Dansk Gris eller 1,8 kg Rose Dansk Hel Kylling",
    );

    const first = await normalizeBundles(db);
    expect(first.bundlesDetected).toBe(1);
    expect(first.newOffersCreated).toBe(3);

    // Second invocation: SELECT returns 0 candidates (is_split = 1 already).
    const second = await normalizeBundles(db);
    expect(second).toEqual({ bundlesDetected: 0, newOffersCreated: 0 });

    // No duplicate per-product rows.
    const totalPerProduct = await db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM offers WHERE bundle_split_id = 'bundle-1'`
    );
    expect(totalPerProduct?.c).toBe(3);

    await db.close();
  });

  it("retry of a partially-committed split is a no-op via INSERT OR IGNORE + WHERE is_split = 0", async () => {
    // Simulate the partial-failure case: the original is still is_split = 0
    // (the UPDATE never landed), but the per-product rows from a previous
    // run are present. The CLI must (a) not create a second set of per-product
    // rows and (b) still UPDATE the original to is_split = 1.
    const db = await createDb("sqlite");
    await seedBundleCandidate(
      db,
      "bundle-1",
      "1,2 kg Hakket Dansk Grise- og Kalvekød 8-12 %, 900-1200 g Hamburgerryg af Dansk Gris eller 1,8 kg Rose Dansk Hel Kylling",
    );
    // Pre-seed per-product rows mimicking a previous partial commit. Use the
    // same (bundle_split_id, position) pairs the CLI would generate.
    const now = new Date().toISOString();
    for (let i = 0; i < 3; i++) {
      await db.run(
        `INSERT INTO offers
           (id, catalogId, storeId, heading, price, validFrom, validUntil, scrapedAt,
            is_split, normalized_id, bundle_split_id, position)
         VALUES (?, 'cat-1', 'store-1', ?, 9.95, '2026-01-01', '2026-01-08', ?,
                 0, NULL, 'bundle-1', ?)`,
        [`pre-${i}`, `1,2 kg pre-existing segment ${i}`, now, i]
      );
    }

    const result = await normalizeBundles(db);
    expect(result.bundlesDetected).toBe(1);
    // bundlesDetected counts detected bundles (still 1); newOffersCreated
    // counts attempted INSERTs, but INSERT OR IGNORE skips conflicts → 0 new
    // rows are actually added.
    expect(result.newOffersCreated).toBe(3);

    // The 3 pre-existing rows are still the only per-product rows.
    const totalPerProduct = await db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM offers WHERE bundle_split_id = 'bundle-1'`
    );
    expect(totalPerProduct?.c).toBe(3);

    // Original is now correctly marked.
    const original = await db.get<{ is_split: number }>(
      `SELECT is_split FROM offers WHERE id = 'bundle-1'`
    );
    expect(original?.is_split).toBe(1);

    await db.close();
  });
});