/**
 * Pass 2 — trivial case/punctuation/whitespace normalization CLI.
 *
 * Reads offers that have not yet been assigned a `normalized_id` and groups
 * them by `trivialNormalize(heading)`. Groups with ≥ 2 distinct headings OR
 * ≥ 2 offers get one new `offers_normalized` row each (created_by =
 * 'system:regex'); every member's `offers.normalized_id` is updated to the
 * new id. Singletons are left alone — Pass 3 (LLM) handles them.
 *
 * Order dependency: this CLI must run **after** `pnpm normalize:bundles`
 * (Pass 1). The bundle CLI marks bundle originals `is_split = 1` and inserts
 * per-product rows with `is_split = 0`; the `WHERE is_split = 0` filter here
 * ensures bundle originals are excluded while their per-product rows are
 * eligible. The CLI does not enforce this itself; the handler integration
 * (SII-71) is the deployment boundary.
 *
 * Idempotency: the `WHERE normalized_id IS NULL` filter on the read means a
 * second invocation is a no-op. New offers from subsequent scrapes are
 * picked up on the next run.
 */
import { createDb, type DbClient } from "../db.js";
import { trivialNormalize } from "./regex.js";
import { pathToFileURL } from "node:url";

interface UnnormalizedOffer {
  id: string;
  heading: string;
}

interface Group {
  fold: string;
  members: UnnormalizedOffer[];
}

const SQL_SELECT_UNNORMALIZED = `
  SELECT id, heading
  FROM offers
  WHERE normalized_id IS NULL
    AND is_split = 0
`;

const SQL_INSERT_NORMALIZED = `
  INSERT INTO offers_normalized (title, created_at, created_by, notes)
  VALUES (?, ?, 'system:regex', NULL)
  RETURNING id
`;

// Defensive `AND normalized_id IS NULL` guard mirrors the Pass 3 (LLM)
// pattern: a stale retry or a concurrent run of `pnpm normalize:regex`
// must not overwrite an existing `normalized_id` assignment.
const SQL_LINK_OFFER = `
  UPDATE offers SET normalized_id = ? WHERE id = ? AND normalized_id IS NULL
`;

const NOW = () => new Date().toISOString();

/**
 * Filter groups by the Write Policy (decision P1, locked 2026-09-06): keep
 * only groups with ≥ 2 offers. The spec text reads "≥ 2 offers OR ≥ 2
 * distinct headings", but because {@link groupByFold} buckets offers by their
 * folded key, a single bucket can never contain fewer than 2 offers and 2+
 * distinct headings — fold-equal headings collapse into the same bucket, so
 * `distinctHeadings.size >= 2` with `members.length < 2` is unreachable. A
 * group with ≥ 2 members always has ≥ 2 distinct headings (when they happen
 * to differ in punctuation/case) or ≥ 2 fold-equal members; either way it
 * passes. Singletons are skipped — Pass 3 picks them up via the LLM.
 */
export function applyWritePolicy(groups: Group[]): Group[] {
  return groups.filter((g) => g.members.length >= 2);
}

/**
 * Build the fold → group[] map from unnormalized offers. Stable insertion
 * order is not guaranteed by the caller; we keep the order offers arrive in
 * (which matches the SQL read order). The first member's heading seeds the
 * canonical `title` for the group (decision B1, locked 2026-09-06).
 */
export function groupByFold(offers: UnnormalizedOffer[]): Group[] {
  const byFold = new Map<string, UnnormalizedOffer[]>();
  for (const offer of offers) {
    const fold = trivialNormalize(offer.heading);
    if (fold.length === 0) continue; // empty folds are not addressable
    const bucket = byFold.get(fold);
    if (bucket) bucket.push(offer);
    else byFold.set(fold, [offer]);
  }
  return Array.from(byFold, ([fold, members]) => ({ fold, members }));
}

/**
 * Write one `offers_normalized` row and link every member offer's
 * `normalized_id` to the new id. Returns the new normalized row's id.
 *
 * `db.get(SQL_INSERT_NORMALIZED)` uses the `RETURNING id` clause, which both
 * better-sqlite3 and D1 REST support through the same `DbClient.get()` API
 * — no client-specific branching required.
 */
async function writeGroup(
  db: DbClient,
  group: Group,
  now: string
): Promise<number> {
  const title = trivialNormalize(group.members[0].heading);
  const row = await db.get<{ id: number }>(SQL_INSERT_NORMALIZED, [
    title,
    now,
  ]);
  if (!row || typeof row.id !== "number") {
    throw new Error(
      `INSERT INTO offers_normalized RETURNING id did not return a numeric id (got ${JSON.stringify(
        row
      )})`
    );
  }
  const newId = row.id;

  // Batch UPDATE the members. `db.batch()` accepts statements with the same
  // { sql, params } shape used by scrape.ts.
  await db.batch(
    group.members.map((m) => ({
      sql: SQL_LINK_OFFER,
      params: [newId, m.id],
    }))
  );

  return newId;
}

export interface NormalizeRegexResult {
  groupsProcessed: number;
  offersNormalized: number;
}

/**
 * Run Pass 2 against `db`. Exported for the handler integration (SII-71);
 * the CLI is a thin wrapper that opens `createDb()` and prints the summary.
 */
export async function normalizeRegex(
  db: DbClient
): Promise<NormalizeRegexResult> {
  const now = NOW();
  const unnormalized = await db.all<UnnormalizedOffer>(SQL_SELECT_UNNORMALIZED);
  if (unnormalized.length === 0) {
    return { groupsProcessed: 0, offersNormalized: 0 };
  }

  const allGroups = groupByFold(unnormalized);
  const surviving = applyWritePolicy(allGroups);

  let offersNormalized = 0;
  for (const group of surviving) {
    await writeGroup(db, group, now);
    offersNormalized += group.members.length;
  }

  return {
    groupsProcessed: surviving.length,
    offersNormalized,
  };
}

// CLI entrypoint — invoked by `pnpm normalize:regex`. Guarded so importing
// this module from tests does not open a real database. Use `pathToFileURL`
// instead of string-concatting `file://` so paths with spaces, encoded
// characters, or Windows drive letters compare equal to `import.meta.url`.
const isMainModule = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  const db = await createDb();
  try {
    const result = await normalizeRegex(db);
    console.log(
      JSON.stringify(
        {
          groupsProcessed: result.groupsProcessed,
          offersNormalized: result.offersNormalized,
        },
        null,
        2
      )
    );
  } finally {
    await db.close();
  }
}
