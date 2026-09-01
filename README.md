# Tilbudstracker

Track Danish grocery offer prices from [etilbudsavis.dk](https://etilbudsavis.dk) over time.

The site only exposes current/upcoming offers — once a catalog expires, its data is gone. This scraper captures offers into a local SQLite database so you can build price history over time.

## Quick start

```bash
pnpm install         # NOTE: do NOT pass --prod — `better-sqlite3` is in
                     # optionalDependencies and local sqlite needs it
export TJEK_API_KEY=...   # Tjek/etilbudsavis API key
pnpm scrape          # sync all stores from the API
pnpm stores          # list stores — find the ID of the one you want
pnpm track 9ba51     # enable tracking for Netto
pnpm scrape          # now scrapes Netto's current catalogs + offers
pnpm stats           # see what's in the database
```

## Configuration

| Env var | Required for | Notes |
|---------|---------------|-------|
| `TJEK_API_KEY` | always | Tjek/etilbudsavis API key. Startup fails fast if unset. |
| `DB_MODE` | optional | `sqlite` (default) or `d1`. Any other value fails at startup. |
| `CLOUDFLARE_ACCOUNT_ID` | `DB_MODE=d1` | Cloudflare account ID. |
| `CLOUDFLARE_D1_DATABASE_ID` | `DB_MODE=d1` | Target D1 database ID. |
| `CLOUDFLARE_API_TOKEN` | `DB_MODE=d1` | API token with D1 edit permission. |

Schema (`CREATE TABLE IF NOT EXISTS` plus indexes) is applied when the client opens, for both sqlite and d1.

`apply-stores` and `gen-stores` always use local SQLite regardless of `DB_MODE`.

## Commands

| Command | Description |
|---------|-------------|
| `pnpm scrape` | Sync stores, then scrape all offers from tracked stores |
| `pnpm stores` | List all stores with tracking status |
| `pnpm track <id>` | Enable tracking for a store |
| `pnpm track --from=d1 --list-file=<path>` | Bulk-enable tracking for every dealer id listed in `<path>` (one id per line) |
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

## Running as a Cloud Function (GCP)

The repo deploys as a Gen 2 Cloud Function (`tilbudstracker-scrape`) in
`europe-west1`, invoked daily by Cloud Scheduler at 06:00 Europe/Copenhagen.
The handler is `src/handler.ts` (entry point `handler`).

### Env vars

| Var | Source |
|-----|--------|
| `TJEK_API_KEY` | Secret Manager: `tjek-api-key:latest` |
| `CLOUDFLARE_API_TOKEN` | Secret Manager: `cloudflare-api-token:latest` |
| `DB_MODE` | `--set-env-vars=DB_MODE=d1` |
| `CLOUDFLARE_ACCOUNT_ID` | `--set-env-vars=CLOUDFLARE_ACCOUNT_ID=<acc>` |
| `CLOUDFLARE_D1_DATABASE_ID` | `--set-env-vars=CLOUDFLARE_D1_DATABASE_ID=<db>` |

### Service accounts

- `tilbudstracker-fn@lateral-booking-506410-k4.iam.gserviceaccount.com` — runtime; needs `roles/secretmanager.secretAccessor` on the two secrets above.
- `tilbudstracker-scheduler@…` — daily cron invoker (OIDC).
- `tilbudstracker-ops@…` — manual `curl` debugging. Has `roles/run.invoker`.

### Deploy

```bash
gcloud functions deploy tilbudstracker-scrape \
  --gen2 \
  --runtime=nodejs22 \
  --region=europe-west1 \
  --source=. \
  --entry-point=handler \
  --trigger-http \
  --no-allow-unauthenticated \
  --memory=256Mi \
  --timeout=300s \
  --concurrency=1 \
  --max-instances=1 \
  --run-service-account=tilbudstracker-fn@lateral-booking-506410-k4.iam.gserviceaccount.com \
  --set-env-vars="DB_MODE=d1,CLOUDFLARE_ACCOUNT_ID=5b3269050c8afff008527d038d4f2538,CLOUDFLARE_D1_DATABASE_ID=f4c3b701-9150-472d-b20b-e2530b7ca1b9" \
  --set-secrets="TJEK_API_KEY=tjek-api-key:latest,CLOUDFLARE_API_TOKEN=cloudflare-api-token:latest"
```

### Cloud Scheduler

```bash
gcloud scheduler jobs create http tilbudstracker-daily \
  --location=europe-west1 \
  --schedule="0 6 * * *" \
  --time-zone="Europe/Copenhagen" \
  --uri="<FN_URI from gcloud functions describe>" \
  --http-method=POST \
  --attempt-deadline=320s \
  --max-retry-attempts=1 \
  --min-backoff=60s \
  --oidc-service-account-email=tilbudstracker-scheduler@lateral-booking-506410-k4.iam.gserviceaccount.com \
  --oidc-token-audience="<FN_URI>"
```

> The Scheduler SA must already have `roles/run.invoker` on the function
> before the job runs, or Scheduler requests fail with `403`. Grant it with:
>
>     gcloud functions add-invoker-policy-binding tilbudstracker-scrape \
>       --region=europe-west1 \
>       --member="serviceAccount:tilbudstracker-scheduler@lateral-booking-506410-k4.iam.gserviceaccount.com"
>
> (Same `roles/run.invoker` binding as the manual `curl` SA — see
> [Service accounts](#service-accounts) above.)

### Bootstrap a tracked store

After deploy, invoke the function once with the ops SA to sync dealers, then
track the first store:

```bash
FN_URI="$(gcloud functions describe tilbudstracker-scrape --gen2 --region=europe-west1 --format='value(serviceConfig.uri)')"
curl -sS -X POST "${FN_URI}" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token --audiences="${FN_URI}")"
# then
TJEK_API_KEY=... DB_MODE=d1 \
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_D1_DATABASE_ID=... CLOUDFLARE_API_TOKEN=... \
pnpm track 9ba51
```

### Bulk tracking

Add ids to a file (one Tjek dealer id per line) and flip them all at once:

```bash
TJEK_API_KEY=... DB_MODE=d1 \
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_D1_DATABASE_ID=... CLOUDFLARE_API_TOKEN=... \
pnpm track --from=d1 --list-file=stores.txt
```

### Cloud Monitoring alerts

Three alerts created in `europe-west1`:

1. Error rate > 5% over 1 h on `tilbudstracker-scrape`.
2. p95 duration > 60 s.
3. `tilbudstracker-daily` scheduler failures > 0.

See the Linear issue SII-50 body for the exact `gcloud monitoring policies create` commands.

### Verification after first scheduled run

```bash
gcloud scheduler jobs run tilbudstracker-daily --location=europe-west1
gcloud functions logs read tilbudstracker-scrape --region=europe-west1 --gen2 --limit=50
wrangler d1 execute homelab --remote --command "SELECT COUNT(*) AS c FROM offers;"
```

### Cost

Expected monthly GCP spend: **$0**. Spec'd usage fits well within the free tier
for Cloud Functions (2M invocations, 360k GB-s, 180k GHz-s per month), Cloud
Scheduler (3 jobs), and Secret Manager (10k access ops).

#### Cloud Build and Artifact Registry (deploy-time, not runtime)

Cloud Functions Gen 2 builds and pushes a container image on every
`gcloud functions deploy`. Two more services see usage during deploy:

- **Cloud Build:** builds the container. Free tier is **120 build-minutes/day**.
  A typical `pnpm build` + push is ~1–2 minutes, so even with daily deploys
  we stay well within the free tier.
- **Artifact Registry:** stores the image in `gcf-artifacts`. Free tier is
  ~0.5 GB-month storage. Function images are typically <300 MB and old
  images are auto-cleaned by `gcloud functions deploy`, so this stays
  well within the free tier.

These two are billed **per billing account** (aggregated across all projects),
not per project.

## Not yet implemented

- **LLM normalization cronjob** — a separate AI-enabled job to normalize ambiguous unit prices weekly
- **Kubernetes manifests** — CronJob + PVC definitions for k3s deployment
- **Web UI / reporting** — querying and visualizing price trends

## Database

SQLite database at `data/tilbud.db`. Key tables:

- `stores` — all known stores, with `isTracked` flag
- `catalogs` — catalog metadata with publish dates and validity windows
- `offers` — individual offers with raw quantity data, computed unit prices, and LLM normalization fields
