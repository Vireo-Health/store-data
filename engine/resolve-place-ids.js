#!/usr/bin/env node
/**
 * One-time (and occasionally re-run) Place ID resolution.
 *
 * The CMS stores share.google short links, which are not Place IDs and cannot
 * be resolved server-side. This searches Places by name + address, biased to
 * each store's known coordinates, and writes the winning Place ID back into
 * stores.config.json.
 *
 * Anything ambiguous is reported rather than guessed — a wrong Place ID would
 * silently sync some other business's hours onto the site.
 *
 * Usage:
 *   node resolve-place-ids.js              report matches, write nothing
 *   node resolve-place-ids.js --write      persist confident matches
 *   node resolve-place-ids.js --only SLUG  restrict to one store
 */

const fs = require('fs');
const path = require('path');
const google = require('./lib/google');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 ? argv[i + 1] : null;
})();
const BRAND = (() => {
  const i = argv.indexOf('--brand');
  return i >= 0 ? argv[i + 1] : null;
})();

// require.main guard: when loaded by tests, BRAND is absent — that is fine,
// CONFIG_PATH is only read inside main().
if (require.main === module && (!BRAND || !/^[a-z0-9-]+$/.test(BRAND))) {
  console.error('Usage: node resolve-place-ids.js --brand <brand> [--write] [--only SLUG]');
  process.exit(1);
}

const CONFIG_PATH = BRAND
  ? path.join(__dirname, '..', 'brands', BRAND, 'stores.config.json')
  : null;

/** Loose comparison so "R.Greenleaf" matches "R. Greenleaf Dispensary". */
function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function streetNumber(address) {
  const m = (address || '').match(/^\s*(\d+)/);
  return m ? m[1] : null;
}

/**
 * A match is confident when an expected brand name appears and the street
 * number of the result matches the street number we expect.
 *
 * The expected brand name comes from config.site.org.name — do not hardcode a
 * brand here. A store acquired from another dispensary can keep the old brand
 * on its Google listing until the rename propagates. List the old name in the
 * store's `resolveNameAllow` (with a reason) to accept it — the street-number
 * and location-bias checks still gate the match.
 */
function scoreCandidate(store, candidate, brandName = 'Greenleaf') {
  const reasons = [];
  let confident = true;

  const allowedNames = [brandName, ...(store.resolveNameAllow || [])].map(normalize);
  const candidateName = normalize(candidate.name);
  if (!allowedNames.some((n) => n && candidateName.includes(n))) {
    reasons.push(
      `name "${candidate.name}" matches none of: ${allowedNames.join(', ')}`
    );
    confident = false;
  }

  const want = streetNumber(store.address);
  const got = streetNumber(candidate.address);
  if (want && got && want !== got) {
    reasons.push(`street number ${got} != expected ${want}`);
    confident = false;
  }
  if (want && !got) {
    reasons.push('could not read a street number from the result');
    confident = false;
  }

  if (candidate.businessStatus && candidate.businessStatus !== 'OPERATIONAL') {
    reasons.push(`business status ${candidate.businessStatus}`);
    confident = false;
  }

  return { confident, reasons };
}

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  // Some entries deliberately have no Google listing of their own — see
  // syncFromGoogleReason in the config. Resolving them would silently attach
  // another location's listing.
  const excluded = config.stores.filter((s) => s.syncFromGoogle === false);
  for (const store of excluded) {
    console.log(`— ${store.slug}: skipped (${store.syncFromGoogleReason || 'syncFromGoogle: false'})`);
  }

  const targets = config.stores.filter(
    (s) => s.syncFromGoogle !== false && (!ONLY || s.slug === ONLY) && (!s.placeId || ONLY)
  );

  if (targets.length === 0) {
    console.log('Every store already has a Place ID. Use --only SLUG to re-resolve one.');
    return 0;
  }

  let resolvedCount = 0;
  let ambiguous = 0;

  for (const store of targets) {
    const query = store.googleSearchQuery || `R.Greenleaf ${store.name} ${store.address || ''}`;
    let candidates;
    try {
      candidates = await google.findPlaceId(query, {
        locationBias: store.lat != null && store.lng != null ? { lat: store.lat, lng: store.lng } : null,
      });
    } catch (err) {
      console.log(`✗ ${store.slug}: search failed — ${err.message}`);
      ambiguous++;
      continue;
    }

    if (!candidates.length) {
      console.log(`✗ ${store.slug}: no results for "${query}"`);
      ambiguous++;
      continue;
    }

    const top = candidates[0];
    const brandName = (config.site.org && config.site.org.name) || undefined;
    const { confident, reasons } = scoreCandidate(store, top, brandName);

    if (confident) {
      console.log(`✓ ${store.slug}: ${top.placeId}  (${top.name} — ${top.address})`);
      store.placeId = top.placeId;
      resolvedCount++;
    } else {
      ambiguous++;
      console.log(`? ${store.slug}: needs a human — ${reasons.join('; ')}`);
      for (const c of candidates.slice(0, 3)) {
        console.log(`    ${c.placeId}  ${c.name} — ${c.address} [${c.businessStatus || 'unknown'}]`);
      }
    }
  }

  console.log(`\nresolved: ${resolvedCount}, needs review: ${ambiguous}`);

  if (WRITE && resolvedCount > 0) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
    console.log(`Wrote ${resolvedCount} Place ID(s) to stores.config.json`);

    // Mirror into the CMS so a Webflow editor can see which listing feeds each
    // location. stores.config.json stays canonical, so a failure here is
    // cosmetic — it must not fail the run and discard the resolved IDs.
    if (process.env.WEBFLOW_API_TOKEN) {
      const webflow = require('./lib/webflow');
      const updates = config.stores
        .filter((s) => s.placeId && s.webflowItemId)
        .map((s) => ({
          id: s.webflowItemId,
          fieldData: { [config.site.placeIdFieldSlug]: s.placeId },
        }));
      try {
        await webflow.updateLiveItems(config.site.storesCollectionId, updates);
        console.log(`Mirrored ${updates.length} Place ID(s) into the Webflow CMS.`);
      } catch (err) {
        console.log(`! CMS mirror failed (Place IDs are still saved locally): ${err.message}`);
      }
    } else {
      console.log('WEBFLOW_API_TOKEN not set — skipped the CMS mirror.');
    }
  } else if (resolvedCount > 0) {
    console.log('Re-run with --write to persist these.');
  }

  return ambiguous > 0 ? 2 : 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { scoreCandidate, normalize, streetNumber };
