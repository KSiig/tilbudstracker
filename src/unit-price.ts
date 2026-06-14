import type { ApiOffer, ComputedUnitPrice } from "./types.js";

export function computeUnitPrice(offer: ApiOffer): ComputedUnitPrice {
  const { quantity, pricing } = offer;
  if (!quantity?.unit?.si || !quantity.size || !quantity.pieces) {
    return { value: null, kind: "unknown" };
  }

  const { si } = quantity.unit;
  const { from: sizeFrom, to: sizeTo } = quantity.size;
  const { from: piecesFrom } = quantity.pieces;

  if (!sizeFrom || !si.factor || !piecesFrom) {
    return { value: null, kind: "unknown" };
  }

  const totalSi = sizeFrom * si.factor * piecesFrom;
  if (totalSi <= 0) {
    return { value: null, kind: "unknown" };
  }

  const unitPrice = pricing.price / totalSi;

  if (si.symbol === "pcs") {
    return { value: unitPrice, kind: "pcs" };
  }

  const isExactSize = sizeFrom === sizeTo;
  const isExactPieces = quantity.pieces.from === quantity.pieces.to;

  if (isExactSize && isExactPieces) {
    return { value: unitPrice, kind: "exact" };
  }

  return { value: unitPrice, kind: "range_max" };
}
