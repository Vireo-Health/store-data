#!/usr/bin/env node
/**
 * Scheduled store-hours sync for one brand.
 *
 *   Google Places API  ->  sanity gate  ->  Webflow CMS + generated artifacts
 *
 * Usage:
 *   node sync.js --brand rgreenleaf              fetch, gate, apply, publish
 *   node sync.js --brand rgreenleaf --dry-run    fetch and report, write nothing
 *   node sync.js --brand rgreenleaf --accept-all bypass the gate (confirm a baseline)
 *   node sync.js --brand X --fixture FILE        Places responses from JSON, not the API
 *
 * Repo layout (relative to the repo root, one level above engine/):
 *   brands/<brand>/stores.config.json   roster + Webflow site wiring
 *   brands/<brand>/state.json           last-accepted hours per store
 *   <brand>/                            published output (served by GitHub Pages)
 *
 * Env: GOOGLE_MAPS_API_KEY (or GOOGLE_ACCESS_TOKEN), WEBFLOW_API_TOKEN
 */

const fs = require('fs');
const path = require('path');

const h = require('./lib/hours');
const gate = require('./lib/gate');
const google = require('./lib/google');
const webflow = require('./lib/webflow');
const { generate } = require('./lib/generate');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const ACCEPT_ALL = argv.includes('--accept-all');
const FIXTURE = (() => {
  const i = argv.indexOf('--fixture');
  return i >= 0 ? argv[i + 1] : null;
})();
const BRAND = (() => {
  const i = argv.indexOf('--brand');
  return i >= 0 ? argv[i + 1] : null;
})();

if (!BRAND || !/^[a-z0-9-]+$/.test(BRAND)) {
  console.error('Usage: node sync.js --brand <brand> [--dry-run] [--accept-all] [--fixture FILE]');
  console.error('Brands available: ' + fs.readdirSync(path.join(__dirname, '..', 'brands')).join(', '));
  process.exit(1);
}

const REPO_ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'brands', BRAND, 'stores.config.json');
const STATE_PATH = path.join(REPO_ROOT, 'brands', BRAND, 'state.json');
const DIST_DIR = path.join(REPO_ROOT, BRAND);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

/** Rehydrate a stored week (plain JSON) into the canonical shape. */
function reviveWeek(stored) {
  if (!Array.isArray(stored) || stored.length !== 7) return null;
  return stored.map((day) => (Array.isArray(day) ? day : []));
}

async function fetchPlaces(stores, fixture) {
  if (fixture) {
    const data = readJson(fixture);
    return new Map(Object.entries(data));
  }

  const results = new Map();
  for (const store of stores) {
    if (!store.placeId) continue;
    try {
      results.set(store.slug, await google.getPlaceHours(store.placeId));
    } catch (err) {
      results.set(store.slug, { error: String(err.message || err) });
    }
  }
  return results;
}

async function main() {
  const config = readJson(CONFIG_PATH);
  const state = readJson(STATE_PATH, { generatedAt: null, stores: {} });

  const syncable = config.stores.filter((s) => s.syncFromGoogle !== false);
  const withPlaceIds = syncable.filter((s) => s.placeId);
  const missing = syncable.filter((s) => !s.placeId);

  if (withPlaceIds.length === 0 && !FIXTURE) {
    console.error(`No stores have a placeId yet. Run: node resolve-place-ids.js --brand ${BRAND} --write`);
    process.exit(1);
  }

  const places = await fetchPlaces(withPlaceIds, FIXTURE);

  const applied = [];
  const held = [];
  const errored = [];
  const resolved = [];

  for (const store of config.stores) {
    const prior = state.stores[store.slug];
    const before = prior ? reviveWeek(prior.week) : null;
    const place = places.get(store.slug);

    // No Google data for this store: keep whatever we already had.
    if (!place || place.error) {
      if (place && place.error) {
        errored.push({ slug: store.slug, name: store.name, error: place.error });
      }
      if (before) resolved.push({ ...store, week: before });
      continue;
    }

    const after = h.fromGooglePeriods(place.regularOpeningHours);
    const verdict = gate.evaluate({ name: store.name, before, after, place });

    if (verdict.ok || ACCEPT_ALL) {
      resolved.push({ ...store, week: after });
      if (verdict.changed) applied.push({ ...verdict, slug: store.slug, week: after });
    } else {
      held.push({ ...verdict, slug: store.slug, proposed: h.formatCompact(after) });
      // Hold means: publish nothing new for this store, keep the current value.
      if (before) resolved.push({ ...store, week: before });
    }
  }

  const generatedAt = new Date().toISOString();
  const artifacts = generate(resolved, generatedAt, config.site.org);

  // ---- report -------------------------------------------------------------
  const lines = [];
  lines.push(`# Store hours sync — ${generatedAt}`);
  lines.push('');
  lines.push(`- checked: ${places.size}`);
  lines.push(`- applied: ${applied.length}`);
  lines.push(`- held for review: ${held.length}`);
  lines.push(`- errors: ${errored.length}`);
  if (missing.length) lines.push(`- no Place ID yet: ${missing.map((s) => s.slug).join(', ')}`);
  lines.push('');

  if (applied.length) {
    lines.push('## Applied');
    for (const a of applied) lines.push(`- ${a.summary}`);
    lines.push('');
  }
  if (held.length) {
    lines.push('## Held for review');
    for (const held_ of held) {
      lines.push(`- **${held_.slug}** — ${held_.reasons.join('; ')}`);
      lines.push(`  - proposed: \`${held_.proposed}\``);
    }
    lines.push('');
  }
  if (errored.length) {
    lines.push('## Errors');
    for (const e of errored) lines.push(`- ${e.slug}: ${e.error}`);
    lines.push('');
  }

  const report = lines.join('\n');
  console.log(report);

  if (DRY_RUN) {
    console.log('[dry-run] no files written, no CMS updates');
    return held.length > 0 ? 2 : 0;
  }

  // ---- write artifacts ----------------------------------------------------
  // Never replace good data with an empty roster. resolved is empty only
  // before a baseline exists (everything held) or in a catastrophic all-error
  // run; deploying an empty stores.js over a good one would flip every embed
  // to its baked-in fallback until the next successful sync.
  fs.mkdirSync(DIST_DIR, { recursive: true });
  if (resolved.length > 0) {
    for (const [name, contents] of Object.entries(artifacts)) {
      fs.writeFileSync(path.join(DIST_DIR, name), contents);
    }
    writeJson(STATE_PATH, {
      generatedAt,
      stores: Object.fromEntries(resolved.map((s) => [s.slug, { name: s.name, week: s.week }])),
    });
  } else {
    console.log('No stores resolved — keeping existing artifacts and state untouched.');
  }
  fs.writeFileSync(path.join(DIST_DIR, 'report.md'), report + '\n');

  // ---- push to Webflow ----------------------------------------------------
  if (applied.length > 0 && process.env.WEBFLOW_API_TOKEN) {
    const bySlug = new Map(resolved.map((s) => [s.slug, s]));
    const updates = applied
      .map((a) => {
        const store = bySlug.get(a.slug);
        const cfg = config.stores.find((s) => s.slug === a.slug);
        if (!store || !cfg || !cfg.webflowItemId) return null;
        return {
          id: cfg.webflowItemId,
          fieldData: { [config.site.hoursFieldSlug]: h.formatProse(store.week) },
        };
      })
      .filter(Boolean);

    if (updates.length) {
      // Artifacts and state are already on disk at this point. A CMS failure
      // is reported and retried on the next run rather than crashing, so the
      // run's other output still gets committed.
      try {
        await webflow.updateLiveItems(config.site.storesCollectionId, updates);
        console.log(`Updated ${updates.length} Webflow item(s).`);
      } catch (err) {
        console.error(`Webflow CMS update failed: ${err.message}`);
        return 3;
      }
    }
  } else if (applied.length > 0) {
    console.log('WEBFLOW_API_TOKEN not set — skipped CMS update.');
  }

  return held.length > 0 ? 2 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
