import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Mock api.js BEFORE importing scrape.js so the module-level fetchDealers call
// inside scrapeStore is replaced.
vi.mock("./api.js", () => ({
  fetchDealers: vi.fn(),
  fetchCatalogs: vi.fn(),
  fetchAllOffers: vi.fn(),
}));

import { fetchDealers, fetchCatalogs, fetchAllOffers } from "./api.js";
import { scrape } from "./scrape.js";
import type { DbClient } from "./db.js";

function makeMockDb(opts: {
  batchImpl?: (statements: any[]) => Promise<void>;
  runLog?: Array<{ sql: string; params?: any[] }>;
  allResponses?: Array<any[]>;
  getResponses?: Array<any>;
} = {}): DbClient & {
  runCalls: Array<{ sql: string; params?: any[] }>;
  batchCalls: Array<any[]>;
  allQueue: any[][];
  getQueue: any[];
} {
  const runCalls: Array<{ sql: string; params?: any[] }> = [];
  const batchCalls: Array<any[]> = [];
  const allQueue = [...(opts.allResponses ?? [])];
  const getQueue = [...(opts.getResponses ?? [])];

  const runImpl = (sql: string, params: any[] = []) => {
    runCalls.push({ sql, params });
    return Promise.resolve();
  };

  const batchImpl = opts.batchImpl ?? (() => Promise.resolve());

  const db = {
    run: async (sql: string, params: any[] = []) => runImpl(sql, params),
    get: async <T>(_sql: string, _params: any[] = []) =>
      getQueue.shift() as T | undefined,
    all: async <T>(_sql: string, _params: any[] = []) =>
      (allQueue.shift() ?? []) as T[],
    batch: async (statements: any[]) => {
      batchCalls.push(statements);
      return batchImpl(statements);
    },
    close: async () => undefined,
    // Test helpers
    runCalls,
    batchCalls,
    allQueue,
    getQueue,
  } as unknown as DbClient & {
    runCalls: Array<{ sql: string; params?: any[] }>;
    batchCalls: Array<any[]>;
    allQueue: any[][];
    getQueue: any[];
  };
  return db;
}

/** Sequence of db.all(...) calls inside scrape(), in order:
 *  1. syncStores: SELECT id FROM stores (existing)
 *  2. syncStores: SELECT id, name FROM stores WHERE firstSeenAt = ? (only if newCount>0)
 *  3. main: SELECT id, name FROM stores WHERE isTracked = 1
 *  4. scrapeStore: zero-offer SELECT
 *  5. scrapeStore: existingCatalogs SELECT
 */

describe("scrape — partial-failure compensation (decision E1)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("soft-deletes the catalog (UPDATE quarantined = 1) when batch throws", async () => {
    // 1. fetchDealers returns one tracked store
    (fetchDealers as any).mockResolvedValue([
      {
        id: "store-1",
        name: "Test",
        website: null,
        logo: null,
        color: null,
        category_ids: [],
        country: { id: "dk" },
      },
    ]);
    // 2. fetchCatalogs returns one catalog
    (fetchCatalogs as any).mockResolvedValue([
      {
        id: "cat-1",
        label: "Uge 1",
        run_from: "2026-01-01T00:00:00Z",
        run_till: "2026-01-07T23:59:59Z",
        publish: "2025-12-30T00:00:00Z",
        page_count: 2,
        offer_count: 1,
        dealer_id: "store-1",
        branding: { name: "Test" },
      },
    ]);
    // 3. fetchAllOffers returns one offer
    (fetchAllOffers as any).mockResolvedValue([
      {
        id: "off-1",
        heading: "Mælk",
        description: null,
        catalog_page: null,
        pricing: { price: 10, pre_price: null, currency: "DKK" },
        quantity: {
          unit: { symbol: "l", si: { symbol: "L", factor: 1 } },
          size: { from: 1, to: 1 },
          pieces: { from: 1, to: 1, min: null, max: null },
        },
        images: { view: null },
        run_from: "2026-01-01T00:00:00Z",
        run_till: "2026-01-07T23:59:59Z",
        dealer_id: "store-1",
      },
    ]);

    const db = makeMockDb({
      allResponses: [
        [], // 1. existing stores
        [{ id: "store-1", name: "Test" }], // 2. firstSeenAt=new
        [{ id: "store-1", name: "Test" }], // 3. trackedStores
        [], // 4. zero-offer
        [], // 5. existingCatalogs
      ],
      getResponses: [{ c: 1 }],
      batchImpl: async (statements: any[]) => {
        const isCatalogBatch =
          statements.length > 0 &&
          typeof statements[0].sql === "string" &&
          statements[0].sql.includes("INSERT INTO catalogs");
        if (isCatalogBatch) {
          throw new Error("simulated D1 batch failure");
        }
        // syncStores batch (store upserts) succeeds silently.
      },
    });

    await expect(scrape(db as unknown as DbClient)).rejects.toThrow(
      /simulated D1 batch failure/
    );

    // The compensation UPDATE must have been issued with `quarantined = 1`
    // and the catalog id from the failing batch (decision E1).
    const quarantineUpdates = (db as any).runCalls.filter(
      (c: any) =>
        c.sql === "UPDATE catalogs SET quarantined = 1 WHERE id = ?" &&
        Array.isArray(c.params) &&
        c.params[0] === "cat-1"
    );
    expect(quarantineUpdates.length).toBeGreaterThan(0);
  });
});

describe("scrape — zero-offer existing catalogs (decision E5)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("quarantines a catalog with zero offers before processing", async () => {
    (fetchDealers as any).mockResolvedValue([
      {
        id: "store-1",
        name: "Test",
        website: null,
        logo: null,
        color: null,
        category_ids: [],
        country: { id: "dk" },
      },
    ]);
    // fetchCatalogs returns no Tjek catalogs (zero-offer existing row gets
    // quarantined and skipped).
    (fetchCatalogs as any).mockResolvedValue([]);
    (fetchAllOffers as any).mockResolvedValue([]);

    const db = makeMockDb({
      allResponses: [
        [], // 1. existing stores
        [{ id: "store-1", name: "Test" }], // 2. firstSeenAt=new
        [{ id: "store-1", name: "Test" }], // 3. trackedStores
        [{ id: "ghost-cat" }], // 4. zero-offer
        [], // 5. existingCatalogs
      ],
      getResponses: [{ c: 1 }],
    });

    await scrape(db as unknown as DbClient);

    const quarantineUpdates = (db as any).runCalls.filter(
      (c: any) =>
        c.sql === "UPDATE catalogs SET quarantined = 1 WHERE id = ?" &&
        Array.isArray(c.params) &&
        c.params[0] === "ghost-cat"
    );
    expect(quarantineUpdates.length).toBe(1);
  });
});
