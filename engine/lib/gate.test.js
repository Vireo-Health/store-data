const test = require('node:test');
const assert = require('node:assert');
const h = require('./hours');
const gate = require('./gate');

function week(...rows) {
  return h.fromGooglePeriods({
    periods: rows.map(([day, oh, om, ch, cm, closeDay]) => ({
      open: { day, hour: oh, minute: om },
      close: { day: closeDay === undefined ? day : closeDay, hour: ch, minute: cm },
    })),
  });
}

const ALL_DAYS = (oh, ch) => week(...[0, 1, 2, 3, 4, 5, 6].map((d) => [d, oh, 0, ch, 0]));
const OPERATIONAL = { businessStatus: 'OPERATIONAL', regularOpeningHours: { periods: [{}] } };

test('unchanged hours pass without a change flag', () => {
  const w = ALL_DAYS(8, 23);
  const r = gate.evaluate({ name: 'Yale', before: w, after: w, place: OPERATIONAL });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.ok, true);
});

test('a temporarily-closed listing is held even when hours are identical', () => {
  const w = ALL_DAYS(8, 23);
  const r = gate.evaluate({
    name: 'Roswell',
    before: w,
    after: w,
    place: { businessStatus: 'CLOSED_TEMPORARILY', regularOpeningHours: { periods: [{}] } },
  });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(' '), /CLOSED_TEMPORARILY/);
});

test('a routine one-hour shift auto-publishes', () => {
  const r = gate.evaluate({
    name: 'Yale',
    before: ALL_DAYS(8, 23),
    after: ALL_DAYS(8, 22),
    place: OPERATIONAL,
  });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.reasons, []);
});

// How Google actually reports a midnight close: 00:00 on the following day.
const ALL_DAYS_TO_MIDNIGHT = () =>
  week(...[0, 1, 2, 3, 4, 5, 6].map((d) => [d, 8, 0, 0, 0, (d + 1) % 7]));

test('pulling a midnight close back to 11pm is a one-hour shift, not 25h', () => {
  const r = gate.evaluate({
    name: 'Las Cruces',
    before: ALL_DAYS_TO_MIDNIGHT(),
    after: ALL_DAYS(8, 23),
    place: OPERATIONAL,
  });
  assert.strictEqual(gate.maxShiftMinutes(ALL_DAYS_TO_MIDNIGHT(), ALL_DAYS(8, 23)), 60);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.reasons, []);
});

test('a baseline storing midnight as closesNextDay does not read as a 24h shift', () => {
  // State written before the midnight-close fix. Re-parsing yields the same
  // wall-clock hours, so the gate must see no movement at all.
  const legacy = ALL_DAYS_TO_MIDNIGHT().map((d) => [{ ...d[0], closesNextDay: true }]);
  assert.strictEqual(gate.maxShiftMinutes(legacy, ALL_DAYS_TO_MIDNIGHT()), 0);
  assert.strictEqual(gate.weeklyOpenMinutes(legacy), gate.weeklyOpenMinutes(ALL_DAYS_TO_MIDNIGHT()));
  assert.strictEqual(gate.weeklyOpenMinutes(legacy), 7 * 16 * 60);
});

test('a genuine past-midnight close still counts into the next day', () => {
  // Fri 8am -> Sat 1am is 17 hours, and moving it to a 2am close is a 1h shift.
  const oneAm = week([5, 8, 0, 1, 0, 6]);
  const twoAm = week([5, 8, 0, 2, 0, 6]);
  assert.strictEqual(oneAm[5][0].closesNextDay, true);
  assert.strictEqual(gate.weeklyOpenMinutes(oneAm), 17 * 60);
  assert.strictEqual(gate.maxShiftMinutes(oneAm, twoAm), 60);
});

test('a five-hour swing is held', () => {
  const r = gate.evaluate({
    name: 'Yale',
    before: ALL_DAYS(8, 23),
    after: ALL_DAYS(8, 18),
    place: OPERATIONAL,
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(' '), /moves by 5h/);
});

test('a full-week closure is held', () => {
  const r = gate.evaluate({
    name: 'Yale',
    before: ALL_DAYS(8, 23),
    after: h.emptyWeek(),
    place: OPERATIONAL,
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(' '), /every day would become closed/);
});

test('losing a single day is held for review', () => {
  const after = week(
    [1, 8, 0, 23, 0],
    [2, 8, 0, 23, 0],
    [3, 8, 0, 23, 0],
    [4, 8, 0, 23, 0],
    [5, 8, 0, 23, 0],
    [6, 8, 0, 23, 0]
  );
  const r = gate.evaluate({ name: 'Yale', before: ALL_DAYS(8, 23), after, place: OPERATIONAL });
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(' '), /Sun would change from open to closed/);
});

test('a non-operational listing is held even when hours look fine', () => {
  const r = gate.evaluate({
    name: 'Yale',
    before: ALL_DAYS(8, 23),
    after: ALL_DAYS(8, 22),
    place: { businessStatus: 'CLOSED_TEMPORARILY', regularOpeningHours: { periods: [{}] } },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(' '), /CLOSED_TEMPORARILY/);
});

test('missing hours never overwrite existing values', () => {
  const r = gate.evaluate({
    name: 'Yale',
    before: ALL_DAYS(8, 23),
    after: h.emptyWeek(),
    place: { businessStatus: 'OPERATIONAL', regularOpeningHours: null },
  });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.ok, false);
});

test('first run is held so the baseline gets confirmed', () => {
  const r = gate.evaluate({
    name: 'Yale',
    before: null,
    after: ALL_DAYS(8, 23),
    place: OPERATIONAL,
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(' '), /no stored baseline/);
});

test('halving weekly open hours is held even within the shift limit', () => {
  // 8am-8pm (12h) -> 8am-2pm (6h): exactly half, the boundary case.
  const r = gate.evaluate({
    name: 'Yale',
    before: ALL_DAYS(8, 20),
    after: ALL_DAYS(8, 14),
    place: OPERATIONAL,
    maxShift: 600, // deliberately loose, to isolate the volume rule
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(' '), /cut in half or more/);
});

test('a modest trim stays under the volume rule', () => {
  // 12h/day -> 10h/day is a routine change, not an anomaly.
  const r = gate.evaluate({
    name: 'Yale',
    before: ALL_DAYS(8, 20),
    after: ALL_DAYS(8, 18),
    place: OPERATIONAL,
  });
  assert.strictEqual(r.ok, true);
});

test('Santa Fe gaining later Fri/Sat hours auto-publishes', () => {
  const before = week(...[1, 2, 3, 4, 5, 6].map((d) => [d, 8, 0, 22, 0]), [0, 8, 0, 21, 0]);
  const after = week(
    [1, 8, 0, 22, 0],
    [2, 8, 0, 22, 0],
    [3, 8, 0, 22, 0],
    [4, 8, 0, 22, 0],
    [5, 8, 0, 23, 0],
    [6, 8, 0, 23, 0],
    [0, 8, 0, 21, 0]
  );
  const r = gate.evaluate({ name: 'Santa Fe', before, after, place: OPERATIONAL });
  assert.strictEqual(r.ok, true);
  assert.match(r.summary, /Fri, Sat/);
});

test('a phone formatting difference is not a change', () => {
  const r = gate.evaluatePhone({ name: 'Clovis', before: '(575) 305-9223', after: '575-305-9223' });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.ok, true);
});

test('a phone fill-in from blank auto-publishes', () => {
  const r = gate.evaluatePhone({ name: 'Cottonwood', before: '', after: '(505) 555-0100' });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.ok, true);
  assert.match(r.summary, /filled in/);
});

test('a phone replacement is held for review', () => {
  const r = gate.evaluatePhone({
    name: 'Carlsbad',
    before: '(575) 305-7944',
    after: '(575) 555-0199',
  });
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(' '), /would change from/);
});

test('Google returning no phone keeps the current value', () => {
  const r = gate.evaluatePhone({ name: 'Yale', before: '(505) 217-9101', after: null });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.ok, true);
});

test('a listing website on the brand domain passes the audit', () => {
  for (const uri of [
    'https://rgreenleaf.com/stores/dispensary-carlsbad/',
    'https://www.rgreenleaf.com/',
    'https://shop.rgreenleaf.com/menu',
  ]) {
    const r = gate.auditWebsite({ websiteUri: uri, expectedHost: 'rgreenleaf.com' });
    assert.strictEqual(r.ok, true, uri);
  }
});

test('a listing website on a foreign domain is flagged', () => {
  const r = gate.auditWebsite({
    websiteUri: 'https://everydayweed.com/el-paso',
    expectedHost: 'rgreenleaf.com',
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(' '), /points at everydayweed\.com/);
});

test('a listing with no website is flagged', () => {
  const r = gate.auditWebsite({ websiteUri: null, expectedHost: 'rgreenleaf.com' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(' '), /no website/);
});

test('no expected host disables the audit', () => {
  const r = gate.auditWebsite({ websiteUri: 'https://anything.example', expectedHost: null });
  assert.strictEqual(r.ok, true);
});

test('a declared host listing passes the audit', () => {
  // Standing Akimbo's med counters trade inside another brand's dispensary and
  // share its listing, so the listing carries the host's domain by design.
  for (const uri of [
    'https://starbudscolorado.com/lakewood',
    'https://www.starbudscolorado.com/',
    'https://shop.starbudscolorado.com/menu',
  ]) {
    const r = gate.auditWebsite({
      websiteUri: uri,
      expectedHost: 'standingakimbo.com',
      allowHosts: ['starbudscolorado.com'],
    });
    assert.strictEqual(r.ok, true, uri);
  }
});

test('a declared host does not whitelist every other domain', () => {
  const r = gate.auditWebsite({
    websiteUri: 'https://everydayweed.com/brighton',
    expectedHost: 'standingakimbo.com',
    allowHosts: ['starbudscolorado.com'],
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reasons.join(' '), /points at everydayweed\.com/);
});
