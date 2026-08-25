import type { DbClient } from "./db.js";
import { fetchDealers, fetchCatalogs, fetchAllOffers } from "./api.js";
import { computeUnitPrice } from "./unit-price.js";
import type { ApiDealer, ApiCatalog, ApiOffer } from "./types.js";

export async function scrape(db: DbClient): Promise<void> {
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

  const existingCatalogs = new Set(
    (
      await db.all<{ id: string }>(
        "SELECT id FROM catalogs WHERE storeId = ?",
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

    const statements = [
      {
        sql: `INSERT INTO catalogs (id, storeId, label, offerCount, pageCount, publishedAt, validFrom, validUntil, scrapedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      },
      ...offers.map((o: ApiOffer) => {
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
      }),
    ];

    await db.batch(statements);
    newCatalogs++;
    newOffers += offers.length;
  }

  await db.run("UPDATE stores SET lastScrapedAt = ? WHERE id = ?", [
    now,
    storeId,
  ]);

  return { newCatalogs, newOffers };
}
