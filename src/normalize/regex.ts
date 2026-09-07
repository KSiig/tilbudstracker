/**
 * Trivial Unicode-aware case/punctuation/whitespace fold of an offer heading.
 *
 * The fold is intentionally cheap so it can run on every offer in the local
 * sqlite database without hitting the LLM. It is the Pass 2 step of the M3
 * heading-normalization milestone; Pass 1 (bundles) and Pass 3 (LLM) are
 * separate concerns owned by sibling issues.
 *
 * Design notes:
 * - `NFC` normalization prevents combining-form mismatch (e.g. `é` written as
 *   `e + U+0301` vs the precomposed form). Without this, the same logical
 *   character folds to two different keys depending on the source.
 * - JavaScript `\w` in `[^\w\s]` would strip Danish letters (`ø`, `æ`, `å`).
 *   The Unicode-aware class `/[^\p{L}\p{N}\s]/gu` keeps them; this matters
 *   because the offer sample is in Danish.
 * - Two classes of punctuation are handled differently:
 *   1. **Connector characters** (`'`, `’`, `` ` ``) — dropped without a space.
 *      These mark contractions in Danish/German and would otherwise split a
 *      single word into two fold tokens.
 *   2. **All other non-letter/non-digit/non-space** — replaced with a single
 *      space. Hyphens, slashes, commas, etc. are word separators.
 *   Both classes run before the final whitespace collapse + trim, so
 *   `"Buko's Smelte-ost"` → `"bukos smelte ost"` and `"Cheasy   yoghurt"` →
 *   `"cheasy yoghurt"` both round-trip cleanly.
 */
export function trivialNormalize(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u0027\u2019\u0060]/g, "") // drop connector apostrophes (', ’, `)
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // remaining punctuation → single space
    .replace(/\s+/g, " ") // collapse whitespace runs
    .trim();
}
