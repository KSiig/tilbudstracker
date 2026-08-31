import { createDb } from "./db.js";
import { scrape } from "./scrape.js";
import { readFileSync } from "node:fs";

const command = process.argv[2];
const args = process.argv.slice(3);

function getFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const a of args) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return undefined;
}

const db = await createDb();

switch (command) {
  case "scrape":
    await scrape(db);
    break;

  case "stores": {
    const stores = await db.all<{
      id: string;
      name: string;
      category: string | null;
      isTracked: number;
      lastScrapedAt: string | null;
      firstSeenAt: string;
    }>(
      `SELECT id, name, category, isTracked, lastScrapedAt, firstSeenAt
       FROM stores ORDER BY isTracked DESC, name`
    );

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
    const listFile = getFlag("list-file");
    if (listFile) {
      // Bulk tracking from a newline-separated file of Tjek dealer ids.
      // Decision D7 from SII-50: lets us flip `isTracked=1` for N stores
      // without running `pnpm track <id>` N times.
      const fromDb = getFlag("from");
      if (fromDb !== "d1") {
        console.error(
          "`--from=d1` is required with `--list-file`. (sqlite bulk not yet supported.)"
        );
        process.exit(1);
      }
      const raw = readFileSync(listFile, "utf-8");
      const ids = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (ids.length === 0) {
        console.error(`No ids found in ${listFile}.`);
        process.exit(1);
      }
      const statements = ids.map((id) => ({
        sql: "UPDATE stores SET isTracked = 1 WHERE id = ?",
        params: [id],
      }));
      await db.batch(statements);
      console.log(
        `Bulk-tracked ${ids.length} stores from ${listFile}: ${ids.join(", ")}`
      );
      break;
    }

    const storeId = args[0];
    if (!storeId) {
      console.error("Usage: pnpm track <storeId>");
      console.error("       pnpm track --from=d1 --list-file=<path>");
      process.exit(1);
    }
    await db.run("UPDATE stores SET isTracked = 1 WHERE id = ?", [storeId]);
    const store = await db.get<{ name: string }>(
      "SELECT name FROM stores WHERE id = ?",
      [storeId]
    );
    if (!store) {
      console.error(`Store "${storeId}" not found. Run \`pnpm scrape\` first to sync stores.`);
      process.exit(1);
    }
    console.log(`Tracking enabled for ${store.name} (${storeId})`);
    break;
  }

  case "untrack": {
    const storeId = args[0];
    if (!storeId) {
      console.error("Usage: pnpm untrack <storeId>");
      process.exit(1);
    }
    await db.run("UPDATE stores SET isTracked = 0 WHERE id = ?", [storeId]);
    const store = await db.get<{ name: string }>(
      "SELECT name FROM stores WHERE id = ?",
      [storeId]
    );
    if (!store) {
      console.error(`Store "${storeId}" not found.`);
      process.exit(1);
    }
    console.log(`Tracking disabled for ${store.name} (${storeId})`);
    break;
  }

  case "stats": {
    const storeCount = (
      await db.get<{ c: number }>("SELECT COUNT(*) as c FROM stores")
    )!.c;
    const trackedCount = (
      await db.get<{ c: number }>(
        "SELECT COUNT(*) as c FROM stores WHERE isTracked = 1"
      )
    )!.c;
    const catalogCount = (
      await db.get<{ c: number }>("SELECT COUNT(*) as c FROM catalogs")
    )!.c;
    const offerCount = (
      await db.get<{ c: number }>("SELECT COUNT(*) as c FROM offers")
    )!.c;

    console.log(`Stores:   ${storeCount} (${trackedCount} tracked)`);
    console.log(`Catalogs: ${catalogCount}`);
    console.log(`Offers:   ${offerCount}`);

    if (offerCount > 0) {
      const dateRange = await db.get<{ earliest: string; latest: string }>(
        "SELECT MIN(validFrom) as earliest, MAX(validUntil) as latest FROM offers"
      );
      console.log(
        `Date range: ${dateRange!.earliest.slice(0, 10)} to ${dateRange!.latest.slice(0, 10)}`
      );

      const byKind = await db.all<{ unitPriceKind: string; c: number }>(
        "SELECT unitPriceKind, COUNT(*) as c FROM offers GROUP BY unitPriceKind ORDER BY c DESC"
      );
      console.log("\nUnit price breakdown:");
      for (const row of byKind) {
        const pct = ((row.c / offerCount) * 100).toFixed(0);
        console.log(`  ${(row.unitPriceKind ?? "null").padEnd(12)} ${row.c} (${pct}%)`);
      }

      const normalized = (
        await db.get<{ c: number }>(
          "SELECT COUNT(*) as c FROM offers WHERE normalizedUnitPrice IS NOT NULL"
        )
      )!.c;
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

await db.close();
