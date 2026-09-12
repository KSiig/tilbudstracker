/**
 * SII-82 — OFF coverage spike.
 *
 * Read-only analysis that measures whether Open Food Facts can carry product
 * identity for the existing offer headings in D1. Output is a Markdown report
 * (`data/off-coverage-spike-<date>.md`) with two headline metrics:
 *
 *   1. Unique-hit % on **all** D1 offers.
 *   2. Unique-hit % on the **regex-clustered** subset
 *      (`normalized_id IS NOT NULL AND is_split = 0`).
 *
 * Both metrics are compared against a 50% threshold. If the regex-clustered
 * unique-hit is below 50% the cluster layer was doing real work and the
 * proposed simplification (drop M3 Pass 2/3, replace cluster layer with OFF
 * matching) is the wrong move.
 *
 * Pipeline:
 *
 *   data/off-dk-neighbours.jsonl  ─┐
 *                                  ├─→  build brand dictionary
 *   D1 (read-only)                 │
 *      ├─ all 9,710+ offers        ├─→  per-heading classification
 *      └─ regex-clustered subset ──┘            │
 *                                               ▼
 *                              data/off-coverage-spike-<date>.md
 *
 * Prerequisites:
 *
 *   1. `data/off.parquet` — full OFF food dump from Hugging Face (~7.3 GB
 *      compressed). The script does NOT download it; see the SII-82 issue
 *      for the URL.
 *   2. `data/off-dk-neighbours.jsonl` — pre-filtered OFF rows (one JSON
 *      object per line) containing `code`, `brands`, and `brands_tags`.
 *      Produced by DuckDB from the parquet in seconds:
 *
 *        duckdb -c "COPY (
 *          SELECT code, brands, brands_tags
 *          FROM read_parquet('data/off.parquet')
 *          WHERE list_contains(countries_tags, 'en:denmark')
 *             OR list_contains(countries_tags, 'en:sweden')
 *             OR list_contains(countries_tags, 'en:norway')
 *             OR list_contains(countries_tags, 'en:finland')
 *             OR list_contains(countries_tags, 'en:germany')
 *             OR list_contains(countries_tags, 'en:netherlands')
 *             OR list_contains(countries_tags, 'en:united-kingdom')
 *        ) TO 'data/off-dk-neighbours.jsonl' (FORMAT JSON)"
 *
 *   3. D1 credentials in the shell environment
 *      (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`,
 *      `CLOUDFLARE_API_TOKEN`). Set `DB_MODE=d1` and run via
 *      `pnpm tsx scripts/off-coverage-spike.ts`.
 *
 * This script is READ-ONLY against production D1 and OFF. No writes.
 */
import { createDb, type DbClient } from "../src/db.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Paths and constants
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OFF_NDJSON_PATH = path.join(REPO_ROOT, "data", "off-dk-neighbours.jsonl");
const REPORT_PATH = path.join(
  REPO_ROOT,
  "data",
  `off-coverage-spike-${today()}.md`
);

const COUNTRY_TAGS = [
  "en:denmark",
  "en:sweden",
  "en:norway",
  "en:finland",
  "en:germany",
  "en:netherlands",
  "en:united-kingdom",
] as const;

// Unit tokens to drop during tokenization (Q3 from the issue: light clean,
// strip "- max X,XX" style suffix and trailing punctuation). Bag-of-units
// mirrors the OFF quantity_token patterns + Danish unit conventions.
const UNIT_TOKENS = new Set([
  "g",
  "kg",
  "mg",
  "ml",
  "cl",
  "dl",
  "l",
  "stk",
  "%",
  "gr",
  "gram",
  "kilo",
  "liter",
  "litre",
  "stk.",
  "stks",
]);

// Words that look like quantity prefixes ("1,2 kg", "2 x", "500 g"). Stripped
// from the head of the heading before brand extraction.
const QUANTITY_PREFIX_RE =
  /^\s*(?:\d+(?:[.,]\d+)?\s*(?:x|×|×|pack|stk|pcs)?\s*)+/i;

// " - max X,XX" style suffix (Q3).
const MAX_PRICE_SUFFIX_RE = /\s*-\s*max\s+[\d.,]+\s*$/i;

// Trailing punctuation / whitespace (Q3).
const TRAILING_PUNCT_RE = /[\s.,;:!?]+$/;

// Fresh/unbarcoded markers — these go to not_in_scope before brand extraction.
// Short list keeps the heuristic honest; coverage will reveal holes.
const FRESH_MARKERS = ["frisk", "friske", "økologisk", "øko"];

const UNIQUE_HIT_THRESHOLD = 0.5; // 50%

// ---------------------------------------------------------------------------
// Tiny utilities
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function pct(n: number, d: number): string {
  if (d === 0) return "n/a";
  return `${((n / d) * 100).toFixed(1)}%`;
}

/**
 * Light cleaning — lowercase, NFC, drop connector apostrophes, replace
 * remaining punctuation with single space, collapse whitespace, trim. The
 * same shape as `src/normalize/regex.ts:trivialNormalize` (kept inline so
 * the spike can run independently of that module).
 */
export function lightClean(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u0027\u2019\u0060]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripOffTagPrefix(tag: string): string {
  // OFF tags use language prefixes like `en:` or `xx:`. We strip both.
  const idx = tag.indexOf(":");
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

// ---------------------------------------------------------------------------
// Brand dictionary
// ---------------------------------------------------------------------------

export interface OffRow {
  code: string;
  brands: string | null;
  brands_tags: string[] | null;
}

/**
 * Brand keyed by its first whitespace-separated token after normalization.
 * For each entry we keep the full normalized brand + the set of OFF codes
 * (products) that use it. 130k unique brand tags × ~1 product average means
 * the dictionary fits comfortably in memory (~50 MB).
 *
 * Trade-off: using the full normalized brand (with hyphens and dots collapsed
 * to spaces) as the lookup key means a heading word like "Ritter" matches
 * the entry keyed at "ritter", but the full entry is "ritter sport" — so the
 * matcher must also verify the rest of the heading tokens.
 */
export interface BrandIndex {
  // first-token → list of (fullBrand, codeSet)
  byFirstToken: Map<string, Array<{ fullBrand: string; codes: Set<string> }>>;
  // exact full-brand → set of codes (for sanity lookups)
  byFullBrand: Map<string, Set<string>>;
  totalRows: number;
  rowsWithBrand: number;
}

export function normalizeBrandForIndex(s: string): string {
  // Brand tags from OFF are already kebab/lowercase. We add a space-collapse
  // step so "st dalfour" and "st-dalfour" both hash to the same bucket.
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u0027\u2019\u0060]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Stream the OFF NDJSON, build the brand dictionary. Backpressure-friendly:
 * one line at a time, no buffering of the full file in memory.
 */
/**
 * Build a small brand index directly from an in-memory array of OFF rows.
 * Used by tests to spin up a deterministic index without streaming the
 * 60 MB NDJSON. Production code uses {@link buildBrandDictionary} which
 * streams the file line by line.
 */
export function buildBrandIndexFromRows(rows: OffRow[]): BrandIndex {
  const idx: BrandIndex = {
    byFirstToken: new Map(),
    byFullBrand: new Map(),
    totalRows: rows.length,
    rowsWithBrand: 0,
  };
  for (const row of rows) {
    if (!row.brands_tags || row.brands_tags.length === 0) continue;
    idx.rowsWithBrand++;
    for (const tag of row.brands_tags) {
      if (!tag) continue;
      const norm = normalizeBrandForIndex(stripOffTagPrefix(tag));
      if (!norm) continue;
      const firstToken = norm.split(" ", 1)[0];
      if (!firstToken) continue;
      let bucket = idx.byFullBrand.get(norm);
      if (!bucket) {
        bucket = new Set();
        idx.byFullBrand.set(norm, bucket);
      }
      bucket.add(row.code);
      let list = idx.byFirstToken.get(firstToken);
      if (!list) {
        list = [];
        idx.byFirstToken.set(firstToken, list);
      }
      let entry = list.find((e) => e.fullBrand === norm);
      if (!entry) {
        entry = { fullBrand: norm, codes: bucket };
        list.push(entry);
      }
    }
  }
  return idx;
}

export async function buildBrandDictionary(ndjsonPath: string): Promise<BrandIndex> {
  if (!existsFile(ndjsonPath)) {
    throw new Error(
      `Missing OFF NDJSON: ${ndjsonPath}. Run DuckDB first:\n\n` +
        `  duckdb -c "COPY (\n` +
        `    SELECT code, brands, brands_tags\n` +
        `    FROM read_parquet('data/off.parquet')\n` +
        `    WHERE list_contains(countries_tags, 'en:denmark')\n` +
        `       OR list_contains(countries_tags, 'en:sweden')\n` +
        `       OR list_contains(countries_tags, 'en:norway')\n` +
        `       OR list_contains(countries_tags, 'en:finland')\n` +
        `       OR list_contains(countries_tags, 'en:germany')\n` +
        `       OR list_contains(countries_tags, 'en:netherlands')\n` +
        `       OR list_contains(countries_tags, 'en:united-kingdom')\n` +
        `  ) TO 'data/off-dk-neighbours.jsonl' (FORMAT JSON)"`
    );
  }

  const idx: BrandIndex = {
    byFirstToken: new Map(),
    byFullBrand: new Map(),
    totalRows: 0,
    rowsWithBrand: 0,
  };

  const stream = createReadStream(ndjsonPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line) continue;
    idx.totalRows++;
    let row: OffRow;
    try {
      row = JSON.parse(line) as OffRow;
    } catch {
      continue;
    }
    if (!row.brands_tags || row.brands_tags.length === 0) continue;
    idx.rowsWithBrand++;

    for (const tag of row.brands_tags) {
      if (!tag) continue;
      const norm = normalizeBrandForIndex(stripOffTagPrefix(tag));
      if (!norm) continue;
      const firstToken = norm.split(" ", 1)[0];
      if (!firstToken) continue;

      // Append this code to the codeset for this brand.
      let bucket = idx.byFullBrand.get(norm);
      if (!bucket) {
        bucket = new Set();
        idx.byFullBrand.set(norm, bucket);
      }
      bucket.add(row.code);

      let list = idx.byFirstToken.get(firstToken);
      if (!list) {
        list = [];
        idx.byFirstToken.set(firstToken, list);
      }
      let entry = list.find((e) => e.fullBrand === norm);
      if (!entry) {
        entry = { fullBrand: norm, codes: bucket };
        list.push(entry);
      }
      // Codes are shared by reference with byFullBrand — no second add needed.
    }
  }

  return idx;
}

function existsFile(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Heading preprocessing
// ---------------------------------------------------------------------------

/**
 * Strip a quantity prefix from the head of the heading, e.g.
 * "1,2 kg Hakket" → "Hakket", "2x Brioche" → "Brioche", "500 g Sukker" → "Sukker".
 */
export function stripQuantityPrefix(cleaned: string): string {
  const m = cleaned.match(QUANTITY_PREFIX_RE);
  if (!m) return cleaned;
  // Make sure we actually consumed something — guard against an empty match.
  const rest = cleaned.slice(m[0].length).trim();
  return rest.length > 0 ? rest : cleaned;
}

export function stripMaxPriceSuffix(cleaned: string): string {
  return cleaned.replace(MAX_PRICE_SUFFIX_RE, "").replace(TRAILING_PUNCT_RE, "");
}

/**
 * Drop unit tokens from a tokenized heading. We do this AFTER brand
 * extraction would have happened — see {@link preprocess}. Brand tags don't
 * collide with unit tokens in practice ("g" is a unit, never a brand first
 * token), so this only matters for the no_brand heuristic and the report.
 */
export function dropUnitTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !UNIT_TOKENS.has(t));
}

export interface PreprocessedHeading {
  raw: string;
  cleaned: string; // after lightClean + quantity prefix/suffix removal
  tokens: string[]; // whitespace tokens of `cleaned`
  isFresh: boolean; // matches a fresh/unbarcoded marker
}

/**
 * Returns whether the cleaned heading contains a fresh/unbarcoded marker.
 * The list is intentionally short — coverage is what we are measuring.
 */
export function detectFreshMarker(cleaned: string): boolean {
  for (const marker of FRESH_MARKERS) {
    // Word boundary to avoid matching "økologi" inside "økologisk".
    const re = new RegExp(`\\b${marker}\\b`, "u");
    if (re.test(cleaned)) return true;
  }
  return false;
}

export function preprocess(raw: string): PreprocessedHeading {
  const cleaned0 = lightClean(raw);
  const cleaned = stripMaxPriceSuffix(stripQuantityPrefix(cleaned0));
  const isFresh = detectFreshMarker(cleaned);
  // Tokenize + drop pure-number tokens + drop unit tokens. The brand
  // extraction runs on this filtered list. Rationale:
  //   - Pure numbers ("8 12" in "fedt 8 12 %") are not in OFF `brands_tags`.
  //     Dropping them shortens the candidate list and makes the
  //     brand-matching loop deterministic.
  //   - Unit tokens can occasionally appear in OFF `brands_tags` (e.g. one
  //     row has `xx:kg` for a German pineapple brand "KG"). Dropping them
  //     before brand extraction prevents the algorithm from locking onto
  //     a unit token instead of the real brand.
  const tokensAll = cleaned.split(/\s+/).filter((t) => t.length > 0);
  const tokens = tokensAll.filter(
    (t) => !UNIT_TOKENS.has(t) && !/^\d+(?:[.,]\d+)?$/.test(t)
  );
  return { raw, cleaned, tokens, isFresh };
}

// ---------------------------------------------------------------------------
// Brand extraction
// ---------------------------------------------------------------------------

export type Classification =
  | "unique_match"
  | "ambiguous_match"
  | "no_brand"
  | "not_in_scope";

export interface HeadingResult {
  raw: string;
  cleaned: string;
  classification: Classification;
  extractedBrand: string | null;
  offCodeCount: number;
  /** Top-3 OFF codes (by code lexical order, stable) for spot-check. */
  topCandidates: Array<{ code: string; brand: string }>;
  reason: string;
}

/**
 * Try to find the longest OFF brand matching at a word boundary in the
 * heading. Returns the matched brand string (canonical form from the index)
 * or null if nothing matched. Multi-word brands are supported via the
 * first-token index; for each candidate we verify the remaining tokens match.
 */
export function extractBrand(
  cleaned: string,
  tokens: string[],
  index: BrandIndex
): string | null {
  let best: { brand: string; length: number } | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const firstTok = tokens[i];
    const list = index.byFirstToken.get(firstTok);
    if (!list) continue;

    // For each candidate brand starting with this token, check if the
    // heading tokens[i..i+brandWordCount-1] match all brand words. We want
    // the longest match anywhere in the heading (not just position 0).
    for (const entry of list) {
      const brandWords = entry.fullBrand.split(" ");
      const brandLen = brandWords.length;
      if (i + brandLen > tokens.length) continue;
      let ok = true;
      for (let j = 0; j < brandLen; j++) {
        if (tokens[i + j] !== brandWords[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (!best || brandLen > best.length) {
        best = { brand: entry.fullBrand, length: brandLen };
      }
    }
  }

  return best?.brand ?? null;
}

export function classify(
  prep: PreprocessedHeading,
  brand: string | null,
  index: BrandIndex
): HeadingResult {
  // Brand extraction wins over the fresh heuristic. Rationale: a heading
  // like "Rynkeby Frugt Frisk Nektar" contains the marker "frisk" but
  // Rynkeby is a real brand; OFF should be able to identify it. We only
  // fall through to the fresh heuristic when no brand can be extracted.
  if (brand) {
    const codes = index.byFullBrand.get(brand);
    const codeCount = codes?.size ?? 0;
    const sorted = codes ? Array.from(codes).sort().slice(0, 3) : [];
    const topCandidates = sorted.map((c) => ({ code: c, brand }));

    if (codeCount === 1) {
      return {
        raw: prep.raw,
        cleaned: prep.cleaned,
        classification: "unique_match",
        extractedBrand: brand,
        offCodeCount: 1,
        topCandidates,
        reason: `exactly 1 OFF product with brand "${brand}"`,
      };
    }
    if (codeCount > 1) {
      return {
        raw: prep.raw,
        cleaned: prep.cleaned,
        classification: "ambiguous_match",
        extractedBrand: brand,
        offCodeCount: codeCount,
        topCandidates,
        reason: `${codeCount} OFF products share brand "${brand}"`,
      };
    }
    return {
      raw: prep.raw,
      cleaned: prep.cleaned,
      classification: "no_brand",
      extractedBrand: brand,
      offCodeCount: 0,
      topCandidates: [],
      reason: `brand "${brand}" parsed from heading but no OFF product uses it`,
    };
  }

  if (prep.isFresh) {
    return {
      raw: prep.raw,
      cleaned: prep.cleaned,
      classification: "not_in_scope",
      extractedBrand: null,
      offCodeCount: 0,
      topCandidates: [],
      reason: "matches a fresh/unbarcoded marker (frisk/økologisk/...)",
    };
  }

  return {
    raw: prep.raw,
    cleaned: prep.cleaned,
    classification: "no_brand",
    extractedBrand: null,
    offCodeCount: 0,
    topCandidates: [],
    reason:
      prep.tokens.length === 0
        ? "heading reduces to empty after cleaning"
        : "no OFF brand matched at a word boundary",
  };
}

export function classifyHeading(raw: string, index: BrandIndex): HeadingResult {
  const prep = preprocess(raw);
  const brand = extractBrand(prep.cleaned, prep.tokens, index);
  return classify(prep, brand, index);
}

// ---------------------------------------------------------------------------
// D1 read
// ---------------------------------------------------------------------------

interface OfferRow {
  id: string;
  heading: string;
  normalized_id: number | null;
  is_split: number;
}

async function readAllOffers(db: DbClient): Promise<OfferRow[]> {
  return db.all<OfferRow>(
    `SELECT id, heading, normalized_id, is_split
     FROM offers
     ORDER BY id`
  );
}

function inRegexCluster(o: OfferRow): boolean {
  return o.normalized_id !== null && o.is_split === 0;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

interface PopulationReport {
  label: string;
  total: number;
  unique_match: HeadingResult[];
  ambiguous_match: HeadingResult[];
  no_brand: HeadingResult[];
  not_in_scope: HeadingResult[];
}

function summarize(label: string, results: HeadingResult[]): PopulationReport {
  return {
    label,
    total: results.length,
    unique_match: results.filter((r) => r.classification === "unique_match"),
    ambiguous_match: results.filter(
      (r) => r.classification === "ambiguous_match"
    ),
    no_brand: results.filter((r) => r.classification === "no_brand"),
    not_in_scope: results.filter((r) => r.classification === "not_in_scope"),
  };
}

function uniqueHits(r: PopulationReport): number {
  return r.unique_match.length;
}

function headlineMetric(r: PopulationReport): number {
  if (r.total === 0) return 0;
  return uniqueHits(r) / r.total;
}

function topN<T>(arr: T[], n: number): T[] {
  return arr.slice(0, n);
}

function topByCleanedLength(results: HeadingResult[], n: number): HeadingResult[] {
  // For the report we want reviewers to see the *most informative* samples —
  // long cleaned headings reveal more about brand positioning than single
  // words. Sort by -cleaned.length, break ties by raw alpha for stability.
  return [...results]
    .sort((a, b) => {
      const dl = b.cleaned.length - a.cleaned.length;
      return dl !== 0 ? dl : a.raw.localeCompare(b.raw);
    })
    .slice(0, n);
}

function fmtHeadings(rs: HeadingResult[]): string {
  if (rs.length === 0) return "_(none)_";
  return rs
    .map(
      (r) =>
        `- \`${r.raw.replace(/\|/g, "\\|")}\` → ${r.offCodeCount === 1 ? "OFF `" + r.topCandidates[0].code + "`" : "no single OFF code"} ` +
        `_(reason: ${r.reason})_`
    )
    .join("\n");
}

/**
 * Map the (all-offers, regex-clustered) headline pair to one of the three
 * decision branches in the issue spec:
 *
 *   1. Proceed — both populations ≥ 50% unique hit
 *   2. Keep regex — regex-clustered unique-hit < 50% but overall ≥ 50%
 *   3. Abandon per-brand aggregation; explore category-only view — both < 50%
 *
 * Q5 in the issue ("threshold for the all-offers population") specifies that
 * if all-offers is below 50% but regex-clustered is good we still proceed
 * (asymmetric pass). That is folded into branch 1 with a flagged caveat in
 * the body text.
 */
function recommendation(
  all: PopulationReport,
  regex: PopulationReport
): { decision: string; body: string } {
  const allHit = headlineMetric(all);
  const regexHit = headlineMetric(regex);
  const allOk = allHit >= UNIQUE_HIT_THRESHOLD;
  const regexOk = regexHit >= UNIQUE_HIT_THRESHOLD;

  if (regexOk && allOk) {
    return {
      decision:
        "Proceed with simplification (both populations ≥ 50% unique hit)",
      body:
        `Both headline metrics clear the 50% threshold (all=${pct(uniqueHits(all), all.total)}, ` +
        `regex-clustered=${pct(uniqueHits(regex), regex.total)}). The regex cluster layer can be ` +
        `replaced with OFF matching. Drop M3 Pass 2 + Pass 3.`,
    };
  }
  if (regexOk && !allOk) {
    // Q5: proceed if the load-bearing regex-clustered headline passes.
    return {
      decision:
        "Proceed with simplification (both populations ≥ 50% unique hit)",
      body:
        `Heads up: the all-offers headline is below 50% (${pct(uniqueHits(all), all.total)}), ` +
        `but the load-bearing regex-clustered headline passes (${pct(uniqueHits(regex), regex.total)}). ` +
        `Per Q5 of the issue, still proceed — most offers we care about (those that cluster) are ` +
        `identifiable. The unclustered tail (LLM-only / single-offer headings) will need a ` +
        `fallback strategy; flag this in the follow-up milestone.`,
    };
  }
  if (!regexOk && allOk) {
    return {
      decision:
        "Keep regex as fallback (regex-clustered unique-hit < 50% but overall ≥ 50%)",
      body:
        `Mixed signal: all-offers headline passes (${pct(uniqueHits(all), all.total)}) but the ` +
        `load-bearing regex-clustered headline is below 50% (${pct(uniqueHits(regex), regex.total)}). ` +
        `Per the issue spec this means the regex cluster layer was doing real work and the ` +
        `simplification is the wrong move. Keep regex as a fallback layer.`,
    };
  }
  return {
    decision:
      "Abandon per-brand aggregation; explore category-only view (both < 50%)",
    body:
      `Both headlines are below 50% (all=${pct(uniqueHits(all), all.total)}, ` +
      `regex-clustered=${pct(uniqueHits(regex), regex.total)}). OFF matching is not a viable ` +
      `identity layer. Explore aggregating by category only.`,
  };
}

function buildReport(
  index: BrandIndex,
  all: PopulationReport,
  regex: PopulationReport,
  spotChecks: HeadingResult[]
): string {
  const rec = recommendation(all, regex);

  const allHitPct = pct(uniqueHits(all), all.total);
  const regexHitPct = pct(uniqueHits(regex), regex.total);

  const decisionLines = [
    "Proceed with simplification (both populations ≥ 50% unique hit)",
    "Keep regex as fallback (regex-clustered unique-hit < 50% but overall ≥ 50%)",
    "Abandon per-brand aggregation; explore category-only view (both < 50%)",
  ];
  // Render each option as a `- [x]` or `- [ ]` checkbox. The one matching
  // `rec.decision` is checked.
  const decisionsRendered = decisionLines
    .map((d) =>
      d === rec.decision ? `- [x] ${d}` : `- [ ] ${d}`
    )
    .join("\n");

  const lines: string[] = [];
  lines.push(`# OFF coverage spike — ${today()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `- All offers sampled: **${all.total}** (issue baseline: 9,710+)`
  );
  lines.push(
    `- Regex-clustered subset sampled: **${regex.total}** (issue baseline: 1,396 clusters)` +
      (regex.total > 0
        ? ` — note: the issue's "1,396" referred to distinct cluster IDs in \`offers_normalized\`; this count is the number of *offer rows* returned by \`normalized_id IS NOT NULL AND is_split = 0\`, which has grown.`
        : "")
  );
  lines.push(
    `- Unique OFF brands in dictionary: **${index.byFullBrand.size}** (from **${index.totalRows}** OFF rows, **${index.rowsWithBrand}** with a non-empty \`brands_tags\`)`
  );
  lines.push(
    `- Country filter: ${COUNTRY_TAGS.map((c) => `\`${c}\``).join(", ")}`
  );
  lines.push("");
  lines.push("### Headline metrics");
  lines.push("");
  lines.push(
    `- **Headline 1 — all offers** unique-hit = **${allHitPct}** (${uniqueHits(all)} / ${all.total}). Threshold for proceed: **${UNIQUE_HIT_THRESHOLD * 100}%**.`
  );
  lines.push(
    `- **Headline 2 — regex-clustered subset** unique-hit = **${regexHitPct}** (${uniqueHits(regex)} / ${regex.total}). Threshold for proceed: **${UNIQUE_HIT_THRESHOLD * 100}%** _(load-bearing number — see issue)._`
  );
  lines.push("");
  lines.push("### All-offers category counts");
  lines.push("");
  lines.push(`| category | count | share |`);
  lines.push(`|----------|------:|------:|`);
  lines.push(`| unique_match | ${all.unique_match.length} | ${pct(all.unique_match.length, all.total)} |`);
  lines.push(`| ambiguous_match | ${all.ambiguous_match.length} | ${pct(all.ambiguous_match.length, all.total)} |`);
  lines.push(`| no_brand | ${all.no_brand.length} | ${pct(all.no_brand.length, all.total)} |`);
  lines.push(`| not_in_scope | ${all.not_in_scope.length} | ${pct(all.not_in_scope.length, all.total)} |`);
  lines.push("");
  lines.push("### Regex-clustered category counts");
  lines.push("");
  lines.push(`| category | count | share |`);
  lines.push(`|----------|------:|------:|`);
  lines.push(`| unique_match | ${regex.unique_match.length} | ${pct(regex.unique_match.length, regex.total)} |`);
  lines.push(`| ambiguous_match | ${regex.ambiguous_match.length} | ${pct(regex.ambiguous_match.length, regex.total)} |`);
  lines.push(`| no_brand | ${regex.no_brand.length} | ${pct(regex.no_brand.length, regex.total)} |`);
  lines.push(`| not_in_scope | ${regex.not_in_scope.length} | ${pct(regex.not_in_scope.length, regex.total)} |`);
  lines.push("");
  lines.push("## Decision");
  lines.push("");
  lines.push(decisionsRendered);
  lines.push("");
  lines.push(`**Recommended:** ${rec.body}`);
  lines.push("");
  lines.push("## Detail by category");
  lines.push("");
  lines.push("### All offers");
  lines.push("");
  lines.push(`Top ${Math.min(5, all.unique_match.length)} unique hits:`);
  lines.push("");
  lines.push(fmtHeadings(topByCleanedLength(all.unique_match, 5)));
  lines.push("");
  lines.push(`Top ${Math.min(5, all.ambiguous_match.length)} ambiguous matches (most informative):`);
  lines.push("");
  lines.push(fmtHeadings(topByCleanedLength(all.ambiguous_match, 5)));
  lines.push("");
  lines.push(`Top ${Math.min(5, all.no_brand.length)} no_brand misses (most informative):`);
  lines.push("");
  lines.push(fmtHeadings(topByCleanedLength(all.no_brand, 5)));
  lines.push("");
  lines.push(`Top ${Math.min(5, all.not_in_scope.length)} not_in_scope samples:`);
  lines.push("");
  lines.push(fmtHeadings(topByCleanedLength(all.not_in_scope, 5)));
  lines.push("");
  lines.push("### Regex-clustered subset");
  lines.push("");
  lines.push(`Top ${Math.min(5, regex.unique_match.length)} unique hits:`);
  lines.push("");
  lines.push(fmtHeadings(topByCleanedLength(regex.unique_match, 5)));
  lines.push("");
  lines.push(`Top ${Math.min(5, regex.ambiguous_match.length)} ambiguous matches (most informative):`);
  lines.push("");
  lines.push(fmtHeadings(topByCleanedLength(regex.ambiguous_match, 5)));
  lines.push("");
  lines.push(`Top ${Math.min(5, regex.no_brand.length)} no_brand misses (most informative):`);
  lines.push("");
  lines.push(fmtHeadings(topByCleanedLength(regex.no_brand, 5)));
  lines.push("");
  lines.push(`Top ${Math.min(5, regex.not_in_scope.length)} not_in_scope samples:`);
  lines.push("");
  lines.push(fmtHeadings(topByCleanedLength(regex.not_in_scope, 5)));
  lines.push("");
  lines.push("## Spot-check log");
  lines.push("");
  lines.push(
    "20 samples drawn across categories (5 unique, 5 ambiguous, 5 no_brand, 5 not_in_scope). " +
      "The expected answer is whether the top-3 OFF candidates look like the right product on the OFF website."
  );
  lines.push("");
  lines.push("| # | category | heading | cleaned | top-3 OFF candidates |");
  lines.push("|--:|----------|---------|---------|----------------------|");
  spotChecks.forEach((r, i) => {
    const cands =
      r.topCandidates.length === 0
        ? "_(none)_"
        : r.topCandidates.map((c) => `\`${c.code}\``).join(", ");
    lines.push(
      `| ${i + 1} | ${r.classification} | \`${r.raw.replace(/\|/g, "\\|")}\` | \`${r.cleaned}\` | ${cands} |`
    );
  });
  lines.push("");
  lines.push("## Methodology");
  lines.push("");
  lines.push(
    "- **Brand dictionary**: built from OFF `brands_tags` for rows whose `countries_tags` include one of " +
      COUNTRY_TAGS.join(", ") +
      ". The tag language prefix (`en:`, `xx:`) is stripped, then the remaining string is normalized " +
      "(lowercase, NFC, connector apostrophes dropped, remaining punctuation → space, whitespace collapsed)."
  );
  lines.push(
    "- **Heading preprocessing**: lowercase, NFC, connector apostrophes dropped, remaining punctuation → space, " +
      "whitespace collapsed + trim. Quantity prefixes (\"1,2 kg\", \"2x\", \"500 g\") are stripped from the head. " +
      "Trailing \"- max X,XX\" suffixes are stripped. **Unit tokens (g, kg, ml, l, cl, stk, %, ...) and pure-number tokens " +
      "(e.g. \"8\", \"12\") are dropped before brand extraction** — one OFF row has `xx:kg` as a brand tag, so leaving " +
      "unit tokens in the search corpus would let the algorithm lock onto a unit token instead of the real brand."
  );
  lines.push(
    "- **Fresh / unbarcoded heuristic**: if the cleaned heading contains any of " +
      FRESH_MARKERS.map((m) => `\`${m}\``).join(", ") +
      " (as a whole word) **and** no OFF brand matched at a word boundary, the heading is " +
      "classified `not_in_scope`. The brand-first order means a heading like " +
      "`Rynkeby Frugt Frisk Nektar` is not thrown out as fresh even though it contains " +
      "`frisk` — Rynkeby is a brand and OFF carries it. Heuristic is intentionally short."
  );
  lines.push(
    "- **Brand extraction**: tokenize the cleaned heading on whitespace. At each token position, look up " +
      "brands whose first token matches; for each candidate, verify the remaining tokens match (case-folded). " +
      "Take the longest match anywhere in the heading. Multi-word brands (e.g. `ritter sport`) are supported."
  );
  lines.push(
    "- **Classification**: `unique_match` = exactly 1 OFF product with the extracted brand in the filtered " +
      "country set; `ambiguous_match` = ≥ 2; `no_brand` = brand extracted but 0 OFF products (or no brand could " +
      "be extracted); `not_in_scope` = fresh/unbarcoded heuristic fired."
  );
  lines.push(
    "- **Two populations measured**: every row in \`offers\` (\"all offers\") and every row with " +
      "\`normalized_id IS NOT NULL AND is_split = 0\` (\"regex-clustered subset\")."
  );
  lines.push("");
  lines.push("## Reproduction");
  lines.push("");
  lines.push("```bash");
  lines.push("# 1. Download OFF food dump (~7.3 GB compressed) into data/off.parquet");
  lines.push("curl -L -o data/off.parquet \\");
  lines.push("  https://huggingface.co/datasets/openfoodfacts/product-database/resolve/main/food.parquet");
  lines.push("");
  lines.push("# 2. Filter to the seven countries → NDJSON (≈60 MB)");
  lines.push("duckdb -c \"");
  lines.push("COPY (");
  lines.push("  SELECT code, brands, brands_tags");
  lines.push("  FROM read_parquet('data/off.parquet')");
  lines.push("  WHERE list_contains(countries_tags, 'en:denmark')");
  lines.push("     OR list_contains(countries_tags, 'en:sweden')");
  lines.push("     OR list_contains(countries_tags, 'en:norway')");
  lines.push("     OR list_contains(countries_tags, 'en:finland')");
  lines.push("     OR list_contains(countries_tags, 'en:germany')");
  lines.push("     OR list_contains(countries_tags, 'en:netherlands')");
  lines.push("     OR list_contains(countries_tags, 'en:united-kingdom')");
  lines.push(") TO 'data/off-dk-neighbours.jsonl' (FORMAT JSON)");
  lines.push("\"");
  lines.push("");
  lines.push("# 3. Run the spike against live D1 (read-only)");
  lines.push("DB_MODE=d1 \\");
  lines.push("  CLOUDFLARE_ACCOUNT_ID=... \\");
  lines.push("  CLOUDFLARE_D1_DATABASE_ID=... \\");
  lines.push("  CLOUDFLARE_API_TOKEN=... \\");
  lines.push("  pnpm tsx scripts/off-coverage-spike.ts");
  lines.push("");
  lines.push("# 4. Open the report");
  lines.push(`cat data/off-coverage-spike-${today()}.md`);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Spot-check sampling
// ---------------------------------------------------------------------------

function sampleSpotChecks(
  all: HeadingResult[],
  regex: HeadingResult[]
): HeadingResult[] {
  // Deterministic sampling: take top-N (by cleaned length) of each category
  // from the regex-clustered population first, since that's the load-bearing
  // number. Falls back to all-offers if a category is empty in regex.
  // Dedup by raw heading so reviewers don't see the same heading twice
  // (the regex-clustered subset is heavy on near-duplicates).
  const picks: HeadingResult[] = [];
  const seenRaw = new Set<string>();
  const take = (src: HeadingResult[], n: number) => {
    const sorted = topByCleanedLength(src, n);
    for (const r of sorted) {
      if (picks.length >= 20) break;
      if (seenRaw.has(r.raw)) continue;
      seenRaw.add(r.raw);
      picks.push(r);
    }
  };
  const takeN = (category: Classification, n: number) => {
    take(
      regex.filter((r) => r.classification === category && !seenRaw.has(r.raw)),
      n
    );
    if (picks.filter((r) => r.classification === category).length < n) {
      const have = picks.filter((r) => r.classification === category).length;
      take(
        all.filter(
          (r) => r.classification === category && !seenRaw.has(r.raw)
        ),
        n - have
      );
    }
  };
  takeN("unique_match", 5);
  takeN("ambiguous_match", 5);
  takeN("no_brand", 5);
  takeN("not_in_scope", 5);
  return picks.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log("[off-coverage-spike] starting...");
  console.log(`[off-coverage-spike] building brand dictionary from ${OFF_NDJSON_PATH}`);
  const tIndex = Date.now();
  const index = await buildBrandDictionary(OFF_NDJSON_PATH);
  console.log(
    `[off-coverage-spike]   indexed ${index.totalRows} OFF rows → ${index.byFullBrand.size} unique brands (${Date.now() - tIndex} ms)`
  );

  console.log("[off-coverage-spike] reading live D1 (read-only)");
  const tDb = Date.now();
  const db = await createDb();
  let offers: OfferRow[];
  try {
    offers = await readAllOffers(db);
  } finally {
    await db.close();
  }
  console.log(
    `[off-coverage-spike]   read ${offers.length} offers (${Date.now() - tDb} ms)`
  );

  const regexSubset = offers.filter(inRegexCluster);
  console.log(
    `[off-coverage-spike]   ${regexSubset.length} rows match the regex-clustered filter`
  );

  const tClassify = Date.now();
  const allResults = offers.map((o) => classifyHeading(o.heading, index));
  const regexResults = regexSubset.map((o) => classifyHeading(o.heading, index));
  console.log(
    `[off-coverage-spike]   classified ${allResults.length} + ${regexResults.length} headings (${Date.now() - tClassify} ms)`
  );

  const allReport = summarize("all", allResults);
  const regexReport = summarize("regex-clustered", regexResults);

  const spotChecks = sampleSpotChecks(allResults, regexResults);

  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const md = buildReport(index, allReport, regexReport, spotChecks);
  writeFileSync(REPORT_PATH, md);

  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[off-coverage-spike] wrote report to ${REPORT_PATH} (${seconds}s total)`);
  console.log(
    `[off-coverage-spike] Headline 1 (all): unique_hit = ${pct(uniqueHits(allReport), allReport.total)}`
  );
  console.log(
    `[off-coverage-spike] Headline 2 (regex-clustered): unique_hit = ${pct(uniqueHits(regexReport), regexReport.total)}`
  );
}

// Guard so this module can be imported by tests without running main(). Same
// pattern as src/normalize/regex.cli.ts.
const isMainModule = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  await main();
}
