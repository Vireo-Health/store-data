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

test('a close at exactly midnight ends the day rather than running into the next', () => {
  // Sat 8am -> Sun 00:00. Google reports this as a close on the following day,
  // but it is the end of Saturday, not trading into Sunday. Marking it
  // closesNextDay made every consumer add a second day to a close already
  // normalized to 1440, reading as a 25h shift and holding the store.
  const week = h.fromGooglePeriods(periods([6, 8, 0, 0, 0, 0]));
  assert.strictEqual(week[6][0].close, 1440);
  assert.strictEqual(week[6][0].closesNextDay, false);
  assert.strictEqual(week[0].length, 0);
  assert.strictEqual(h.formatIntervals(week[6], '-'), '8am-12am');
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

// ---- special days (currentOpeningHours) ------------------------------------
//
// Real responses captured 2026-11-24, when Thanksgiving (Thu 11/26) sat inside
// Google's 7-day window. places-livwell-2026-11-24.json is the LivWell roster
// verbatim; places-special-days.json is three public non-roster listings,
// stripped to hours, because no store of ours closes outright on a holiday.

const LIVWELL = require('../fixtures/places-livwell-2026-11-24.json');
const SPECIAL = require('../fixtures/places-special-days.json');

function regularWeek(place) {
  return h.fromGooglePeriods(place.regularOpeningHours);
}

/** The same real response, claiming different special dates. */
function withSpecialDays(place, ...dates) {
  return {
    ...place.currentOpeningHours,
    specialDays: dates.map((iso) => {
      const [year, month, day] = iso.split('-').map(Number);
      return { date: { year, month, day } };
    }),
  };
}

test('a holiday special day is read from the dated periods', () => {
  const place = LIVWELL['berthoud-dispensary'];
  const special = h.specialFromGoogle(place.currentOpeningHours, regularWeek(place));
  assert.deepStrictEqual(special, [
    { date: '2026-11-26', segments: [{ open: 480, close: 1260, closesNextDay: false }] },
  ]);
});

test('a dated midnight close reads like the regular one, so an unchanged day drops', () => {
  // Berthoud's Wed 11/25 period closes { hour: 0 } on 11/26 — the same shape
  // as the standing schedule's midnight close. Claiming it is special must
  // match the regular Wednesday and be dropped.
  const place = LIVWELL['berthoud-dispensary'];
  const current = withSpecialDays(place, '2026-11-25');
  assert.deepStrictEqual(h.specialFromGoogle(current, regularWeek(place)), []);
  assert.deepStrictEqual(h.specialFromGoogle(current), [
    { date: '2026-11-25', segments: [{ open: 480, close: 1440, closesNextDay: false }] },
  ]);
});

test('a close truncated at the window edge is read as midnight, not 11:59pm', () => {
  // Mon 11/30 is the last day of the window; Google cuts its period off at
  // 23:59 with truncated: true although the store closes at midnight.
  const place = LIVWELL['berthoud-dispensary'];
  const current = withSpecialDays(place, '2026-11-30');
  assert.deepStrictEqual(h.specialFromGoogle(current), [
    { date: '2026-11-30', segments: [{ open: 480, close: 1440, closesNextDay: false }] },
  ]);
  assert.deepStrictEqual(h.specialFromGoogle(current, regularWeek(place)), []);
});

test('a day closed outright is a special day with no periods', () => {
  // Thanksgiving is in specialDays, and no period opens on 11/26.
  const place = SPECIAL['closed-thanksgiving'];
  const special = h.specialFromGoogle(place.currentOpeningHours, regularWeek(place));
  assert.deepStrictEqual(special, [{ date: '2026-11-26', segments: [] }]);
  assert.strictEqual(h.formatIntervals(special[0].segments, '–'), 'Closed');
});

test('several special days come back in date order', () => {
  const place = SPECIAL['early-close-then-closed'];
  const special = h.specialFromGoogle(place.currentOpeningHours, regularWeek(place));
  assert.deepStrictEqual(special, [
    { date: '2026-11-25', segments: [{ open: 600, close: 960, closesNextDay: false }] },
    { date: '2026-11-26', segments: [] },
  ]);
});

test('a real 11:59pm close that is not truncated stays 11:59pm', () => {
  const place = SPECIAL['extended-holiday-weekend'];
  const special = h.specialFromGoogle(place.currentOpeningHours, regularWeek(place));
  assert.deepStrictEqual(
    special.map((d) => [d.date, h.formatIntervals(d.segments, '–')]),
    [
      ['2026-11-26', 'Closed'],
      ['2026-11-27', '6am–10pm'],
      ['2026-11-29', '7am–11:59pm'],
      ['2026-11-30', '7am–11:59pm'],
    ]
  );
});

test("a period carried over from yesterday is not counted as today's hours", () => {
  const point = (hour, extra = {}) => ({
    day: 4,
    hour,
    minute: 0,
    date: { year: 2026, month: 11, day: 26 },
    ...extra,
  });
  const current = {
    specialDays: [{ date: { year: 2026, month: 11, day: 26 } }],
    periods: [
      { open: point(0, { truncated: true }), close: point(2) },
      { open: point(10), close: point(18) },
    ],
  };
  assert.deepStrictEqual(h.specialFromGoogle(current), [
    { date: '2026-11-26', segments: [{ open: 600, close: 1080, closesNextDay: false }] },
  ]);
});

test('no special days, or no current hours at all, is an empty list', () => {
  const place = LIVWELL['berthoud-dispensary'];
  const { specialDays, ...withoutSpecial } = place.currentOpeningHours;
  assert.ok(specialDays);
  assert.deepStrictEqual(h.specialFromGoogle(withoutSpecial), []);
  assert.deepStrictEqual(h.specialFromGoogle(null), []);
  assert.deepStrictEqual(h.specialFromGoogle(undefined), []);
});

test("carrySpecial keeps yesterday's day for overnight carry-over, nothing older", () => {
  const prior = [
    { date: '2026-11-24', segments: [] },
    { date: '2026-11-25', segments: [{ open: 600, close: 120, closesNextDay: true }] },
    { date: '2026-11-26', segments: [] },
  ];
  const fresh = [{ date: '2026-11-26', segments: [{ open: 480, close: 1260, closesNextDay: false }] }];
  assert.deepStrictEqual(h.carrySpecial(fresh, prior, '2026-11-26'), [prior[1], fresh[0]]);
  // A fresh read is authoritative for today onward: Google dropping a day drops it.
  assert.deepStrictEqual(h.carrySpecial([], prior, '2026-11-26'), [prior[1]]);
  // No fresh read (fetch error): the last known days stand.
  assert.deepStrictEqual(h.carrySpecial(null, prior, '2026-11-26'), [prior[1], prior[2]]);
  assert.deepStrictEqual(h.carrySpecial(null, undefined, '2026-11-26'), []);
});

test('special days become dated schema.org specs; closed is 00:00-00:00', () => {
  assert.deepStrictEqual(
    h.toSchemaOrgSpecial([
      { date: '2026-11-26', segments: [] },
      { date: '2026-11-27', segments: [{ open: 480, close: 1440, closesNextDay: false }] },
    ]),
    [
      {
        '@type': 'OpeningHoursSpecification',
        validFrom: '2026-11-26',
        validThrough: '2026-11-26',
        opens: '00:00',
        closes: '00:00',
      },
      {
        '@type': 'OpeningHoursSpecification',
        validFrom: '2026-11-27',
        validThrough: '2026-11-27',
        opens: '08:00',
        closes: '23:59',
      },
    ]
  );
});

test('date helpers', () => {
  assert.strictEqual(h.formatDateLabel('2026-11-26'), 'Thu 11/26');
  assert.strictEqual(h.formatDateLabel('2026-12-01'), 'Tue 12/1');
  assert.strictEqual(h.addDays('2026-12-01', -1), '2026-11-30');
  // 06:30 UTC on the 26th is still the evening of the 25th in Denver.
  assert.strictEqual(h.dateInZone('America/Denver', new Date('2026-11-26T06:30:00Z')), '2026-11-25');
});
