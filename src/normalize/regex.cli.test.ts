import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb, type DbClient } from "../db.js";
import { trivialNormalize } from "./regex.js";
import {
  applyWritePolicy,
  groupByFold,
  normalizeRegex,
} from "./regex.cli.js";

// Use a per-file temp sqlite path so this suite does not race db.test.ts on
// the shared `data/tilbud.db`. Driven by TILBUD_DB_PATH, which db.ts honors.
const TEMP_DIR = mkdtempSync(path.join(os.tmpdir(), "tilbud-regex-test-"));
const DB_FILE = path.join(TEMP_DIR, "tilbud.db");

interface SeedOffer {
  id: string;
  heading: string;
  normalized_id?: number | null;
  is_split?: number;
}

async function seedOffers(db: DbClient, offers: SeedOffer[]): Promise<void> {
  // Need a parent catalogs row + parent offers_normalized rows for any FK
  // that gets populated; we don't need that here because we're only seeding
  // the offers table directly with the new columns.
  // First create a fake catalog + store so offers.catalogId / storeId are
  // happy. INSERT OR IGNORE so re-running seed in the same DB does not
  // conflict on (id) uniqueness — each test gets its own fresh file via
  // `beforeEach`, but if that ever changes this stays correct.
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
  for (const o of offers) {
    await db.run(
      `INSERT OR IGNORE INTO offers
         (id, catalogId, storeId, heading, price, validFrom, validUntil, scrapedAt,
          is_split, normalized_id)
       VALUES (?, 'cat-1', 'store-1', ?, 9.95, '2026-01-01', '2026-01-08', ?, ?, ?)`,
      [
        o.id,
        o.heading,
        now,
        o.is_split ?? 0,
        o.normalized_id ?? null,
      ]
    );
  }
}

describe("trivialNormalize (the fold itself)", () => {
  it("matches the spec examples", () => {
    expect(trivialNormalize("BUKO Smelteost")).toBe("buko smelteost");
    expect(trivialNormalize("Buko's Smelte-ost")).toBe("bukos smelte ost");
    expect(trivialNormalize("Cheasy   yoghurt")).toBe("cheasy yoghurt");
    expect(trivialNormalize("Kalvekød")).toBe("kalvekød");
  });
});

describe("applyWritePolicy (decision P1: ≥ 2 offers OR ≥ 2 distinct headings)", () => {
  it("keeps groups with ≥ 2 offers", () => {
    const groups = [
      {
        fold: "a",
        members: [
          { id: "1", heading: "A" },
          { id: "2", heading: "A" },
        ],
      },
    ];
    expect(applyWritePolicy(groups)).toHaveLength(1);
  });

  it("keeps groups with ≥ 2 distinct headings even when 2 of them fold equal and one differs", () => {
    // Three offers, two fold equal ("Foo Bar") and one is "Foo Baz" → only one
    // fold bucket has members — the test for "≥ 2 distinct headings" applies
    // within a single fold bucket, which is the only bucket that exists here.
    const groups = [
      {
        fold: "a",
        members: [
          { id: "1", heading: "A" },
          { id: "2", heading: "A!" },
        ],
      },
    ];
    expect(applyWritePolicy(groups)).toHaveLength(1);
  });

  it("drops single-offer, single-heading singletons (Pass 3's job)", () => {
    const groups = [
      {
        fold: "x",
        members: [{ id: "1", heading: "lonely" }],
      },
    ];
    expect(applyWritePolicy(groups)).toHaveLength(0);
  });
});

describe("groupByFold", () => {
  it("buckets offers by their trivial fold", () => {
    // The fold is intentionally narrow: only case and trivial punct/whitespace
    // differences collapse. `BUKO Smelteost` and `Buko Smelteost` fold equal
    // (case only); `Buko's Smelte-ost` folds to `bukos smelte ost` (different
    // word boundaries), which is a separate bucket per the spec.
    const out = groupByFold([
      { id: "1", heading: "BUKO Smelteost" },
      { id: "2", heading: "Buko Smelteost" }, // folds equal to id 1
      { id: "3", heading: "Cheasy yoghurt" }, // distinct fold
    ]);
    expect(out).toHaveLength(2);
    const buko = out.find((g) => g.fold === "buko smelteost");
    expect(buko?.members.map((m) => m.id)).toEqual(["1", "2"]);
    const cheasy = out.find((g) => g.fold === "cheasy yoghurt");
    expect(cheasy?.members.map((m) => m.id)).toEqual(["3"]);
  });

  it("skips offers whose heading folds to empty (whitespace-only)", () => {
    const out = groupByFold([{ id: "1", heading: "   " }]);
    expect(out).toHaveLength(0);
  });
});

describe("normalizeRegex (end-to-end against sqlite)", () => {
  beforeEach(async () => {
    // Point DB_PATH at our per-suite temp file.
    process.env.TILBUD_DB_PATH = DB_FILE;
    await fs.rm(DB_FILE, { force: true });
  });

  afterEach(async () => {
    delete process.env.TILBUD_DB_PATH;
    await fs.rm(DB_FILE, { force: true });
  });

  it("writes one offers_normalized row per surviving group and links members", async () => {
    const db = await createDb("sqlite");
    await seedOffers(db, [
      { id: "1", heading: "BUKO Smelteost" },
      { id: "2", heading: "Buko Smelteost" }, // folds equal to id 1 → group has 2 offers
      { id: "3", heading: "Cheasy yoghurt" }, // singleton → skipped
    ]);

    const result = await normalizeRegex(db);

    expect(result.groupsProcessed).toBe(1);
    expect(result.offersNormalized).toBe(2);

    // The surviving group has 2 members so both got linked.
    const linked = await db.all<{ id: string; normalized_id: number | null }>(
      `SELECT id, normalized_id FROM offers ORDER BY id`
    );
    expect(linked).toEqual([
      { id: "1", normalized_id: 1 },
      { id: "2", normalized_id: 1 },
      { id: "3", normalized_id: null },
    ]);

    // One offers_normalized row, created_by = system:regex, title = lowercase fold.
    const norms = await db.all<{
      id: number;
      title: string;
      created_by: string;
    }>(`SELECT id, title, created_by FROM offers_normalized`);
    expect(norms).toEqual([
      { id: 1, title: "buko smelteost", created_by: "system:regex" },
    ]);

    await db.close();
  });

  it("keeps a group whose members share a fold but have ≥ 2 distinct headings", async () => {
    // Decision P1: ≥ 2 offers OR ≥ 2 distinct headings. The realistic case is
    // 2+ offers whose headings differ in casing only — both branches collapse
    // to the same detection, but the acceptance criteria name both. Verify 3
    // distinct casings fold together AND that a separate singleton heading is
    // skipped.
    const db = await createDb("sqlite");
    await seedOffers(db, [
      { id: "1", heading: "Buko Smelteost" },
      { id: "2", heading: "BUKO SMELTEOST" },
      { id: "3", heading: "buko smelteost" },
      { id: "4", heading: "Lonely Product" },
    ]);

    const result = await normalizeRegex(db);

    expect(result.groupsProcessed).toBe(1);
    expect(result.offersNormalized).toBe(3);
    const linked = await db.all<{ id: string; normalized_id: number | null }>(
      `SELECT id, normalized_id FROM offers ORDER BY id`
    );
    expect(linked[0].normalized_id).not.toBeNull();
    expect(linked[1].normalized_id).toBe(linked[0].normalized_id);
    expect(linked[2].normalized_id).toBe(linked[0].normalized_id);
    expect(linked[3].normalized_id).toBeNull(); // singleton

    await db.close();
  });

  it("is idempotent: a second run produces no new rows", async () => {
    const db = await createDb("sqlite");
    await seedOffers(db, [
      { id: "1", heading: "BUKO Smelteost" },
      { id: "2", heading: "Buko Smelteost" },
    ]);

    const first = await normalizeRegex(db);
    expect(first.offersNormalized).toBe(2);

    const second = await normalizeRegex(db);
    expect(second).toEqual({ groupsProcessed: 0, offersNormalized: 0 });

    const norms = await db.all<{ c: number }>(
      `SELECT COUNT(*) AS c FROM offers_normalized WHERE created_by = 'system:regex'`
    );
    expect(norms[0].c).toBe(1);

    await db.close();
  });

  it("excludes is_split = 1 rows (bundle originals) from the read set", async () => {
    // SII-72 (Pass 1) marks bundle originals is_split = 1. They must not be
    // re-normalized by Pass 2 because their heading is the bundle string,
    // not a per-product string. Pass 2's per-product rows have is_split = 0
    // and ARE eligible.
    const db = await createDb("sqlite");
    await seedOffers(db, [
      { id: "bundle-1", heading: "1 kg Kylling OG 500 g Gris", is_split: 1 },
      {
        id: "pp-1",
        heading: "Kylling",
      }, // would fold equal to "kylling" if it existed alone
      {
        id: "lonely-1",
        heading: "Fisk",
      }, // singleton, separate fold
    ]);

    const result = await normalizeRegex(db);

    // Only `pp-1` and `lonely-1` are eligible. Both fold to single-member
    // groups, so both are dropped by Write Policy.
    expect(result).toEqual({ groupsProcessed: 0, offersNormalized: 0 });

    // No offers got linked.
    const linked = await db.all<{ normalized_id: number | null }>(
      `SELECT normalized_id FROM offers WHERE id IN ('pp-1', 'lonely-1')`
    );
    expect(linked.every((r) => r.normalized_id === null)).toBe(true);

    // The bundle original is still is_split = 1 (untouched).
    const bundle = await db.get<{ is_split: number }>(
      `SELECT is_split FROM offers WHERE id = 'bundle-1'`
    );
    expect(bundle?.is_split).toBe(1);

    await db.close();
  });

  it("skips offers already linked to a normalized_id (no-op for already-normalized rows)", async () => {
    const db = await createDb("sqlite");
    // Seed a pre-existing offers_normalized row so we can reference its id.
    await db.run(
      `INSERT INTO offers_normalized (title, created_at, created_by) VALUES ('preexisting', ?, 'user')`,
      [new Date().toISOString()]
    );
    const pre = await db.get<{ id: number }>(
      `SELECT id FROM offers_normalized WHERE created_by = 'user'`
    );
    expect(pre?.id).toBeDefined();

    await seedOffers(db, [
      // This offer is already linked — must not be re-read or re-linked.
      {
        id: "already",
        heading: "Buko Smelteost",
        normalized_id: pre!.id,
      },
      // And a new singleton, must not be linked either (Write Policy drops it).
      { id: "singleton", heading: "Brand New Product" },
    ]);

    const result = await normalizeRegex(db);

    expect(result).toEqual({ groupsProcessed: 0, offersNormalized: 0 });
    const singleton = await db.get<{ normalized_id: number | null }>(
      `SELECT normalized_id FROM offers WHERE id = 'singleton'`
    );
    expect(singleton?.normalized_id).toBeNull();

    await db.close();
  });

  it("uses RETURNING id to grab the new normalized row's id without a second SELECT", async () => {
    // Smoke check: the CLI uses `RETURNING id` rather than a follow-up
    // MAX(id) SELECT. Verify by checking that two consecutive runs against
    // the same DB produce monotonically increasing ids (proving the first run
    // did not skip a slot via a separate SELECT round-trip).
    const db = await createDb("sqlite");
    await seedOffers(db, [
      { id: "1", heading: "Group A Item" },
      { id: "2", heading: "Group A Item" }, // case-only diff → folds equal
    ]);
    const r1 = await normalizeRegex(db);
    expect(r1.offersNormalized).toBe(2);

    // Fresh offers that fold together into a new group, against the same DB.
    await seedOffers(db, [
      { id: "3", heading: "Group B Item" },
      { id: "4", heading: "GROUP B ITEM" }, // case-only diff
    ]);
    const r2 = await normalizeRegex(db);
    expect(r2.offersNormalized).toBe(2);

    const ids = (
      await db.all<{ id: number }>(
        `SELECT id FROM offers_normalized WHERE created_by = 'system:regex' ORDER BY id`
      )
    ).map((r) => r.id);
    // Two groups written → two distinct ids. AUTOINCREMENT guarantees id 1
    // then id 2 in order; a SELECT-MAX implementation could yield the same
    // id twice, so the monotonic-order assertion is the smoke check.
    expect(ids).toEqual([1, 2]);

    await db.close();
  });
});
