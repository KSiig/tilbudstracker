# OFF coverage spike — 2026-09-12

## Summary

- All offers sampled: **9770** (issue baseline: 9,710+)
- Regex-clustered subset sampled: **6800** (issue baseline: 1,396 clusters) — note: the issue's "1,396" referred to distinct cluster IDs in `offers_normalized`; this count is the number of *offer rows* returned by `normalized_id IS NOT NULL AND is_split = 0`, which has grown.
- Unique OFF brands in dictionary: **104848** (from **815367** OFF rows, **654945** with a non-empty `brands_tags`)
- Country filter: `en:denmark`, `en:sweden`, `en:norway`, `en:finland`, `en:germany`, `en:netherlands`, `en:united-kingdom`

### Headline metrics

- **Headline 1 — all offers** unique-hit = **12.3%** (1206 / 9770). Threshold for proceed: **50%**.
- **Headline 2 — regex-clustered subset** unique-hit = **10.7%** (728 / 6800). Threshold for proceed: **50%** _(load-bearing number — see issue)._

### All-offers category counts

| category | count | share |
|----------|------:|------:|
| unique_match | 1206 | 12.3% |
| ambiguous_match | 6345 | 64.9% |
| no_brand | 2215 | 22.7% |
| not_in_scope | 4 | 0.0% |

### Regex-clustered category counts

| category | count | share |
|----------|------:|------:|
| unique_match | 728 | 10.7% |
| ambiguous_match | 4440 | 65.3% |
| no_brand | 1630 | 24.0% |
| not_in_scope | 2 | 0.0% |

## Decision

- [ ] Proceed with simplification (both populations ≥ 50% unique hit)
- [ ] Keep regex as fallback (regex-clustered unique-hit < 50% but overall ≥ 50%)
- [x] Abandon per-brand aggregation; explore category-only view (both < 50%)

**Recommended:** Both headlines are below 50% (all=12.3%, regex-clustered=10.7%). OFF matching is not a viable identity layer. Explore aggregating by category only.

## Detail by category

### All offers

Top 5 unique hits:

- `LANGHE NEBBIOLO SAN SILVESTRO, LANGHE DOC ARNEIS SAN SILVESTRO, EBRIUS GOVERNO ALL’USO TOSCANO ROSSO, EBRIUS VERONA CHARDONNAY ELLER BORGO AL PASCOLO CHIANTI` → OFF `00151221` _(reason: exactly 1 OFF product with brand "langhe")_
- `M.DE. LIGNY PETIT CHABLIS ELLER CHÂTEAU TOUR PEREY SAINT-EMILION GRAND CRU 2022 ELLER LE RAGOSE RIPASSO CLASSICO SUPERIORE` → OFF `3290217500197` _(reason: exactly 1 OFF product with brand "saint emilion grand cru")_
- `CELLIER DES PRINCES CÔTES DU RHÔNE VIEILLES VIGNES 2024, PETER WEINBACH RIESLING MEDIUM DRY ELLER CRUDO WHITE` → OFF `4011900535109` _(reason: exactly 1 OFF product with brand "medium dry")_
- `GIGONDAS OLIVIER & LAFONT CÔTES DU RHÔNE CRU ELLER ØKOLO GISK BRUNELLO DI MONTALCINO TENUTA LE PERCHIE DOCG` → OFF `0009670300458` _(reason: exactly 1 OFF product with brand "brunello di montalcino")_
- `Wienerpekan, pain au chocolat, vaniljestang med cremefyld, spandauer, valnøddestykke, croissant eller baguette` → OFF `7610058215399` _(reason: exactly 1 OFF product with brand "pain")_

Top 5 ambiguous matches (most informative):

- `TOFTERUP RIBERA DEL DUERO, TOFTERUP SOMONTANO CHARDONNAY, CHÂTEAU RECOUGNE BORDEAUX SUPÉRIEUR ELLER FAMILLE BOUGRIER CONFIDENCES TOURAINE SAUVIGNON` → no single OFF code _(reason: 3 OFF products share brand "ribera del duero")_
- `RAHBEK RØDSPÆTTEFILETER MED SPRØD OVNKLAR PANERING, ROYAL GREENLAND HUMMERSUPPE, DISKO BAY EKSTRA STORE KUTTER-REJER ELLER GRØNLANDSKE SKALREJER` → no single OFF code _(reason: 41 OFF products share brand "royal greenland")_
- `Salling ØKO økologisk røget laks eller vannameirejer, Salling grønlandske rejer, ørred, krebsehaler, kold- eller varmrøget laks` → no single OFF code _(reason: 65 OFF products share brand "salling øko")_
- `Salling ØKO økologisk røget laks eller vannameirejer, Salling grønlandske rejer, ørred, krebsehaler, kold- eller varmrøget laks` → no single OFF code _(reason: 65 OFF products share brand "salling øko")_
- `1,2 kg Hakket Dansk Grise- og Kalvekød 8-12 %, 900-1200 g Hamburgerryg af Dansk Gris eller 1,8 kg Rose Dansk Hel Kylling` → no single OFF code _(reason: 3 OFF products share brand "dansk")_

Top 5 no_brand misses (most informative):

- `Rokkedahl Fritgående kylling Kyllingebrystfilet` → no single OFF code _(reason: no OFF brand matched at a word boundary)_
- `ENGDIGEGAARD DANSKE ØKOLOGISKE SORTHAVREGRYN` → no single OFF code _(reason: no OFF brand matched at a word boundary)_
- `Økologiske danske håndsorterede gulerødder` → no single OFF code _(reason: no OFF brand matched at a word boundary)_
- `Piccardo & Savoré ekstra jomfru olivenolie` → no single OFF code _(reason: no OFF brand matched at a word boundary)_
- `Skrald-let affaldsposer med snørelukning` → no single OFF code _(reason: no OFF brand matched at a word boundary)_

Top 4 not_in_scope samples:

- `FRISKE SALATER` → no single OFF code _(reason: matches a fresh/unbarcoded marker (frisk/økologisk/...))_
- `Friske figner` → no single OFF code _(reason: matches a fresh/unbarcoded marker (frisk/økologisk/...))_
- `Friske figner` → no single OFF code _(reason: matches a fresh/unbarcoded marker (frisk/økologisk/...))_
- `Friske figner` → no single OFF code _(reason: matches a fresh/unbarcoded marker (frisk/økologisk/...))_

### Regex-clustered subset

Top 5 unique hits:

- `Masseria Trajone Negroamaro Primitivo eller Masseria Trajone Moscato Chardonnay` → OFF `8021904620110` _(reason: exactly 1 OFF product with brand "masseria trajone")_
- `MASSERIA TRAJONE NEGROAMARO PRIMITIVO ELLER MASSERIA TRAJONE MOSCATO CHARDONNAY` → OFF `8021904620110` _(reason: exactly 1 OFF product with brand "masseria trajone")_
- `Il Capolavoro, Montgras Estate eller Jean Marie Garnier Bag-in-Box` → OFF `00098730` _(reason: exactly 1 OFF product with brand "bag in box")_
- `Il Capolavoro, Montgras Estate eller Jean Marie Garnier Bag-in-Box` → OFF `00098730` _(reason: exactly 1 OFF product with brand "bag in box")_
- `CARLSBERG/ MIKKELLER Drink'in The Sun eller Brooklyn Stonewall IPA` → OFF `9770307268540` _(reason: exactly 1 OFF product with brand "the sun")_

Top 5 ambiguous matches (most informative):

- `Salling ØKO økologisk røget laks eller vannameirejer, Salling grønlandske rejer, ørred, krebsehaler, kold- eller varmrøget laks` → no single OFF code _(reason: 65 OFF products share brand "salling øko")_
- `Salling ØKO økologisk røget laks eller vannameirejer, Salling grønlandske rejer, ørred, krebsehaler, kold- eller varmrøget laks` → no single OFF code _(reason: 65 OFF products share brand "salling øko")_
- `Dr. Loosen Dr. L Riesling, Côtes du Rhône Grande Réserve eller Borgo Col del Alto Prosecco` → no single OFF code _(reason: 2 OFF products share brand "dr loosen")_
- `SUNLIGHT COVE / CIMAROSA Rosé, spansk hvidvin, sydafrikansk Shiraz rosé eller Chardonnay` → no single OFF code _(reason: 2 OFF products share brand "sunlight")_
- `SUNLIGHT COVE / CIMAROSA Rosé, spansk hvidvin, sydafrikansk Shiraz rosé eller Chardonnay` → no single OFF code _(reason: 2 OFF products share brand "sunlight")_

Top 5 no_brand misses (most informative):

- `ZOOFARI Intelligenslegetøj til kæledyr` → no single OFF code _(reason: no OFF brand matched at a word boundary)_
- `ZOOFARI Intelligenslegetøj til kæledyr` → no single OFF code _(reason: no OFF brand matched at a word boundary)_
- `TA’ 3 FOR 2 på udvalgt VRS undertøj` → no single OFF code _(reason: no OFF brand matched at a word boundary)_
- `TA’ 3 FOR 2 PÅ UDVALGT VRS UNDERTØJ.` → no single OFF code _(reason: no OFF brand matched at a word boundary)_
- `TA’ 3 FOR 2 på udvalgt VRS lingeri` → no single OFF code _(reason: no OFF brand matched at a word boundary)_

Top 2 not_in_scope samples:

- `Friske figner` → no single OFF code _(reason: matches a fresh/unbarcoded marker (frisk/økologisk/...))_
- `Friske figner` → no single OFF code _(reason: matches a fresh/unbarcoded marker (frisk/økologisk/...))_

## Spot-check log

20 samples drawn across categories (5 unique, 5 ambiguous, 5 no_brand, 5 not_in_scope). The expected answer is whether the top-3 OFF candidates look like the right product on the OFF website.

| # | category | heading | cleaned | top-3 OFF candidates |
|--:|----------|---------|---------|----------------------|
| 1 | unique_match | `Masseria Trajone Negroamaro Primitivo eller Masseria Trajone Moscato Chardonnay` | `masseria trajone negroamaro primitivo eller masseria trajone moscato chardonnay` | `8021904620110` |
| 2 | unique_match | `MASSERIA TRAJONE NEGROAMARO PRIMITIVO ELLER MASSERIA TRAJONE MOSCATO CHARDONNAY` | `masseria trajone negroamaro primitivo eller masseria trajone moscato chardonnay` | `8021904620110` |
| 3 | unique_match | `Il Capolavoro, Montgras Estate eller Jean Marie Garnier Bag-in-Box` | `il capolavoro montgras estate eller jean marie garnier bag in box` | `00098730` |
| 4 | unique_match | `CARLSBERG/ MIKKELLER Drink'in The Sun eller Brooklyn Stonewall IPA` | `carlsberg mikkeller drinkin the sun eller brooklyn stonewall ipa` | `9770307268540` |
| 5 | unique_match | `LANGHE NEBBIOLO SAN SILVESTRO, LANGHE DOC ARNEIS SAN SILVESTRO, EBRIUS GOVERNO ALL’USO TOSCANO ROSSO, EBRIUS VERONA CHARDONNAY ELLER BORGO AL PASCOLO CHIANTI` | `langhe nebbiolo san silvestro langhe doc arneis san silvestro ebrius governo alluso toscano rosso ebrius verona chardonnay eller borgo al pascolo chianti` | `00151221` |
| 6 | ambiguous_match | `Salling ØKO økologisk røget laks eller vannameirejer, Salling grønlandske rejer, ørred, krebsehaler, kold- eller varmrøget laks` | `salling øko økologisk røget laks eller vannameirejer salling grønlandske rejer ørred krebsehaler kold eller varmrøget laks` | `5701150008797`, `5701232287386`, `5701331872995` |
| 7 | ambiguous_match | `Dr. Loosen Dr. L Riesling, Côtes du Rhône Grande Réserve eller Borgo Col del Alto Prosecco` | `dr loosen dr l riesling côtes du rhône grande réserve eller borgo col del alto prosecco` | `0810404020135`, `4022214181333` |
| 8 | ambiguous_match | `SUNLIGHT COVE / CIMAROSA Rosé, spansk hvidvin, sydafrikansk Shiraz rosé eller Chardonnay` | `sunlight cove cimarosa rosé spansk hvidvin sydafrikansk shiraz rosé eller chardonnay` | `0072613160372`, `5001422358743` |
| 9 | ambiguous_match | `TOFTERUP RIBERA DEL DUERO, TOFTERUP SOMONTANO CHARDONNAY, CHÂTEAU RECOUGNE BORDEAUX SUPÉRIEUR ELLER FAMILLE BOUGRIER CONFIDENCES TOURAINE SAUVIGNON` | `tofterup ribera del duero tofterup somontano chardonnay château recougne bordeaux supérieur eller famille bougrier confidences touraine sauvignon` | `8437003309106`, `8437009015124`, `8437016072011` |
| 10 | ambiguous_match | `RAHBEK RØDSPÆTTEFILETER MED SPRØD OVNKLAR PANERING, ROYAL GREENLAND HUMMERSUPPE, DISKO BAY EKSTRA STORE KUTTER-REJER ELLER GRØNLANDSKE SKALREJER` | `rahbek rødspættefileter med sprød ovnklar panering royal greenland hummersuppe disko bay ekstra store kutter rejer eller grønlandske skalrejer` | `05740301`, `20799793`, `25058970` |
| 11 | no_brand | `ZOOFARI Intelligenslegetøj til kæledyr` | `zoofari intelligenslegetøj til kæledyr` | _(none)_ |
| 12 | no_brand | `TA’ 3 FOR 2 på udvalgt VRS undertøj` | `ta 3 for 2 på udvalgt vrs undertøj` | _(none)_ |
| 13 | no_brand | `TA’ 3 FOR 2 PÅ UDVALGT VRS UNDERTØJ.` | `ta 3 for 2 på udvalgt vrs undertøj` | _(none)_ |
| 14 | no_brand | `TA’ 3 FOR 2 på udvalgt VRS lingeri` | `ta 3 for 2 på udvalgt vrs lingeri` | _(none)_ |
| 15 | no_brand | `Rokkedahl Fritgående kylling Kyllingebrystfilet` | `rokkedahl fritgående kylling kyllingebrystfilet` | _(none)_ |
| 16 | not_in_scope | `Friske figner` | `friske figner` | _(none)_ |
| 17 | not_in_scope | `FRISKE SALATER` | `friske salater` | _(none)_ |

## Methodology

- **Brand dictionary**: built from OFF `brands_tags` for rows whose `countries_tags` include one of en:denmark, en:sweden, en:norway, en:finland, en:germany, en:netherlands, en:united-kingdom. The tag language prefix (`en:`, `xx:`) is stripped, then the remaining string is normalized (lowercase, NFC, connector apostrophes dropped, remaining punctuation → space, whitespace collapsed).
- **Heading preprocessing**: lowercase, NFC, connector apostrophes dropped, remaining punctuation → space, whitespace collapsed + trim. Quantity prefixes ("1,2 kg", "2x", "500 g") are stripped from the head. Trailing "- max X,XX" suffixes are stripped. **Unit tokens (g, kg, ml, l, cl, stk, %, ...) and pure-number tokens (e.g. "8", "12") are dropped before brand extraction** — one OFF row has `xx:kg` as a brand tag, so leaving unit tokens in the search corpus would let the algorithm lock onto a unit token instead of the real brand.
- **Fresh / unbarcoded heuristic**: if the cleaned heading contains any of `frisk`, `friske`, `økologisk`, `øko` (as a whole word), the heading is classified `not_in_scope` before brand extraction. Heuristic is intentionally short — see the report for misses if the data suggests wider markers.
- **Brand extraction**: tokenize the cleaned heading on whitespace. At each token position, look up brands whose first token matches; for each candidate, verify the remaining tokens match (case-folded). Take the longest match anywhere in the heading. Multi-word brands (e.g. `ritter sport`) are supported.
- **Classification**: `unique_match` = exactly 1 OFF product with the extracted brand in the filtered country set; `ambiguous_match` = ≥ 2; `no_brand` = brand extracted but 0 OFF products (or no brand could be extracted); `not_in_scope` = fresh/unbarcoded heuristic fired.
- **Two populations measured**: every row in `offers` ("all offers") and every row with `normalized_id IS NOT NULL AND is_split = 0` ("regex-clustered subset").

## Reproduction

```bash
# 1. Download OFF food dump (~7.3 GB compressed) into data/off.parquet
curl -L -o data/off.parquet \
  https://huggingface.co/datasets/openfoodfacts/product-database/resolve/main/food.parquet

# 2. Filter to the seven countries → NDJSON (≈60 MB)
duckdb -c "
COPY (
  SELECT code, brands, brands_tags
  FROM read_parquet('data/off.parquet')
  WHERE list_contains(countries_tags, 'en:denmark')
     OR list_contains(countries_tags, 'en:sweden')
     OR list_contains(countries_tags, 'en:norway')
     OR list_contains(countries_tags, 'en:finland')
     OR list_contains(countries_tags, 'en:germany')
     OR list_contains(countries_tags, 'en:netherlands')
     OR list_contains(countries_tags, 'en:united-kingdom')
) TO 'data/off-dk-neighbours.jsonl' (FORMAT JSON)
"

# 3. Run the spike against live D1 (read-only)
DB_MODE=d1 \
  CLOUDFLARE_ACCOUNT_ID=... \
  CLOUDFLARE_D1_DATABASE_ID=... \
  CLOUDFLARE_API_TOKEN=... \
  pnpm tsx scripts/off-coverage-spike.ts

# 4. Open the report
cat data/off-coverage-spike-2026-09-12.md
```
