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
 * Splits a bundle heading into its per-product segments, trimmed and with
 * empty entries dropped. Uses `,\s+` as the comma separator (Danish decimal
 * safety). Throws `BundleParseError` if any non-empty segment lacks a unit
 * token (kg / g / l / cl / ml / stk) — those are not addressable per-product
 * rows, so the whole heading is rejected. The original caller (`isBundle`)
 * catches the error and returns `false`.
 *
 * Empty segments (e.g. trailing commas, repeated whitespace) are still
 * dropped silently — only non-empty segments must carry a unit.
 */
export function parseBundle(heading: string): string[] {
  const segments = heading
    .split(ELLER)
    .flatMap((s) => s.split(/,\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const seg of segments) {
    if (!UNIT_TOKENS.test(seg)) {
      throw new BundleParseError(
        `bundle segment "${seg}" lacks a unit token (kg/g/l/cl/ml/stk); rejecting whole heading: ${heading}`
      );
    }
  }
  return segments;
}

/**
 * Thrown by {@link parseBundle} when a non-empty segment is missing a unit
 * token. {@link isBundle} catches this and returns `false`; the CLI surfaces
 * it to the operator.
 */
export class BundleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleParseError";
  }
}

/**
 * Returns true if the heading describes a multi-product bundle under one
 * price AND every per-product segment carries a unit token. The unit-token
 * requirement applies to each segment individually, not just to the whole
 * heading (see Decision C1: a `8-12 %` segment without a unit token is not
 * addressable as a per-product row).
 */
export function isBundle(heading: string): boolean {
  if (!ELLER.test(heading)) return false;
  if (!UNIT_TOKENS.test(heading)) return false;
  let segments: string[];
  try {
    segments = parseBundle(heading);
  } catch (err) {
    if (err instanceof BundleParseError) return false;
    throw err;
  }
  return segments.length >= 2;
}
