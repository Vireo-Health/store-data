# Claude Code context — store-data

Multi-brand store-hours sync. Google Business Profile is the source of truth
for every brand's store hours; this repo pulls them weekly, gates them, and
publishes to each brand's Webflow CMS + a GitHub Pages data file. Built July
2026 starting from the R.Greenleaf rollout. Read README.md first for the
architecture and runbook; this file holds the operational knowledge that isn't
obvious from the code.

## Ground rules

- **Never hand-edit `<brand>/` output or `brands/<brand>/state.json`** — the
  workflow regenerates both. Hours change in Google Business Profile, nowhere
  else.
- `engine/` is brand-agnostic. Brand-specific anything belongs in
  `brands/<brand>/stores.config.json` (incl. `site.org` for JSON-LD identity).
- Tests: `cd engine && npm test` — no network or credentials needed. Keep it
  that way. Use `node --test` bare (NOT `node --test <dir>` — that breaks on
  Node 22+).
- This repo is public. Never log or commit anything that isn't already public
  information (names, addresses, hours). Credentials only via Actions secrets.
- Workflow commits push to main directly; `git pull --rebase` before push.
  Commit as the neutral author, never a personal name.

## Adding a brand (the real workflow, with the gotchas)

README.md has the step list. What it doesn't say:

1. **The roster join is the actual work.** Each brand site's embeds and CMS
   evolved separately, so expect drifted/conflicting hours between them —
   R.Greenleaf had 8 of 14 stores disagreeing. Build the config roster FROM
   the live CMS (item IDs) joined to the embeds' identifiers (storeId /
   storeUrl ↔ CMS slug). Anchor every edit on unique IDs, never on hours
   strings — identical hours collide across stores.
2. **Resolver `?` lines need a human, always.** It refuses to guess when the
   listing name lacks the brand or the street number mismatches. For a store
   acquired from another brand whose Google listing still carries the old
   name, set `resolveNameAllow: ["Old Name"]` + a reason on that store.
   Conversions often leave the old brand's dead listing next to the live one —
   the resolver rejects `CLOSED_PERMANENTLY` candidates on purpose.
3. **Non-storefront entries** (delivery services, especially ones sharing a
   storefront's address) get `syncFromGoogle: false` + `syncFromGoogleReason`,
   or the resolver will confidently attach the wrong listing. See Albuquerque
   Delivery in the rgreenleaf config.
4. **Before `accept_all`, diff the proposed baseline against the brand's CMS**
   (run summary of a `resolve` + `dry_run` run). Where they disagree, find out
   which side is stale — for R.Greenleaf it was GOOGLE that was stale for the
   flagship store, and accepting blind would have republished the exact stale
   hours the project existed to fix. Every mismatch gets a human verdict:
   fix the Google listing, or accept Google's value.
5. **Embeds pattern** (in the brand's own site repo, not here): rename the
   hardcoded array to `FALLBACK_STORES`, merge `window.RG_STORES` over it by
   storeId/storeUrl, keep the array as offline fallback. Head script tag with
   NO defer/async — embeds read `RG_STORES` synchronously during parse.
   `window.RG_HOURS.isOpenNow(store)` for open-now state (timezone-correct,
   holiday-aware); `todayHours(store)` and `holidayHours(store)` for display.
   Never regex-parse hours strings against the browser clock.
6. Secrets naming: `WEBFLOW_API_TOKEN_<BRAND>` (CMS read/write scope, per
   site), shared `GOOGLE_MAPS_API_KEY`. CMS writes use the /items/live PATCH —
   no Webflow site publish involved, so it can never ship a designer's WIP.

## Operational facts

- Sync exit codes: 0 clean, 2 held-for-review, 3 CMS write failed after
  artifacts were generated. The commit step runs `if: always()` — generated
  data and resolved Place IDs must survive later-step failures (losing them
  re-pays for the Places calls).
- The gate holds: first-run baselines, non-OPERATIONAL status, all-week
  closures, any open→closed day flip, >4h time moves, weekly volume cut ≥half,
  and empty responses. Held stores keep current hours — held never means
  blank. Only `regularOpeningHours` is gated and synced to `week`/the CMS;
  holiday hours never overwrite the standing schedule.
- Holiday/special hours (added 2026-11-24) come from `currentOpeningHours`
  and publish UNGATED as `special` in the data files and JSON-LD only — never
  `week`, never the CMS — and are listed per store under "Special hours" in
  report.md. A special day equal to the published week is dropped. Shapes
  verified against real responses (fixtures/places-special-days.json,
  places-livwell-2026-11-24.json): closed all day = date in `specialDays`
  with NO period opening on it; midnight close = 00:00 on the next date; the
  period at the 7-day window edge is cut at 23:59 with `truncated: true`
  (read as midnight) — but a non-truncated 23:59 is a real 11:59pm close.
  Yesterday's special day is carried from state for one more day so overnight
  carry-over survives a sync that lands after midnight.
- Phone numbers sync from the same Places call, gated independently of hours
  (`gate.evaluatePhone`): formatting-only differences are ignored (digit
  comparison), blank→value fills in unattended, value→value is always held,
  and Google returning no phone keeps the current number. Phones publish to
  the data files always; to the CMS only where `site.phoneFieldSlug` is set.
- Ratings (`rating`/`ratingCount`) publish ungated to the data files and
  state, never to the CMS or the JSON-LD (Google's review-snippet policy
  forbids marking up Google-sourced ratings — see the comment in generate.js).
  `websiteUri` is audit-only (`gate.auditWebsite` vs the `site.org.url`
  host): findings land in the report/issue via exit code 2 and re-alert every
  run until they are resolved. The report says to fix the listing in Google
  Business Profile, but that is only ever right for a store no other brand
  claims — **check for a duplicate `placeId` across all
  `brands/*/stores.config.json` first**. Google is the source of truth for
  ownership as well as hours: the listing's website identifies who runs the
  store, and the audit fires only on the brand whose domain does NOT match, so
  the flagged side is the one whose roster is wrong. Editing that listing's URL
  to match would corrupt the real owner's listing. A colliding `placeId` also
  bills the fetch twice a day. All-stores-flagged means the opposite — the
  brand's own `site.org.url` is wrong (see the starbuds note).
- An all-held/all-error run writes NO artifacts (empty-roster guard) — good
  data is never replaced by an empty roster.
- Cadence is daily as of 2026-07-31 (Weston accepted the cost). The fetch
  bills as Places **Enterprise** (`regularOpeningHours` sets the SKU; $20 per
  1,000 calls), 1,000 free calls/month per billing account across ALL brands.
  Daily is ~30.4 calls/store/month: free up to ~32 stores, ~$0.61/store/month
  after, ~$41/month at the ~100-store full portfolio. Adding
  `nationalPhoneNumber` cost nothing — it's Enterprise-tier like the hours
  field. NEVER add an Atmosphere-tier field (reviews, editorialSummary,
  delivery/curbsidePickup/…) to this field mask: it upgrades every daily call
  to Enterprise + Atmosphere ($25/1,000, separate 1K free cap). Fetch those in
  a separate, slower-cadence call if ever needed.
- Ignore Node-deprecation warnings from `pages-build-deployment` — that's
  GitHub's own managed Pages workflow, not editable from this repo. (And be
  slow to chase such warnings in sync.yml: one past "fix" broke the test step
  via the `node --test <dir>` Node 22 behavior change.)
- Org constraints prevent serving Pages from the private site repos and
  cross-repo push credentials — that is WHY the pipeline lives in this public
  repo and commits to itself. Don't move it back into a site repo.

## Brand notes

- **rgreenleaf**: live since 2026-07-28. 13 storefronts + excluded delivery.
  Site repo: Vireo-Health/vireo-RGO (private) holds the embeds.
- **everydayweed** (future): inherits R.Greenleaf's former Sunland Park store —
  Place ID `ChIJNb7BIST53YYReAfFj_8WD6I` already resolved; page copy for it is
  archived in R.Greenleaf's Webflow Stores collection (item, not deleted).
- **starbuds**: onboarded 2026-08-05. 17 CO storefronts; site repo
  Coastal-Division/schwazze-SB holds the embeds. Canonical domain is
  starbudscolorado.com — that is what the Google listings point at and what
  `site.org.url` must stay set to (starbuds.us also resolves, but pointing
  the config there made the listing audit flag all 17 stores; corrected
  2026-08-10). Three locations (Lakeside, Lakewood, Manitou Springs)
  keep separate med + rec CMS items sharing one storefront and Google
  listing — the rec item is `webflowItemId`, the med item rides along via
  `alsoWebflowItemIds` so both pages get the same patch, and both appear as
  `variants` in the published records. The site also renders a legacy
  RichText hours block (field slug `hours`), kept in sync via
  `site.hoursRichTextFieldSlug` alongside the PlainText `store-hours` the
  newer embeds bind. At onboarding the CMS had Glendale/Garden City carrying
  Pueblo's phone and Glendale carrying Pueblo's Jane store-id 4651 — this
  crossed real customer calls/orders to Pueblo and was fixed in the CMS
  2026-08-07 (Glendale is Jane 1767, phone (720) 519-0891; Garden City
  (970) 515-5839). The old production site (starbudscolorado.com on Vercel,
  separate from the Webflow rebuild) still had the wrong values then.
  Remaining data quirk: Colorado Springs and draft DU Med both claim Jane
  1757. The former SB
  stores converted to Everyday Weed (Aurora North, Boulder, Brighton,
  Federal Heights, Pecos–Hwy 36, DU) still exist as CMS items but are
  deliberately NOT in the roster.
- **standingakimbo**: 9 stores, and the one brand where sharing another
  brand's Google listing is CORRECT. It is a medical brand: seven of the nine
  are med counters or popups trading inside another brand's dispensary, with
  no listing of their own — inside Star Buds: Colorado Springs, Lakewood
  (265 S Wadsworth), Garden City (2502 8th Ave); inside Every Day Weed:
  Brighton, Lakewood (3600 S Wadsworth), Fort Collins Smithfield; inside
  LivWell: Garden City (2647 8th Ave). Denver and Fort Collins S College are
  standalone. They keep the host storefront's
  hours, so the host listing is the right source — it just carries the host's
  domain. Each declares `auditWebsiteAllow` + `auditWebsiteAllowReason` so the
  listing audit stays quiet (added 2026-08-17; before that they re-alerted
  every run). Do NOT "fix" those listings in Google Business Profile, and do
  not set `syncFromGoogle: false` on them — that would freeze their hours at
  whatever state holds and keep republishing it over CMS edits.
  The SA store pages show each CMS item's own `store-hours`/`phone` fields
  (their embeds do not read `RG_STORES`), so a wrong `webflowItemId` means a
  page with no hours. Until 2026-11-24 the roster's `garden-city` (2502, Star
  Buds listing) pointed at the item the site had repurposed for the 2647
  LivWell counter, leaving the 2502 page blank; rosters added that day use
  the CMS slug as the roster slug. Still not in the roster: Ft Collins N
  College Ave (inside LivWell, 810 N College) — a draft "coming soon" item
  (`6a85d6293ea8dea3c99ca1f2`); add it, sharing LivWell Fort Collins's
  listing, once it is published.
- **greendragon**: Telluride is the only Green Dragon store left (confirmed
  2026-11-24); every other location has cut over to another brand. Onboarded
  with 13; seven left first and were removed from the roster 2026-08-17. Six of them carried
  `resolveNameAllow` for another brand "during the transition" and the
  transition settled — Fort Collins College, Fort Collins Smithfield,
  Breckenridge and Boulder to Every Day Weed; Thornton and Aurora Quincy to
  Star Buds. The seventh, Denver Colfax (5130 E Colfax), had resolved cleanly
  as Green Dragon at onboarding and converted later; it is the one case the
  duplicate-`placeId` check could not have caught, and the listing-website
  audit was the only signal. It is now Every Day Weed's
  `denver-colfax-dispensary`. All seven stay live
  on the brand that owns them and their Green Dragon CMS items still exist. Do
  not re-add them. Daily cadence means
  each added store costs ~$0.61/month once the portfolio passes ~32 stores —
  the full ~100-store portfolio lands around $41/month, which is approved. No
  cadence change needed when onboarding.
- **everest**: Sunland Park (1580 Appaloosa Dr Ste 320, Place ID
  `ChIJg89m3En53YYRmg3zCVNqPNA`) closed — Google reports
  `CLOSED_PERMANENTLY` with no hours, and the gate held it every run. Removed
  from the roster 2026-11-24; its Everest CMS item (`6a28706cffb42f044f4dd83a`)
  still exists. Do not re-add it, and do not confuse it with Every Day Weed's
  live Sunland Park store at 1541 Appaloosa Dr (a different listing).
- **Cutovers between brands** (LivWell, Star Buds, Green Dragon -> Every Day
  Weed): Google is the source of truth for which brand owns a location, but
  listings lag a cutover either way. Colorado Blvd (2020 S Colorado Blvd) was
  renamed in Google first and moved LivWell -> Every Day Weed on 2026-11-24,
  a day before its launch; its EDW CMS item was still a draft, which is why
  CMS writes now patch never-published/draft items staged-only (the live
  endpoint would fail or publish the page early). Lakewood 3600 S Wadsworth is
  the reverse: Every Day Weed since 2026-10-30 (confirmed 2026-11-24), but the
  listing still says "LivWell Dispensary" with livwell.com. Its listing-audit
  alert stays until that Google Business Profile rename — do not move it back
  to LivWell. Central Park and North Pueblo (cut over 2026-11-12) likewise
  still carry LivWell names, with correct websites.
