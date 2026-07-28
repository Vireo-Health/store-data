const test = require('node:test');
const assert = require('node:assert');
const { scoreCandidate } = require('./resolve-place-ids');

const STORE = { slug: 'x', address: '1541 Appaloosa Dr' };

function candidate(overrides) {
  return {
    placeId: 'ChIJtest',
    name: 'R. Greenleaf Dispensary',
    address: '1541 Appaloosa Dr, Sunland Park, NM 88063',
    businessStatus: 'OPERATIONAL',
    ...overrides,
  };
}

test('brand name + matching street number is confident', () => {
  const r = scoreCandidate(STORE, candidate());
  assert.strictEqual(r.confident, true);
  assert.deepStrictEqual(r.reasons, []);
});

test('a different business at the right address is refused', () => {
  const r = scoreCandidate(STORE, candidate({ name: 'Some Other Dispensary' }));
  assert.strictEqual(r.confident, false);
});

test('the right business at a different address is refused', () => {
  const r = scoreCandidate(STORE, candidate({ address: '9821 Montgomery Blvd NE' }));
  assert.strictEqual(r.confident, false);
  assert.match(r.reasons.join(' '), /street number 9821/);
});

test('resolveNameAllow admits a converted listing still under the old brand', () => {
  const store = { ...STORE, resolveNameAllow: ['Every Day Weed'] };
  const r = scoreCandidate(store, candidate({ name: 'Every Day Weed Sunland Park' }));
  assert.strictEqual(r.confident, true);
});

test('resolveNameAllow does not open the door to arbitrary names', () => {
  const store = { ...STORE, resolveNameAllow: ['Every Day Weed'] };
  const r = scoreCandidate(store, candidate({ name: 'Ultra Health Sunland Park' }));
  assert.strictEqual(r.confident, false);
});

test('resolveNameAllow still requires the street number to match', () => {
  const store = { ...STORE, resolveNameAllow: ['Every Day Weed'] };
  const r = scoreCandidate(
    store,
    candidate({ name: 'Every Day Weed Sunland Park', address: '200 Main St, Sunland Park, NM' })
  );
  assert.strictEqual(r.confident, false);
});

test('a permanently closed listing is refused even with the right name', () => {
  const r = scoreCandidate(STORE, candidate({ businessStatus: 'CLOSED_PERMANENTLY' }));
  assert.strictEqual(r.confident, false);
  assert.match(r.reasons.join(' '), /CLOSED_PERMANENTLY/);
});
