import { describe, expect, it } from "vitest";
import { trivialNormalize } from "./regex.js";

describe("trivialNormalize (Pass 2 fold)", () => {
  it("lowercases all-caps headings", () => {
    expect(trivialNormalize("BUKO Smelteost")).toBe("buko smelteost");
  });

  it("strips apostrophes (connector) and replaces hyphens with spaces (separator)", () => {
    // The spec example: `' -> empty`, `- -> space`. Two-step fold.
    expect(trivialNormalize("Buko's Smelte-ost")).toBe("bukos smelte ost");
    // Standalone apostrophe contractions also fold without splitting.
    expect(trivialNormalize("L'oreal")).toBe("loreal");
  });

  it("collapses runs of whitespace into a single space and trims", () => {
    expect(trivialNormalize("Cheasy   yoghurt")).toBe("cheasy yoghurt");
    expect(trivialNormalize("  leading and trailing  ")).toBe(
      "leading and trailing"
    );
  });

  it("preserves Danish letters (ø, æ, å) — Unicode-aware, no ASCII \\\\w", () => {
    expect(trivialNormalize("Kalvekød")).toBe("kalvekød");
    expect(trivialNormalize("Hakket Gris og Lammefår")).toBe(
      "hakket gris og lammefår"
    );
    expect(trivialNormalize("Lærkebryst")).toBe("lærkebryst");
  });

  it("NFC-normalizes combining-form variants so they collapse", () => {
    // `é` as precomposed (U+00E9) vs decomposed (`e` + U+0301) must fold equal.
    const precomposed = "Café";
    const decomposed = "Cafe\u0301";
    expect(precomposed).not.toBe(decomposed);
    expect(trivialNormalize(precomposed)).toBe(trivialNormalize(decomposed));
  });

  it("treats punctuation as a separator without merging adjacent words", () => {
    expect(trivialNormalize("Buko,Smelteost")).toBe("buko smelteost");
    expect(trivialNormalize("A/B test")).toBe("a b test");
  });
});
