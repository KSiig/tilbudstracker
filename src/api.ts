import type { ApiDealer, ApiCatalog, ApiOffer } from "./types.js";

const BASE_URL = "https://squid-api.tjek.com/v2";
const MAX_PAGE_SIZE = 100;

/**
 * Thrown by the Tjek client when the API responds with HTTP 429 (rate
 * limited) or returns a Retry-After hint. The HTTP handler maps this to
 * 503 + Retry-After: 60 (decision B3).
 */
export class TjekRateLimitError extends Error {
  constructor(message: string, public readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "TjekRateLimitError";
  }
}

const API_KEY: string = (() => {
  const key = process.env.TJEK_API_KEY;
  if (!key) {
    throw new Error("Missing required environment variable: TJEK_API_KEY");
  }
  return key;
})();

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      "x-api-key": API_KEY,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`API ${res.status} for ${url}: ${await res.text()}`);
  }

  return res.json() as Promise<T>;
}

export async function fetchDealers(): Promise<ApiDealer[]> {
  const all: ApiDealer[] = [];
  let offset = 0;

  while (true) {
    const page = await fetchJson<ApiDealer[]>(
      `/dealers?limit=${MAX_PAGE_SIZE}&offset=${offset}`
    );

    all.push(...page);

    if (page.length < MAX_PAGE_SIZE) break;
    offset += MAX_PAGE_SIZE;
  }

  return all;
}

export async function fetchCatalogs(dealerId: string): Promise<ApiCatalog[]> {
  return fetchJson<ApiCatalog[]>(
    `/catalogs?dealer_id=${encodeURIComponent(dealerId)}`
  );
}

export async function fetchAllOffers(catalogId: string): Promise<ApiOffer[]> {
  const all: ApiOffer[] = [];
  let offset = 0;

  while (true) {
    const page = await fetchJson<ApiOffer[]>(
      `/offers?catalog_ids=${encodeURIComponent(catalogId)}&limit=${MAX_PAGE_SIZE}&offset=${offset}`
    );

    all.push(...page);

    if (page.length < MAX_PAGE_SIZE) break;
    offset += MAX_PAGE_SIZE;
  }

  return all;
}
