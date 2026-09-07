import { describe, expect, it } from "vitest";
import { isBundle, parseBundle } from "./bundle.js";

const KYLING_BUNDLE =
  "1,2 kg Hakket Dansk Grise- og Kalvekød 8-12 %, 900-1200 g Hamburgerryg af Dansk Gris eller 1,8 kg Rose Dansk Hel Kylling";

const KYLING_BUNDLE_UPPER =
  "1,2 KG HAKKET DANSK GRISE- OG KALVEKØD 8-12 %, 900-1200 G HAMBURGERRYG AF DANSK GRIS ELLER 1,8 KG ROSE DANSK HEL KYLLING";

describe("isBundle", () => {
  it("matches the kylling bundle heading (mixed case)", () => {
    expect(isBundle(KYLING_BUNDLE)).toBe(true);
  });

  it("matches the kylling bundle heading (all-caps, case-insensitive ELLER)", () => {
    expect(isBundle(KYLING_BUNDLE_UPPER)).toBe(true);
  });

  it("rejects 'kyllingebrystfilet eller -inderfilet' (no unit token)", () => {
    expect(isBundle("kyllingebrystfilet eller -inderfilet")).toBe(false);
  });

  it("rejects plain non-bundle offers", () => {
    expect(isBundle("Cheasy yoghurt")).toBe(false);
  });

  it("rejects 'X eller Y' where neither side has a unit token", () => {
    expect(isBundle("Hakket kød eller kylling")).toBe(false);
  });
});

describe("parseBundle", () => {
  it("splits the kylling bundle into the 3 expected per-product strings", () => {
    const segments = parseBundle(KYLING_BUNDLE);
    expect(segments).toEqual([
      "1,2 kg Hakket Dansk Grise- og Kalvekød 8-12 %",
      "900-1200 g Hamburgerryg af Dansk Gris",
      "1,8 kg Rose Dansk Hel Kylling",
    ]);
  });

  it("splits the all-caps variant the same way", () => {
    const segments = parseBundle(KYLING_BUNDLE_UPPER);
    expect(segments).toEqual([
      "1,2 KG HAKKET DANSK GRISE- OG KALVEKØD 8-12 %",
      "900-1200 G HAMBURGERRYG AF DANSK GRIS",
      "1,8 KG ROSE DANSK HEL KYLLING",
    ]);
  });

  it("preserves Danish decimal commas inside a single segment (does not split on bare ',')", () => {
    // "1,2 kg Hakket ..." must NOT become ["1", "2 kg Hakket ..."]
    const segments = parseBundle(
      "1,2 kg Hakket Dansk Gris eller 1,8 kg Rose Kylling"
    );
    expect(segments).toEqual([
      "1,2 kg Hakket Dansk Gris",
      "1,8 kg Rose Kylling",
    ]);
  });

  it("drops empty segments after trimming", () => {
    const segments = parseBundle("  Foo eller   Bar eller Baz  ");
    expect(segments).toEqual(["Foo", "Bar", "Baz"]);
  });
});
