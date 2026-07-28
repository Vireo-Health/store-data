/**
 * Consistency checks for every brand config under brands/.
 *
 * The brand sites' embeds join generated data by storeId / storeUrl. Those
 * embeds live in each brand's own (private) site repo, so they cannot be
 * checked from here — renaming a storeId or storeUrl in an embed requires a
 * matching config change, and vice versa. What CAN be checked centrally is
 * everything internal to the configs, which is where most mistakes happen.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BRANDS_DIR = path.join(__dirname, '..', 'brands');
const brands = fs.readdirSync(BRANDS_DIR).filter((b) => !b.startsWith('.'));

test('at least one brand is configured', () => {
  assert.ok(brands.length > 0);
});

for (const brand of brands) {
  const config = JSON.parse(
    fs.readFileSync(path.join(BRANDS_DIR, brand, 'stores.config.json'), 'utf8')
  );

  test(`${brand}: site wiring is complete`, () => {
    for (const key of ['webflowSiteId', 'storesCollectionId', 'hoursFieldSlug']) {
      assert.ok(config.site && config.site[key], `site.${key} missing`);
    }
  });

  test(`${brand}: slugs are unique and carry a Webflow item id`, () => {
    const slugs = config.stores.map((s) => s.slug);
    assert.strictEqual(new Set(slugs).size, slugs.length, 'duplicate slug');
    for (const store of config.stores) {
      assert.ok(store.webflowItemId, `${store.slug} has no webflowItemId`);
    }
  });

  test(`${brand}: no two stores share a Place ID`, () => {
    const ids = config.stores.map((s) => s.placeId).filter(Boolean);
    assert.strictEqual(
      new Set(ids).size,
      ids.length,
      'two stores resolved to the same Google listing — one of them is wrong'
    );
  });

  test(`${brand}: excluded entries say why and hold no Place ID`, () => {
    for (const store of config.stores.filter((s) => s.syncFromGoogle === false)) {
      assert.ok(store.syncFromGoogleReason, `${store.slug} excluded without a reason`);
      assert.strictEqual(store.placeId, null, `${store.slug} should not have a Place ID`);
    }
  });

  test(`${brand}: variant storeIds and storeUrls are unique`, () => {
    const ids = [];
    const urls = [];
    for (const store of config.stores) {
      for (const v of store.variants || []) {
        ids.push(v.storeId);
        urls.push(v.storeUrl);
      }
    }
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate variant storeId');
    assert.strictEqual(new Set(urls).size, urls.length, 'duplicate variant storeUrl');
  });

  test(`${brand}: published output directory exists`, () => {
    // The brand's dist dir is committed; a missing directory means the brand
    // was configured but never synced, or the layout drifted.
    assert.ok(
      fs.existsSync(path.join(__dirname, '..', brand)),
      `expected published dir ${brand}/ at the repo root`
    );
  });
}
