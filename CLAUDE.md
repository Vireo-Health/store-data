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
   `window.RG_HOURS.isOpenNow(store)` for open-now state (timezone-correct);
   never regex-parse hours strings against the browser clock.
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
  blank. Only `regularOpeningHours` is synced; holiday hours never overwrite
  the standing schedule.
- An all-held/all-error run writes NO artifacts (empty-roster guard) — good
  data is never replaced by an empty roster.
- Weekly cadence is a cost decision: the hours fetch bills as Places
  **Enterprise** (`regularOpeningHours` sets the SKU), 1,000 free calls/month
  per billing account across ALL brands. ~4.3 calls/store/month at weekly.
  Going daily across the portfolio would exceed the free tier.
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
- **starbuds / livwell / greendragon** (future): larger rosters; recheck the
  free-tier math in README before changing cadence.
