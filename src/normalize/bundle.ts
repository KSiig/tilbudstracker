/**
 * Pass 1 — bundle detection.
 *
 * Detects offers describing a CHOICE of multiple products under one price
 * (e.g., the kylling-burgerryg-grisekød bundle). Naive regex would split too
 * aggressively; this module is the strict detector used by `bundle.cli.ts`.
 *
 * Rules (decision C1):
 *   1. The heading must contain " eller " (Danish "or") as a word-separated
 *      token, case-insensitive.
 *   2. The heading must contain at least one unit token (`kg`, `g`, `l`,
 *      `cl`, `ml`, `stk`). This excludes pairings that aren't really
 *      bundles (e.g. "kyllingebrystfilet eller -inderfilet" — same cut, two
 *      parts, no unit).
 *   3. After splitting on " eller " AND `,\s+`, at least two of the resulting
 *      segments must contain a unit token. This is the "≥ 2 segments with
 *      unit" check.
 *
 * Critical: the split separator is `,\s+` (comma-space), NEVER bare `,`.
 * Danish decimals are `1,2 kg` — splitting on bare `,` would shred
 * `"1,2 kg"` into `["1", "2 kg"]`.
 */

const UNIT_TOKENS = /\b(?:kg|g|l|cl|ml|stk)\b/i;
const ELLER = /\s+eller\s+/i;

/**
 * Returns true if the heading describes a multi-product bundle under one
 * price.
 */
export function isBundle(heading: string): boolean {
  if (!ELLER.test(heading)) return false;
  if (!UNIT_TOKENS.test(heading)) return false;
  const segments = heading.split(ELLER).flatMap((s) => s.split(/,\s+/));
  const segmentsWithUnit = segments.filter((s) => UNIT_TOKENS.test(s));
  return segmentsWithUnit.length >= 2;
}

/**
 * Splits a bundle heading into its per-product segments, trimmed and with
 * empty entries dropped. Uses `,\s+` as the comma separator (Danish decimal
 * safety).
 */
export function parseBundle(heading: string): string[] {
  return heading
    .split(ELLER)
    .flatMap((s) => s.split(/,\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}
