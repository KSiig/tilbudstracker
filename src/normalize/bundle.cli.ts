/**
 * Pass 1 — bundle detection CLI (`pnpm normalize:bundles`).
 *
 * Reads offers where `is_split = 0 AND normalized_id IS NULL`, detects bundle
 * headings via `isBundle(heading)`, and for each match:
 *
 *   1. INSERT N new `offers` rows (one per segment) via `db.batch`. Each
 *      per-product row inherits the bundle row's catalog/store/description/
 *      price/prePrice/currency/unitSymbol/siUnit/siFactor/validFrom/validUntil/
 *      imageUrl/scrapedAt verbatim. Size/piece/unit-price fields are NULL
 *      (cannot be derived from the bundle). `normalized_id` is NULL (Pass 2
 *      will assign).
 *   2. UPDATE the original bundle row: `is_split = 1`,
 *      `bundle_ids = JSON.stringify(newIds)`.
 *
 * Idempotent: the `WHERE is_split = 0 AND normalized_id IS NULL` filter means
 * a second invocation is a no-op.
 *
 * Order dependency: this CLI must run BEFORE Pass 2 (SII-69) so per-product
 * rows are eligible for the trivial fold. The handler integration (SII-71)
 * is the deployment boundary that enforces this.
 */

import { randomUUID } from "node:crypto";
import { createDb, type DbClient } from "../db.js";
import { isBundle, parseBundle } from "./bundle.js";

interface BundleOffer {
  id: string;
  catalogId: string;
  storeId: string;
  heading: string;
  description: string | null;
  price: number;
  prePrice: number | null;
  currency: string;
  unitSymbol: string | null;
  siUnit: string | null;
  siFactor: number | null;
  validFrom: string;
  validUntil: string;
  imageUrl: string | null;
  scrapedAt: string;
}

export interface NormalizeBundlesResult {
  bundlesDetected: number;
  newOffersCreated: number;
}

const SQL_SELECT_BUNDLE_CANDIDATES = `
  SELECT id, catalogId, storeId, heading, description, price, prePrice,
         currency, unitSymbol, siUnit, siFactor, validFrom, validUntil,
         imageUrl, scrapedAt
  FROM offers
  WHERE is_split = 0
    AND normalized_id IS NULL
`;

const INSERT_PER_PRODUCT_SQL = `
  INSERT OR IGNORE INTO offers (
    id, catalogId, storeId, heading, description,
    price, prePrice, currency,
    unitSymbol, siUnit, siFactor,
    sizeFrom, sizeTo, piecesFrom, piecesTo,
    computedUnitPrice, unitPriceKind,
    normalizedUnitPrice, normalizedAt, normalizationNote,
    validFrom, validUntil, imageUrl, scrapedAt,
    normalized_id, is_split, bundle_ids,
    bundle_split_id, position
  ) VALUES (
    ?, ?, ?, ?, ?,
    ?, ?, ?,
    ?, ?, ?,
    NULL, NULL, NULL, NULL,
    NULL, NULL,
    NULL, NULL, NULL,
    ?, ?, ?, ?,
    NULL, 0, NULL,
    ?, ?
  )
`;

const MARK_BUNDLE_SQL = `
  UPDATE offers
  SET is_split = 1, bundle_ids = ?
  WHERE id = ? AND is_split = 0
`;

/**
 * Run Pass 1 against `db`. Exported for the handler integration (SII-71);
 * the CLI entrypoint below is a thin wrapper that opens `createDb()` and
 * prints the summary.
 */
export async function normalizeBundles(
  db: DbClient
): Promise<NormalizeBundlesResult> {
  const candidates = await db.all<BundleOffer>(SQL_SELECT_BUNDLE_CANDIDATES);

  let bundlesDetected = 0;
  let newOffersCreated = 0;

  // Per-bundle atomic batches: each bundle's per-product INSERTs and the
  // original-row UPDATE go in their own db.batch([...]) call. On SQLite this
  // is a real transaction (all-or-nothing); on D1 the REST batch endpoint is
  // not transactional, so the idempotency columns + INSERT OR IGNORE below
  // make a retry safe even if a previous attempt partially committed.
  for (const offer of candidates) {
    if (!isBundle(offer.heading)) continue;

    let segments: string[];
    try {
      segments = parseBundle(offer.heading);
    } catch {
      // BundleParseError — segment without a unit token. isBundle already
      // returned true based on the whole-heading unit-token check, but
      // parseBundle now rejects the heading. Skip the bundle entirely.
      continue;
    }
    if (segments.length < 2) continue;

    const newIds: string[] = segments.map(() => randomUUID());
    bundlesDetected += 1;

    const statements: Array<{ sql: string; params: any[] }> = [];
    for (let i = 0; i < segments.length; i++) {
      statements.push({
        sql: INSERT_PER_PRODUCT_SQL,
        params: [
          newIds[i],
          offer.catalogId,
          offer.storeId,
          segments[i],
          offer.description,
          offer.price,
          offer.prePrice,
          offer.currency,
          offer.unitSymbol,
          offer.siUnit,
          offer.siFactor,
          offer.validFrom,
          offer.validUntil,
          offer.imageUrl,
          offer.scrapedAt,
          // Idempotency key: (bundle_split_id, position) is unique for
          // per-product rows. Re-running this CLI generates a fresh
          // randomUUID() for `newIds[i]`, but `INSERT OR IGNORE` plus the
          // partial unique index `idx_offers_bundle_split_pos` skips any
          // duplicate (bundle_split_id, position) pair from a prior
          // partial commit. The MARK_BUNDLE_SQL `WHERE id = ? AND is_split
          // = 0` guard makes the UPDATE itself idempotent.
          offer.id,
          i,
        ],
      });
    }

    statements.push({
      sql: MARK_BUNDLE_SQL,
      params: [JSON.stringify(newIds), offer.id],
    });

    await db.batch(statements);
    newOffersCreated += segments.length;
  }

  return { bundlesDetected, newOffersCreated };
}

// CLI entrypoint — invoked by `pnpm normalize:bundles`. Guarded so importing
// this module from tests does not open a real database.
const isMainModule = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const db = await createDb();
  try {
    const result = await normalizeBundles(db);
    console.log(JSON.stringify(result));
  } finally {
    await db.close();
  }
}
