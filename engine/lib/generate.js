/**
 * Turns the resolved store roster into the artifacts the site consumes.
 *
 *   stores.json        canonical data (per-day structure + every display format)
 *   stores.js          window.RG_STORES, loaded site-wide by Webflow
 *   store-schema.json  LocalBusiness JSON-LD keyed by CMS slug
 */

const h = require('./hours');

// Per-brand identity for the JSON-LD, from config.site. The fallback keeps
// pre-multibrand configs working.
const DEFAULT_ORG = {
  name: 'R.Greenleaf',
  url: 'https://rgreenleaf.com',
};

/**
 * Flatten the roster into the record shape the embeds already expect — one
 * entry per rec/med variant, since the store finder lists them separately.
 */
function buildRecords(stores, storePath = '/stores/') {
  const records = [];
  for (const store of stores) {
    const compact = h.formatCompact(store.week);
    const dotted = h.formatDotted(store.week);

    const base = {
      slug: store.slug,
      name: store.name,
      address: store.address,
      city: store.city,
      state: store.state,
      phone: store.phone || '',
      rating: typeof store.rating === 'number' ? store.rating : null,
      ratingCount: typeof store.ratingCount === 'number' ? store.ratingCount : null,
      lat: store.lat,
      lng: store.lng,
      shopId: store.shopId,
      timezone: store.timezone,
      hours: compact,
      hoursDotted: dotted,
      week: store.week,
      showInMap: store.showInMap !== false,
    };

    if (!store.variants || store.variants.length === 0) {
      records.push({ ...base, id: null, type: null, storeId: null, storeUrl: `${storePath}${store.slug}/` });
      continue;
    }

    for (const variant of store.variants) {
      records.push({
        ...base,
        id: variant.id,
        type: variant.type,
        storeId: variant.storeId,
        storeUrl: variant.storeUrl,
      });
    }
  }
  return records;
}

// Google star ratings are published in the records for on-page display, but
// deliberately NOT as aggregateRating here: Google's review-snippet policy
// forbids marking up ratings sourced from other sites (including Google
// itself), and violating it risks a structured-data manual action.
function buildSchema(stores, org = DEFAULT_ORG) {
  const out = {};
  for (const store of stores) {
    if (!store.address) continue;
    out[store.slug] = {
      '@context': 'https://schema.org',
      '@type': 'Store',
      name: `${org.name} ${store.name}`,
      url: `${org.url}${org.storePath || '/stores/'}${store.slug}/`,
      address: {
        '@type': 'PostalAddress',
        streetAddress: store.address,
        addressLocality: store.city,
        addressRegion: store.state,
        addressCountry: 'US',
      },
      ...(store.phone ? { telephone: store.phone } : {}),
      ...(store.lat != null && store.lng != null
        ? { geo: { '@type': 'GeoCoordinates', latitude: store.lat, longitude: store.lng } }
        : {}),
      openingHoursSpecification: h.toSchemaOrg(store.week),
    };
  }
  return out;
}

/**
 * The site-wide script. Kept dependency-free and tiny — it only publishes data
 * plus the two helpers the embeds need, so open/closed state is computed from
 * structured hours in the store's own timezone rather than parsed from text.
 */
function buildStoresJs(records, generatedAt, org = DEFAULT_ORG) {
  const runtime = `
(function () {
  var MIN_PER_DAY = 1440;
  var DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function nowInZone(tz, date) {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/Denver',
      weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false
    }).formatToParts(date || new Date());
    var o = {};
    for (var i = 0; i < parts.length; i++) o[parts[i].type] = parts[i].value;
    return { day: DAY.indexOf(o.weekday), minutes: (parseInt(o.hour, 10) % 24) * 60 + parseInt(o.minute, 10) };
  }

  function isOpenNow(store, date) {
    var week = store && store.week;
    if (!week) return false;
    var n = nowInZone(store.timezone, date);
    if (n.day < 0) return false;
    var today = week[n.day] || [];
    for (var i = 0; i < today.length; i++) {
      if (n.minutes < today[i].open) continue;
      if (today[i].closesNextDay || n.minutes < today[i].close) return true;
    }
    var yesterday = week[(n.day + 6) % 7] || [];
    for (var j = 0; j < yesterday.length; j++) {
      if (yesterday[j].closesNextDay && n.minutes < yesterday[j].close % MIN_PER_DAY) return true;
    }
    return false;
  }

  function fmt(m) {
    var t = m % MIN_PER_DAY, hh = Math.floor(t / 60), mm = t % 60;
    var s = hh < 12 ? 'am' : 'pm', h12 = hh % 12; if (h12 === 0) h12 = 12;
    return mm === 0 ? h12 + s : h12 + ':' + (mm < 10 ? '0' + mm : mm) + s;
  }

  function todayHours(store, date) {
    var week = store && store.week;
    if (!week) return '';
    var n = nowInZone(store.timezone, date);
    if (n.day < 0) return '';
    var day = week[n.day] || [];
    if (day.length === 0) return 'Closed';
    return day.map(function (i) { return fmt(i.open) + '\\u2013' + fmt(i.close); }).join(', ');
  }

  window.RG_HOURS = { isOpenNow: isOpenNow, todayHours: todayHours, nowInZone: nowInZone };
})();`.trim();

  return [
    `/* ${org.name} store data — generated by Vireo-Health/store-data. Do not edit by hand. */`,
    `/* Source: Google Places API. Generated ${generatedAt}. */`,
    `window.RG_STORES_GENERATED_AT = ${JSON.stringify(generatedAt)};`,
    `window.RG_STORES = ${JSON.stringify(records)};`,
    runtime,
    '',
  ].join('\n');
}

/** org: { name, url, storePath? } from config.site.org — brand identity for the
 *  JSON-LD and store-page URLs. storePath defaults to '/stores/' (R.Greenleaf);
 *  brands whose store pages live elsewhere (LivWell: '/locations/') set it in config. */
function generate(stores, generatedAt, org = DEFAULT_ORG) {
  const records = buildRecords(stores, (org && org.storePath) || '/stores/');
  return {
    'stores.json': JSON.stringify({ generatedAt, stores: records }, null, 2) + '\n',
    'stores.js': buildStoresJs(records, generatedAt, org),
    'store-schema.json': JSON.stringify(buildSchema(stores, org), null, 2) + '\n',
  };
}

module.exports = { generate, buildRecords, buildSchema, buildStoresJs };
