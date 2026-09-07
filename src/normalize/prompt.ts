/**
 * Build the LLM clustering prompt for a batch of Danish grocery offer headings.
 *
 * The prompt is locked by SII-73 (Pass 3) — do not change the wording without
 * re-validating the POC. The bundle-handling bullet from the original POC prompt
 * is intentionally removed: SII-72 (Pass 1) splits bundles before Pass 3 ever
 * sees them, so all inputs are `is_split = 0` per-product rows.
 */
export function buildPrompt(headings: string[]): string {
  const lines = headings.map((h, i) => `${i}. ${h}`).join("\n");
  return `You cluster Danish grocery offer headings. Your job: identify which headings describe the SAME physical product.

Output JSON only, in this exact shape:
{{
  "clusters": [
    {{"title": "<canonical short product name>", "member_indices": [0, 2, 3]}}
  ]
}}

Rules:
- A heading belongs to AT MOST ONE cluster.
- Be conservative: only cluster headings you are SURE refer to the same product.
- "Dansk hel kylling" and "Rose Fersk Dansk Hel Kylling" = SAME (whole chicken, rose brand).
- "Dansk hel kylling" and "Rose hakket dansk kyllingekød" = DIFFERENT (whole vs ground).
- Headings you are unsure about: omit them (return no cluster for them).

Input headings:
${lines}`;
}
