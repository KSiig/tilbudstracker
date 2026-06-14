import type { ApiDealer, ApiCatalog, ApiOffer } from "./types.js";

const BASE_URL = "https://squid-api.tjek.com/v2";
const API_KEY = "152000596c6e45d9983eab0c14afebea";
const MAX_PAGE_SIZE = 100;

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
