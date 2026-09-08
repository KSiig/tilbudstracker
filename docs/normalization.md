# Heading normalization

## 1. Goal

Heading normalization turns the raw `offers.heading` strings (captured verbatim
from the Tjek API) into stable product identities so price-history analysis can
survive re-scraping. The motivating case is the user-reported pair:

- `"Dansk hel kylling"`
- `"Rose Fersk Dansk Hel Kylling"`

These are the same physical product (whole chicken; Rose is the brand prefix),
but they share no string. A naive join on `heading` misses them. The
normalization layer collapses them — and similar semantic duplicates — into a
single row in `offers_normalized` that both offer rows point at via
`offers.normalized_id`.

The data model and the three passes were validated on the offer sample
referenced in the M3 milestone body. The LLM pass was POC'd on the planning
workstation (median ~3 s/call, max 28 s) with 12/12 case-only auto-clusters
correctly merged, the user's example pair correctly merged, and known
different-product pairs correctly split.

## 2. Data model

Two tables and three new columns.

```
offers (existing)
  ... existing columns ...
  normalized_id INTEGER REFERENCES offers_normalized(id)   -- nullable; set by passes 1/2/3
  is_split      INTEGER NOT NULL DEFAULT 0                  -- 1 on the original of a bundle
  bundle_ids    TEXT                                        -- JSON array of NEW offer ids (bundle originals only)

offers_normalized (new)
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  created_by     TEXT    NOT NULL CHECK (created_by IN ('system:regex','system:llm','user')),
  notes          TEXT,
  superseded_by  INTEGER REFERENCES offers_normalized(id)
```

Many `offers` rows map to one `offers_normalized` row via `normalized_id`.
Bundle offers break that one-to-many mapping: the **original** offer stays in
`offers` with `is_split = 1` and `bundle_ids = JSON.stringify([new_id, ...])`;
the **per-product** rows (created by Pass 1) are fresh `offers` rows that each
get their own `normalized_id` assigned later by Pass 2 or Pass 3.

`superseded_by` is small and optional. It is used when a later pass realizes
two `offers_normalized` rows are actually the same product: insert a new row
pointing at the same members, and set the old row's `superseded_by` to the new
row's id. The v1 write policy (Pass 2 write-only ≥ 2) does not need it; the
hook stays for manual corrections.

## 3. The three passes

The passes run in a fixed order. The order matters.

### Pass 1 — Bundle detection (`pnpm normalize:bundles`)

Some offers describe a CHOICE of multiple products under one price (the
"kylling-burgerryg-grisekød" bundle). If these are not split, they either
merge into a fake "bundle product" (polluting price history) or stay
un-normalized (missing offers entirely).

Detection is strict: a heading must contain `eller` AND a unit token
(`kg`, `g`, `l`, `cl`, `ml`, or `stk`) AND ≥ 2 segments after splitting on
`eller` and `,\s+` must each carry a unit token. A loose detector (just
`eller`) would over-split — `"kyllingebrystfilet eller -inderfilet"` is a
single product with two cuts, not a bundle.

For each bundle row, Pass 1:

- Inserts N new `offers` rows, one per per-product segment, inheriting the
  bundle's `price`, `prePrice`, `currency`, and other bundle-level fields
  verbatim.
- Sets `is_split = 0` and `normalized_id = NULL` on each new row (Pass 2
  assigns them later).
- Sets `is_split = 1` and `bundle_ids = JSON.stringify(newIds)` on the
  original bundle row.

### Pass 2 — Trivial case/punctuation fold (`pnpm normalize:regex`)

The cheap pass. Groups offers by a Unicode-aware fold of the heading
(`NFC → lowercase → strip non-letter/non-digit/non-whitespace → collapse
whitespace`). Writes one `offers_normalized` row per surviving group with
`created_by = 'system:regex'` and `title = trivialNormalize(headings[0].heading)`.

The fold preserves Danish letters (`ø`, `æ`, `å`) — the implementation uses
`/[^\p{L}\p{N}\s]/gu`, not `[^\\w\\s]` (which strips them).

Idempotent: re-running produces no new rows because the read filter is
`WHERE normalized_id IS NULL AND is_split = 0`.

### Pass 3 — LLM clustering (`pnpm normalize:llm`)

The semantic pass. Reads what Pass 1 and Pass 2 left behind
(`normalized_id IS NULL AND is_split = 0`) and clusters them with MiniMax M3
via the OpenAI-compat endpoint at `https://api.minimax.io/v1/chat/completions`.

The request body forces guaranteed JSON output by combining three OpenAI-compat
features (per the M3 review on 2026-09-06):

- `thinking: { type: "disabled" }` — no internal thinking bleeds into the
  response.
- `tools: [{ type: "function", function: { name: "record_clusters", ... } }]`
  with `tool_choice: { type: "function", function: { name: "record_clusters" } }`
  — the model MUST call the tool; the response is the tool-call `arguments`
  JSON string. No markdown fences to strip.
- `reasoning_split: true` — defensive; if reasoning ever leaks into `content`,
  it lands in `reasoning_details` instead.

A per-invocation cap (`NORMALIZE_LLM_CAP`, default 90) bounds the runtime to
stay inside the Cloud Function 300 s timeout. After each call, the CLI sleeps
350 ms to stay under MiniMax's 200 RPM rate limit with margin.

## 4. Write policy

Pass 2 writes only groups with **≥ 2 offers OR ≥ 2 distinct headings**.
Singleton groups are left for Pass 3.

Rationale: writing every group (including singletons) in Pass 2 would force
Pass 3 to implement merge logic when two singleton groups turn out to be the
same product. Skipping singletons in Pass 2 keeps Pass 3's job simple — every
offer Pass 3 sees is either a singleton or part of a leftover cluster, and
Pass 3 writes a fresh `offers_normalized` row per cluster it discovers. The
two passes do not conflict on the same offers.

The numbers from the offer sample used during the M3 review (5,758 rows):
2,948 trivial forms, 736 groups with ≥ 2 offers (covering 3,546 offers), 136
groups with ≥ 2 distinct headings (covering 526 offers), 2,212 singleton
groups left for Pass 3.

## 5. Canonical title strategy

`offers_normalized.title` is the lowercase folded form —
`trivialNormalize(headings[0].heading)`. Cheap to reverse, easy to grep,
easy to JOIN on. Example: `"BUKO Smelteost"` → `"buko smelteost"`.

The styled-text display column (proper-case, original-spelling rendering) is
tracked separately as a follow-up spike. Adding it later does not change
the canonical key — it adds a parallel display column that the UI can read
without affecting JOINs or merges.

## 6. Bundle price

Per-product rows inherit the bundle's `price`, `prePrice`, and `currency`
verbatim. **No** `normalizationNote` flag is set on per-product rows — the
schema invariants (`is_split = 1` on bundle originals, `is_split = 0` on
per-product rows) are the only signal. Queries that want clean per-product
prices MUST filter `is_split = 0`.

This is a deliberate trade-off: a 50 kr bundle written to each of its three
per-product rows would triple the apparent offer count in price-history
queries. The `is_split = 0` filter is cheap and unambiguous.

## 7. Cron schedule

- Daily scrape at 06:00 Europe/Copenhagen (`tilbudstracker-daily`) — runs
  `scrape(db)` only. Does NOT run the normalization passes.
- Weekly normalization at Sunday 06:30 Europe/Copenhagen
  (`tilbudstracker-weekly-normalize`) — runs `scrape(db)` followed by
  `normalizeBundles(db)` → `normalizeRegex(db)` → `normalizeLlm(db)` in
  order.

The weekly cadence catches all new offers within 24 hours of the previous
day's daily scrape. Daily LLM calls would burn Token Plan quota without a
freshness gain (5–20 new offers per scrape is small).

The deploy wiring (Secret Manager, IAM, scheduler creation, p95 alert
adjustment) lives in Linear issue SII-74.

## 8. Correction

Three patterns, in order of how invasive they are:

1. **Re-title an existing cluster.**
   `UPDATE offers_normalized SET title = 'new title' WHERE id = ?;`
   No re-pointing of `offers.normalized_id` is needed; only the canonical
   title changes.

2. **Re-point member offers to a different cluster.**
   `UPDATE offers SET normalized_id = ? WHERE normalized_id = ?;`
   Use when the cluster split or merge was wrong but the `offers_normalized`
   rows already exist.

3. **Insert a new cluster and supersede the old one.**
   `INSERT INTO offers_normalized (...) VALUES (...);`
   `UPDATE old_row SET superseded_by = new_id;`
   `UPDATE offers SET normalized_id = new_id WHERE normalized_id = old_id;`
   Use when a later pass realizes two `offers_normalized` rows are actually
   the same product and you want to preserve the audit trail.

## 9. Open items / follow-ups

- Styled-text display column for `offers_normalized.title` (proper-case /
  original-spelling rendering). Tracked as the SII-75 spike. The canonical
  `title` stays as the lowercase folded form; the display column is a
  parallel field the UI can read.
- Optional D1 backfill for `offers_normalized` after the schema deploys.
  Pass 2 and Pass 3 cover the data automatically on the next weekly run; a
  manual backfill is only needed if you want history before the first
  scheduled normalization.
