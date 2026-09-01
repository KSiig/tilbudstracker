import type { DbClient } from "./db.js";
import { D1_BATCH_CHUNK_SIZE, quarantineWithBackoff } from "./db.js";
import {
  fetchDealers,
  fetchCatalogs,
  fetchAllOffers,
  TjekRateLimitError,
} from "./api.js";
import { computeUnitPrice } from "./unit-price.js";
import type { ApiDealer, ApiCatalog, ApiOffer } from "./types.js";

export { TjekRateLimitError };

export async function scrape(
  db: DbClient
): Promise<{ newCatalogs: number; newOffers: number; tracked: number }> {
  const now = new Date().toISOString();

  const storeStats = await syncStores(db, now);
  console.log(
    `Stores: ${storeStats.total} total, ${storeStats.new} new, ${storeStats.tracked} tracked`
  );

  if (storeStats.tracked === 0) {
    console.log(
      "No stores are tracked. Use `pnpm track <storeId>` to enable tracking."
    );
    return { newCatalogs: 0, newOffers: 0, tracked: 0 };
  }

  const trackedStores = await db.all<{ id: string; name: string }>(
    "SELECT id, name FROM stores WHERE isTracked = 1"
  );

  let totalNewCatalogs = 0;
  let totalNewOffers = 0;

  for (const store of trackedStores) {
    const result = await scrapeStore(db, store.id, store.name, now);
    totalNewCatalogs += result.newCatalogs;
    totalNewOffers += result.newOffers;
  }

  console.log(
    `Done: ${totalNewCatalogs} new catalogs, ${totalNewOffers} new offers`
  );

  return {
    newCatalogs: totalNewCatalogs,
    newOffers: totalNewOffers,
    tracked: trackedStores.length,
  };
}

async function syncStores(
  db: DbClient,
  now: string
): Promise<{ total: number; new: number; tracked: number }> {
  const dealers = await fetchDealers();
  let newCount = 0;

  const existing = new Set(
    (await db.all<{ id: string }>("SELECT id FROM stores")).map((r) => r.id)
  );

  const upsertSql = `
    INSERT INTO stores (id, name, slug, category, website, color, logoUrl, isTracked, firstSeenAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      website = excluded.website,
      color = excluded.color,
      logoUrl = excluded.logoUrl
  `;

  const statements = dealers.map((d: ApiDealer) => {
    if (!existing.has(d.id)) newCount++;
    const category = d.category_ids?.[0] ?? null;
    return {
      sql: upsertSql,
      params: [
        d.id,
        d.name,
        d.name,
        category,
        d.website,
        d.color ? `#${d.color}` : null,
        d.logo,
        now,
      ],
    };
  });

  await db.batch(statements);

  if (newCount > 0) {
    const newStores = await db.all<{ id: string; name: string }>(
      "SELECT id, name FROM stores WHERE firstSeenAt = ?",
      [now]
    );
    for (const s of newStores) {
      console.log(`  New store: ${s.name} (${s.id})`);
    }
  }

  const tracked = (
    await db.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM stores WHERE isTracked = 1"
    )
  )!.c;

  return { total: dealers.length, new: newCount, tracked };
}

async function scrapeStore(
  db: DbClient,
  storeId: string,
  storeName: string,
  now: string
): Promise<{ newCatalogs: number; newOffers: number }> {
  const catalogs = await fetchCatalogs(storeId);
  let newCatalogs = 0;
  let newOffers = 0;

  // Quarantine any existing catalog with zero offers (decision E5). A previous
  // partial write would have left a row behind; we want it visible (not
  // silently skipped) but excluded from future runs.
  const zeroOfferIds = await db.all<{ id: string }>(
    `SELECT c.id FROM catalogs c
     LEFT JOIN offers o ON o.catalogId = c.id
     WHERE c.storeId = ? AND c.quarantined = 0
     GROUP BY c.id HAVING COUNT(o.id) = 0`,
    [storeId]
  );
  for (const row of zeroOfferIds) {
    await quarantineWithBackoff(db, row.id);
  }

  const existingCatalogs = new Set(
    (
      await db.all<{ id: string }>(
        "SELECT id FROM catalogs WHERE storeId = ? AND quarantined = 0",
        [storeId]
      )
    ).map((r) => r.id)
  );

  for (const catalog of catalogs) {
    if (existingCatalogs.has(catalog.id)) continue;

    console.log(
      `  ${storeName}: scraping "${catalog.label}" (${catalog.offer_count} offers)`
    );

    const offers = await fetchAllOffers(catalog.id);
    const insertOfferSql = `
      INSERT OR IGNORE INTO offers
        (id, catalogId, storeId, heading, description, price, prePrice, currency,
         unitSymbol, siUnit, siFactor, sizeFrom, sizeTo, piecesFrom, piecesTo,
         computedUnitPrice, unitPriceKind, validFrom, validUntil, imageUrl, scrapedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const catalogInsert = {
      sql: `INSERT INTO catalogs (id, storeId, label, offerCount, pageCount, publishedAt, validFrom, validUntil, scrapedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         offerCount = excluded.offerCount,
         pageCount = excluded.pageCount,
         publishedAt = excluded.publishedAt,
         validFrom = excluded.validFrom,
         validUntil = excluded.validUntil,
         scrapedAt = excluded.scrapedAt,
         quarantined = 0`,
      params: [
        catalog.id,
        storeId,
        catalog.label,
        catalog.offer_count,
        catalog.page_count,
        catalog.publish,
        catalog.run_from,
        catalog.run_till,
        now,
      ],
    };

    const offerStatements = offers.map((o: ApiOffer) => {
      const unit = computeUnitPrice(o);
      return {
        sql: insertOfferSql,
        params: [
          o.id,
          catalog.id,
          storeId,
          o.heading,
          o.description,
          o.pricing.price,
          o.pricing.pre_price,
          o.pricing.currency,
          o.quantity?.unit?.symbol ?? null,
          o.quantity?.unit?.si?.symbol ?? null,
          o.quantity?.unit?.si?.factor ?? null,
          o.quantity?.size?.from ?? null,
          o.quantity?.size?.to ?? null,
          o.quantity?.pieces?.from ?? null,
          o.quantity?.pieces?.to ?? null,
          unit.value,
          unit.kind,
          o.run_from,
          o.run_till,
          o.images?.view ?? null,
          now,
        ],
      };
    });

    // Build chunked batches. The catalog INSERT must land in chunk 0 so a
    // partial failure leaves the catalog row present for compensation
    // (decisions E1 + E2).
    const allStatements = [catalogInsert, ...offerStatements];
    const chunks: Array<Array<{ sql: string; params?: any[] }>> = [];
    for (let i = 0; i < allStatements.length; i += D1_BATCH_CHUNK_SIZE) {
      chunks.push(allStatements.slice(i, i + D1_BATCH_CHUNK_SIZE));
    }

    try {
      for (const chunk of chunks) {
        await db.batch(chunk);
      }
      newCatalogs++;
      newOffers += offers.length;
    } catch (err) {
      // Soft-delete the catalog row instead of hard-deleting it (decision E1).
      // The quarantine helper logs and continues if the UPDATE itself fails.
      await quarantineWithBackoff(db, catalog.id);
      throw err;
    }
  }

  await db.run("UPDATE stores SET lastScrapedAt = ? WHERE id = ?", [
    now,
    storeId,
  ]);

  return { newCatalogs, newOffers };
}
