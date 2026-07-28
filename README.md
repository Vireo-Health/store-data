# store-data

Store hours for Vireo Health brand websites, synced weekly from each store's
Google Business listing and served via GitHub Pages. Change hours in Google —
the sites follow.

```
Google Places API ──► normalize ──► sanity gate ──┬──► brand's Webflow CMS
                                                  └──► <brand>/stores.js  (GitHub Pages)
```

This repo is public because everything in it is public information — store
names, addresses, and opening hours. Credentials live only in Actions secrets.

## Published data

Each brand's Webflow site loads its own file site-wide (no `defer`/`async` —
page embeds read `window.RG_STORES` synchronously during parse):

```html
<script src="https://vireo-health.github.io/store-data/rgreenleaf/stores.js"></script>
```

| Brand | Data | Also served |
|---|---|---|
| R.Greenleaf | [`rgreenleaf/stores.js`](rgreenleaf/stores.js) | `stores.json`, `store-schema.json` (LocalBusiness JSON-LD), `report.md` |

## Layout

```
engine/            the sync engine (brand-agnostic) + its tests
brands/<brand>/    stores.config.json (roster + Webflow wiring), state.json
<brand>/           published output, committed by the workflow, served by Pages
```

## Operations

`.github/workflows/sync.yml` runs Mondays 09:15 America/Denver. Per brand it
fetches `regularOpeningHours` for every store with a Place ID, runs the sanity
gate, applies routine changes to the Webflow CMS (live item patch — no site
publish involved), commits the regenerated data, and files/updates a
**Store hours held for review (brand)** issue for anything held.

For an immediate sync, use **Run workflow** — optionally limiting to one brand.

### The sanity gate

Google listings can be edited by the public and by Google's own inference. A
change publishes unattended only if none of these hold:

| Held when | Why |
|---|---|
| No stored baseline yet | First run — a human confirms the starting point |
| Non-`OPERATIONAL` business status | Listing may be closed or flagged |
| Every day would become closed | Almost always a listing error |
| A day flips open → closed | Real, but worth confirming |
| Any time moves more than 4h | Outside a normal schedule tweak |
| Weekly open hours cut in half or more | Same reasoning, by volume |
| Google returns no hours | Never overwrite good data with nothing |

A held store keeps its current hours. Only `regularOpeningHours` is synced, so
holiday overrides never overwrite the standing schedule.

## Adding a brand

1. Create `brands/<brand>/stores.config.json` — copy rgreenleaf's shape: the
   `site` block (Webflow site ID, Stores collection ID, field slugs) plus one
   entry per store. Add a `google-place-id` PlainText field to that site's
   Stores collection.
2. Add a repo secret `WEBFLOW_API_TOKEN_<BRAND>` (Webflow Site API token, CMS
   read/write scope) and add the brand to the matrix in
   `.github/workflows/sync.yml`.
3. Run the workflow with **resolve** + **dry_run** for that brand; fix any
   `?` lines the resolver reports (it refuses to guess ambiguous listings —
   see `resolveNameAllow` in the engine for listings still carrying a prior
   brand's name).
4. Review the proposed baseline in the run summary, then run with
   **accept_all** for that brand.
5. Add the script tag to the brand site's head custom code; wire the site's
   embeds to `window.RG_STORES` with their hardcoded data kept as an offline
   fallback.

Store counts and API cost: the hours fetch bills as Places *Enterprise*
(1,000 free calls/month per billing account). Weekly cadence keeps the whole
portfolio far inside the free allotment (~4.3 calls per store per month).

## Local development

```bash
cd engine
npm test                                  # no network or credentials needed
node sync.js --brand rgreenleaf --dry-run # requires GOOGLE_MAPS_API_KEY
```
