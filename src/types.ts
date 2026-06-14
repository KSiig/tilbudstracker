export interface ApiDealer {
  id: string;
  name: string;
  website: string | null;
  logo: string | null;
  color: string | null;
  category_ids: string[];
  country: { id: string };
}

export interface ApiCatalog {
  id: string;
  label: string | null;
  run_from: string;
  run_till: string;
  publish: string;
  page_count: number;
  offer_count: number;
  dealer_id: string;
  branding: {
    name: string;
  };
}

export interface ApiOffer {
  id: string;
  heading: string;
  description: string | null;
  catalog_page: number | null;
  catalog_id?: string;
  pricing: {
    price: number;
    pre_price: number | null;
    currency: string;
  };
  quantity: {
    unit: {
      symbol: string;
      si: {
        symbol: string;
        factor: number;
      };
    };
    size: {
      from: number;
      to: number;
    };
    pieces: {
      from: number;
      to: number;
      min: number | null;
      max: number | null;
    };
  };
  images: {
    view: string | null;
  };
  run_from: string;
  run_till: string;
  dealer_id: string;
}

export type UnitPriceKind = "exact" | "range_max" | "pcs" | "unknown";

export interface ComputedUnitPrice {
  value: number | null;
  kind: UnitPriceKind;
}
