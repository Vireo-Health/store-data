const test = require('node:test');
const assert = require('node:assert');
const { generate, buildRecords, buildSchema } = require('./generate');

// A minimal valid store: open 8am–10pm every day.
function store(overrides = {}) {
  const day = [{ open: 480, close: 1320 }];
  return {
    slug: 'testville',
    name: 'Testville',
    address: '1 Main St',
    city: 'Testville',
    state: 'CO',
    timezone: 'America/Denver',
    week: [day, day, day, day, day, day, day],
    ...overrides,
  };
}

test('storeUrl defaults to /stores/ for variant-less stores', () => {
  const records = buildRecords([store()]);
  assert.strictEqual(records[0].storeUrl, '/stores/testville/');
});

test('org.storePath overrides the store-page path in records and JSON-LD', () => {
  const org = { name: 'LivWell', url: 'https://livwell.com', storePath: '/locations/' };
  const artifacts = generate([store()], '2026-01-01T00:00:00Z', org);
  const records = JSON.parse(artifacts['stores.json']).stores;
  assert.strictEqual(records[0].storeUrl, '/locations/testville/');
  const schema = JSON.parse(artifacts['store-schema.json']);
  assert.strictEqual(schema.testville.url, 'https://livwell.com/locations/testville/');
});

test('JSON-LD keeps the /stores/ default when org has no storePath', () => {
  const schema = buildSchema([store()], { name: 'R.Greenleaf', url: 'https://rgreenleaf.com' });
  assert.strictEqual(schema.testville.url, 'https://rgreenleaf.com/stores/testville/');
});
