const test = require('node:test');
const assert = require('node:assert');
const h = require('./hours');

/** Terse helper: build Google periods from "day open close" tuples (24h clock). */
function periods(...rows) {
  return {
    periods: rows.map(([day, oh, om, ch, cm, closeDay]) => ({
      open: { day, hour: oh, minute: om },
      close: { day: closeDay === undefined ? day : closeDay, hour: ch, minute: cm },
    })),
  };
}

// Santa Fe's real schedule — the case the old `Mon-Sat X, Sun Y` format could
// not express at all.
const SANTA_FE = periods(
  [1, 8, 0, 22, 0],
  [2, 8, 0, 22, 0],
  [3, 8, 0, 22, 0],
  [4, 8, 0, 22, 0],
  [5, 8, 0, 23, 0],
  [6, 8, 0, 23, 0],
  [0, 8, 0, 21, 0]
);

test('Santa Fe renders in every site format', () => {
  const week = h.fromGooglePeriods(SANTA_FE);
  assert.strictEqual(
    h.formatCompact(week),
    'Mon-Thu 8am-10pm, Fri-Sat 8am-11pm, Sun 8am-9pm'
  );
  assert.strictEqual(
    h.formatDotted(week),
    'Mon–Thu 8am–10pm · Fri–Sat 8am–11pm · Sun 8am–9pm'
  );
  assert.strictEqual(
    h.formatProse(week),
    'Monday - Thursday: 8:00am - 10:00pm\nFriday - Saturday: 8:00am - 11:00pm\nSunday: 8:00am - 9:00pm'
  );
});

test('uniform week collapses to Daily', () => {
  const rows = [0, 1, 2, 3, 4, 5, 6].map((d) => [d, 8, 0, 23, 0]);
  const week = h.fromGooglePeriods(periods(...rows));
  assert.strictEqual(h.formatCompact(week), 'Daily 8am-11pm');
  assert.strictEqual(h.formatDotted(week), 'Daily 8am–11pm');
});

test('half-hour times keep their minutes', () => {
  const rows = [0, 1, 2, 3, 4, 5, 6].map((d) => [d, 7, 30, 23, 30]);
  const week = h.fromGooglePeriods(periods(...rows));
  assert.strictEqual(h.formatCompact(week), 'Daily 7:30am-11:30pm');
});

test('noon and midnight read correctly', () => {
  assert.strictEqual(h.formatTime(0), '12am');
  assert.strictEqual(h.formatTime(720), '12pm');
  assert.strictEqual(h.formatTime(1440), '12am');
  assert.strictEqual(h.formatTime(1439), '11:59pm');
});

test('closed days are grouped and labelled', () => {
  // Albuquerque Delivery: Wed-Sat noon-7pm, closed Sun-Tue.
  const week = h.fromGooglePeriods(
    periods([3, 12, 0, 19, 0], [4, 12, 0, 19, 0], [5, 12, 0, 19, 0], [6, 12, 0, 19, 0])
  );
  assert.strictEqual(h.formatCompact(week), 'Mon-Tue Closed, Wed-Sat 12pm-7pm, Sun Closed');
});

test('open 24 hours is detected', () => {
  const week = h.fromGooglePeriods({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] });
  assert.strictEqual(h.formatCompact(week), 'Open 24 hours');
  assert.ok(h.isOpenNow(week, 'America/Denver'));
});

test('empty or missing periods yield a closed week', () => {
  assert.strictEqual(h.formatCompact(h.fromGooglePeriods(undefined)), 'Closed');
  assert.strictEqual(h.formatCompact(h.fromGooglePeriods({ periods: [] })), 'Closed');
});

test('past-midnight close is attributed to the opening day', () => {
  // Fri 8am -> Sat 1am.
  const week = h.fromGooglePeriods(periods([5, 8, 0, 1, 0, 6]));
  assert.strictEqual(week[5][0].closesNextDay, true);
  assert.strictEqual(week[5][0].close, 60);
  assert.strictEqual(week[6].length, 0);
});

test('split hours on one day survive parsing and schema output', () => {
  const week = h.fromGooglePeriods(periods([1, 8, 0, 12, 0], [1, 13, 0, 20, 0]));
  assert.strictEqual(week[1].length, 2);
  assert.deepStrictEqual(week[1].map((i) => [i.open, i.close]), [[480, 720], [780, 1200]]);
  // Both intervals reach the structured data, which has no ambiguity problem.
  assert.strictEqual(h.toSchemaOrg(week).length, 2);
});

test('isOpenNow respects the store timezone, not the viewer', () => {
  const week = h.fromGooglePeriods(SANTA_FE);
  // 2026-07-28 is a Tuesday. 03:00 UTC == 21:00 Mon in Denver -> open (to 10pm).
  assert.strictEqual(h.isOpenNow(week, 'America/Denver', new Date('2026-07-28T03:00:00Z')), true);
  // 05:00 UTC == 23:00 Mon in Denver -> closed.
  assert.strictEqual(h.isOpenNow(week, 'America/Denver', new Date('2026-07-28T05:00:00Z')), false);
  // 14:00 UTC == 08:00 Tue in Denver -> just opened.
  assert.strictEqual(h.isOpenNow(week, 'America/Denver', new Date('2026-07-28T14:00:00Z')), true);
});

test('isOpenNow handles trading past midnight', () => {
  // Open Fri 8am until Sat 1am, closed otherwise.
  const week = h.fromGooglePeriods(periods([5, 8, 0, 1, 0, 6]));
  // Sat 00:30 Denver == 06:30 UTC Sat. 2026-08-01 is a Saturday.
  assert.strictEqual(h.isOpenNow(week, 'America/Denver', new Date('2026-08-01T06:30:00Z')), true);
  // Sat 02:00 Denver == 08:00 UTC Sat -> shut.
  assert.strictEqual(h.isOpenNow(week, 'America/Denver', new Date('2026-08-01T08:00:00Z')), false);
});

test('schema.org spec groups consecutive days and skips closures', () => {
  const week = h.fromGooglePeriods(SANTA_FE);
  const spec = h.toSchemaOrg(week);
  assert.deepStrictEqual(spec, [
    {
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday'],
      opens: '08:00',
      closes: '22:00',
    },
    {
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: ['Friday', 'Saturday'],
      opens: '08:00',
      closes: '23:00',
    },
    {
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: ['Sunday'],
      opens: '08:00',
      closes: '21:00',
    },
  ]);

  const delivery = h.fromGooglePeriods(periods([3, 12, 0, 19, 0]));
  assert.strictEqual(h.toSchemaOrg(delivery).length, 1);
});

test('todayLabel reports the current day', () => {
  const week = h.fromGooglePeriods(SANTA_FE);
  // Friday 2026-07-31, 18:00 UTC == 12:00 Denver.
  assert.strictEqual(h.todayLabel(week, 'America/Denver', new Date('2026-07-31T18:00:00Z')), '8am–11pm');
});
