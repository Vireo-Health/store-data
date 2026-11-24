const test = require('node:test');
const assert = require('node:assert');
const { splitByPublished } = require('./webflow');

const update = (id) => ({ id, fieldData: { 'store-hours': 'Monday - Sunday: 8:00am - 12:00am' } });

test('only published items take the live path', () => {
  const cms = [
    { id: 'live', isDraft: false, isArchived: false, lastPublished: '2026-11-09T23:51:33.927Z' },
    // A cutover's page waiting for launch: never published.
    { id: 'launch-tomorrow', isDraft: true, isArchived: false, lastPublished: null },
    { id: 'never-published', isDraft: false, isArchived: false, lastPublished: null },
    { id: 'unpublished-again', isDraft: true, isArchived: false, lastPublished: '2026-08-01T00:00:00Z' },
    { id: 'archived', isDraft: false, isArchived: true, lastPublished: '2026-08-01T00:00:00Z' },
  ];
  const { live, staged } = splitByPublished(cms.map((c) => update(c.id)), cms);
  assert.deepStrictEqual(live.map((u) => u.id), ['live']);
  assert.deepStrictEqual(staged.map((u) => u.id), [
    'launch-tomorrow',
    'never-published',
    'unpublished-again',
    'archived',
  ]);
});

test('an item missing from the listing keeps the live path, as before', () => {
  const { live, staged } = splitByPublished([update('unknown')], []);
  assert.deepStrictEqual(live.map((u) => u.id), ['unknown']);
  assert.deepStrictEqual(staged, []);
});
