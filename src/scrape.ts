import { getDb } from "./db.js";
import { fetchDealers, fetchCatalogs, fetchAllOffers } from "./api.js";
import { computeUnitPrice } from "./unit-price.js";
import type { ApiDealer, ApiCatalog, ApiOffer } from "./types.js";

export async function scrape(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  const storeStats = await syncStores(db, now);
  console.log(
    `Stores: ${storeStats.total} total, ${storeStats.new} new, ${storeStats.tracked} tracked`
  );

  if (storeStats.tracked === 0) {
    console.log(
      "No stores are tracked. Use `pnpm track <storeId>` to enable tracking."
    );
    return;
  }

  const trackedStores = db
    .prepare("SELECT id, name FROM stores WHERE isTracked = 1")
    .all() as { id: string; name: string }[];

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
}

async function syncStores(
  db: ReturnType<typeof getDb>,
  now: string
): Promise<{ total: number; new: number; tracked: number }> {
  const dealers = await fetchDealers();
  let newCount = 0;

  const upsert = db.prepare(`
    INSERT INTO stores (id, name, slug, category, website, color, logoUrl, isTracked, firstSeenAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      website = excluded.website,
      color = excluded.color,
      logoUrl = excluded.logoUrl
  `);

  const existing = new Set(
    (db.prepare("SELECT id FROM stores").all() as { id: string }[]).map(
      (r) => r.id
    )
  );

  const insertMany = db.transaction((dealers: ApiDealer[]) => {
    for (const d of dealers) {
      if (!existing.has(d.id)) newCount++;
      const category = d.category_ids?.[0] ?? null;
      upsert.run(
        d.id,
        d.name,
        d.name,
        category,
        d.website,
        d.color ? `#${d.color}` : null,
        d.logo,
        now
      );
    }
  });

  insertMany(dealers);

  if (newCount > 0) {
    const newStores = db
      .prepare("SELECT id, name FROM stores WHERE firstSeenAt = ?")
      .all(now) as { id: string; name: string }[];
    for (const s of newStores) {
      console.log(`  New store: ${s.name} (${s.id})`);
    }
  }

  const tracked = (
    db.prepare("SELECT COUNT(*) as c FROM stores WHERE isTracked = 1").get() as {
      c: number;
    }
  ).c;

  return { total: dealers.length, new: newCount, tracked };
}

async function scrapeStore(
  db: ReturnType<typeof getDb>,
  storeId: string,
  storeName: string,
  now: string
): Promise<{ newCatalogs: number; newOffers: number }> {
  const catalogs = await fetchCatalogs(storeId);
  let newCatalogs = 0;
  let newOffers = 0;

  const existingCatalogs = new Set(
    (
      db
        .prepare("SELECT id FROM catalogs WHERE storeId = ?")
        .all(storeId) as { id: string }[]
    ).map((r) => r.id)
  );

  for (const catalog of catalogs) {
    if (existingCatalogs.has(catalog.id)) continue;

    console.log(
      `  ${storeName}: scraping "${catalog.label}" (${catalog.offer_count} offers)`
    );

    db.prepare(
      `INSERT INTO catalogs (id, storeId, label, offerCount, pageCount, publishedAt, validFrom, validUntil, scrapedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      catalog.id,
      storeId,
      catalog.label,
      catalog.offer_count,
      catalog.page_count,
      catalog.publish,
      catalog.run_from,
      catalog.run_till,
      now
    );

    const offers = await fetchAllOffers(catalog.id);
    const insertOffer = db.prepare(`
      INSERT OR IGNORE INTO offers
        (id, catalogId, storeId, heading, description, price, prePrice, currency,
         unitSymbol, siUnit, siFactor, sizeFrom, sizeTo, piecesFrom, piecesTo,
         computedUnitPrice, unitPriceKind, validFrom, validUntil, imageUrl, scrapedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertAll = db.transaction((offers: ApiOffer[]) => {
      for (const o of offers) {
        const unit = computeUnitPrice(o);
        insertOffer.run(
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
          now
        );
      }
    });

    insertAll(offers);
    newCatalogs++;
    newOffers += offers.length;
  }

  db.prepare("UPDATE stores SET lastScrapedAt = ? WHERE id = ?").run(
    now,
    storeId
  );

  return { newCatalogs, newOffers };
}
