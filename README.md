# store-data

Store hours and phone numbers for Vireo Health brand websites, synced daily
from each store's Google Business listing and served via GitHub Pages. Change
hours in Google — the sites follow.

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
| LivWell | [`livwell/stores.js`](livwell/stores.js) | same set |
| Star Buds | [`starbuds/stores.js`](starbuds/stores.js) | same set |

## Layout

```
engine/            the sync engine (brand-agnostic) + its tests
brands/<brand>/    stores.config.json (roster + Webflow wiring), state.json
<brand>/           published output, committed by the workflow, served by Pages
```

## Operations

`.github/workflows/sync.yml` runs daily 09:15 America/Denver. Per brand it
fetches `regularOpeningHours`, `nationalPhoneNumber`, `rating`/
`userRatingCount`, and `websiteUri` for every store with a Place ID (one
Enterprise-SKU call per store — all these fields ride on it at no extra
cost), runs the sanity gate, applies routine changes to the Webflow CMS
(live item patch — no site publish involved), commits the regenerated data,
and files/updates a **Store hours held for review (brand)** issue for
anything held.

Ratings publish ungated into `stores.js`/`stores.json` (they drift daily by
nature) but are deliberately excluded from the JSON-LD — Google's
review-snippet policy forbids marking up ratings sourced from Google itself.
`websiteUri` publishes nothing: it powers a report-only **Listing audit**
that flags listings whose website is missing or points off the brand domain
(stale post-conversion URLs, hijacked listings). Fix those in Google
Business Profile.

Hours always sync to the CMS `store-hours` field. Phone numbers land in the
published data files; they also patch the CMS only if the brand's config sets
`site.phoneFieldSlug` to a PlainText field on the Stores collection.

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
| An existing phone number would change | A hijacked listing's favorite edit; real changes are rare |

A held store keeps its current hours. Only `regularOpeningHours` is synced, so
holiday overrides never overwrite the standing schedule. Phone changes are
gated independently of hours: a blank phone fills in unattended, a replacement
is held, and Google returning no phone never blanks an existing number.

## Adding a brand

1. Create `brands/<brand>/stores.config.json` — copy rgreenleaf's shape: the
   `site` block (Webflow site ID, Stores collection ID, field slugs) plus one
   entry per store. Add a `google-place-id` PlainText field to that site's
   Stores collection. Two optional keys (see starbuds): a store's
   `alsoWebflowItemIds` lists extra CMS items that receive the same patch
   (med/rec page pairs sharing one storefront), and
   `site.hoursRichTextFieldSlug` mirrors hours into a legacy RichText field
   as well. Also commit a placeholder `<brand>/README.md` at the
   repo root — the test suite requires the published dir to exist, and the
   first sync can't run until tests pass.
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

Store counts and API cost: the fetch bills as Places *Enterprise* — $20 per
1,000 calls after the 1,000 free calls/month per billing account. Daily
cadence is ~30.4 calls per store per month: free up to ~32 stores, about
$0.61/store/month beyond that (~$41/month at a 100-store portfolio; accepted
2026-07-31). Phone numbers ride along on the same call at no extra cost —
every field in the mask is Enterprise-tier or below.

## Local development

```bash
cd engine
npm test                                  # no network or credentials needed
node sync.js --brand rgreenleaf --dry-run # requires GOOGLE_MAPS_API_KEY
```
