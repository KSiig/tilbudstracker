# Tilbudstracker

Track Danish grocery offer prices from [etilbudsavis.dk](https://etilbudsavis.dk) over time.

The site only exposes current/upcoming offers — once a catalog expires, its data is gone. This scraper captures offers into a local SQLite database so you can build price history over time.

## Quick start

```bash
pnpm install
pnpm scrape          # sync all stores from the API
pnpm stores          # list stores — find the ID of the one you want
pnpm track 9ba51     # enable tracking for Netto
pnpm scrape          # now scrapes Netto's current catalogs + offers
pnpm stats           # see what's in the database
```

## Commands

| Command | Description |
|---------|-------------|
| `pnpm scrape` | Sync stores, then scrape all offers from tracked stores |
| `pnpm stores` | List all stores with tracking status |
| `pnpm track <id>` | Enable tracking for a store |
| `pnpm untrack <id>` | Disable tracking for a store |
| `pnpm stats` | Show database statistics |

## How it works

1. **Store sync**: fetches all dealers from the Tjek API and upserts them into the `stores` table. New stores are auto-discovered and logged.
2. **Catalog scrape**: for each tracked store, fetches current catalogs. Skips catalogs already in the database.
3. **Offer scrape**: for each new catalog, paginates through all offers and stores them with raw quantity data.
4. **Unit price computation**: computes a best-effort price-per-unit (DKK/kg or DKK/liter) from the structured quantity fields:
   - `exact` — size and piece count are fixed, unit price is precise
   - `range_max` — size is a range (e.g. 400-750g), unit price uses smallest size (worst case)
   - `pcs` — unit is "pieces", price is per piece
   - `unknown` — insufficient data

## Unit price normalization

~35% of offers have ambiguous unit pricing (size ranges, "pcs" units with weight info only in the description text). The schema includes `normalizedUnitPrice`, `normalizedAt`, and `normalizationNote` fields for an LLM normalization pass.

## Running as a CronJob

Build the Docker image and schedule it in Kubernetes:

```bash
docker build -t tilbudstracker .
```

The container runs `node dist/cli.js scrape` by default. Mount a persistent volume at `/app/data` to retain the SQLite database between runs.

## Not yet implemented

- **LLM normalization cronjob** — a separate AI-enabled job to normalize ambiguous unit prices weekly
- **Kubernetes manifests** — CronJob + PVC definitions for k3s deployment
- **Web UI / reporting** — querying and visualizing price trends

## Database

SQLite database at `data/tilbud.db`. Key tables:

- `stores` — all known stores, with `isTracked` flag
- `catalogs` — catalog metadata with publish dates and validity windows
- `offers` — individual offers with raw quantity data, computed unit prices, and LLM normalization fields
