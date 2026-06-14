import { getDb } from "./db.js";
import { scrape } from "./scrape.js";

const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case "scrape":
    await scrape();
    break;

  case "stores": {
    const db = getDb();
    const stores = db
      .prepare(
        `SELECT id, name, category, isTracked, lastScrapedAt, firstSeenAt
         FROM stores ORDER BY isTracked DESC, name`
      )
      .all() as {
      id: string;
      name: string;
      category: string | null;
      isTracked: number;
      lastScrapedAt: string | null;
      firstSeenAt: string;
    }[];

    if (stores.length === 0) {
      console.log("No stores in database. Run `pnpm scrape` first.");
      break;
    }

    console.log(
      `${"ID".padEnd(8)} ${"Name".padEnd(30)} ${"Category".padEnd(15)} ${"Tracked".padEnd(9)} Last scraped`
    );
    console.log("-".repeat(90));
    for (const s of stores) {
      const tracked = s.isTracked ? "YES" : "no";
      const lastScraped = s.lastScrapedAt
        ? s.lastScrapedAt.slice(0, 10)
        : "never";
      console.log(
        `${s.id.padEnd(8)} ${s.name.padEnd(30)} ${(s.category ?? "").padEnd(15)} ${tracked.padEnd(9)} ${lastScraped}`
      );
    }
    break;
  }

  case "track": {
    const storeId = args[0];
    if (!storeId) {
      console.error("Usage: pnpm track <storeId>");
      process.exit(1);
    }
    const db = getDb();
    const result = db
      .prepare("UPDATE stores SET isTracked = 1 WHERE id = ?")
      .run(storeId);
    if (result.changes === 0) {
      console.error(`Store "${storeId}" not found. Run \`pnpm scrape\` first to sync stores.`);
      process.exit(1);
    }
    const store = db
      .prepare("SELECT name FROM stores WHERE id = ?")
      .get(storeId) as { name: string };
    console.log(`Tracking enabled for ${store.name} (${storeId})`);
    break;
  }

  case "untrack": {
    const storeId = args[0];
    if (!storeId) {
      console.error("Usage: pnpm untrack <storeId>");
      process.exit(1);
    }
    const db = getDb();
    const result = db
      .prepare("UPDATE stores SET isTracked = 0 WHERE id = ?")
      .run(storeId);
    if (result.changes === 0) {
      console.error(`Store "${storeId}" not found.`);
      process.exit(1);
    }
    const store = db
      .prepare("SELECT name FROM stores WHERE id = ?")
      .get(storeId) as { name: string };
    console.log(`Tracking disabled for ${store.name} (${storeId})`);
    break;
  }

  case "stats": {
    const db = getDb();
    const storeCount = (
      db.prepare("SELECT COUNT(*) as c FROM stores").get() as { c: number }
    ).c;
    const trackedCount = (
      db.prepare("SELECT COUNT(*) as c FROM stores WHERE isTracked = 1").get() as {
        c: number;
      }
    ).c;
    const catalogCount = (
      db.prepare("SELECT COUNT(*) as c FROM catalogs").get() as { c: number }
    ).c;
    const offerCount = (
      db.prepare("SELECT COUNT(*) as c FROM offers").get() as { c: number }
    ).c;

    console.log(`Stores:   ${storeCount} (${trackedCount} tracked)`);
    console.log(`Catalogs: ${catalogCount}`);
    console.log(`Offers:   ${offerCount}`);

    if (offerCount > 0) {
      const dateRange = db
        .prepare(
          "SELECT MIN(validFrom) as earliest, MAX(validUntil) as latest FROM offers"
        )
        .get() as { earliest: string; latest: string };
      console.log(
        `Date range: ${dateRange.earliest.slice(0, 10)} to ${dateRange.latest.slice(0, 10)}`
      );

      const byKind = db
        .prepare(
          "SELECT unitPriceKind, COUNT(*) as c FROM offers GROUP BY unitPriceKind ORDER BY c DESC"
        )
        .all() as { unitPriceKind: string; c: number }[];
      console.log("\nUnit price breakdown:");
      for (const row of byKind) {
        const pct = ((row.c / offerCount) * 100).toFixed(0);
        console.log(`  ${(row.unitPriceKind ?? "null").padEnd(12)} ${row.c} (${pct}%)`);
      }

      const normalized = (
        db
          .prepare(
            "SELECT COUNT(*) as c FROM offers WHERE normalizedUnitPrice IS NOT NULL"
          )
          .get() as { c: number }
      ).c;
      if (normalized > 0) {
        console.log(`\nLLM-normalized: ${normalized}/${offerCount}`);
      }
    }
    break;
  }

  default:
    console.log(`Usage: tilbudstracker <command>

Commands:
  scrape          Sync stores and scrape offers from tracked stores
  stores          List all stores and their tracking status
  track <id>      Enable tracking for a store
  untrack <id>    Disable tracking for a store
  stats           Show database statistics`);
    if (command) {
      console.error(`\nUnknown command: ${command}`);
      process.exit(1);
    }
}
