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

// ---- special days ----------------------------------------------------------

const vm = require('node:vm');
const { buildStoresJs } = require('./generate');

/** Run the published stores.js as a browser would and hand back RG_HOURS. */
function runtime(records = []) {
  const window = {};
  vm.runInNewContext(buildStoresJs(records, '2026-11-24T00:00:00Z'), { window });
  return window.RG_HOURS;
}

// Arrays made inside the sandbox have the sandbox's prototypes, which
// deepStrictEqual counts as a difference. Compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));

// Every day 8am to midnight, like most of LivWell.
const MIDNIGHT = { open: 480, close: 1440, closesNextDay: false };
// Every day 8am to 2am the next morning.
const LATE = { open: 480, close: 120, closesNextDay: true };

function weekOf(interval) {
  return [0, 1, 2, 3, 4, 5, 6].map(() => [interval]);
}

const THANKSGIVING = '2026-11-26';
// Denver is UTC-7 in late November.
const denver = (date, time) => new Date(`${date}T${time}:00-07:00`);

test('records and JSON-LD carry special days; none means [] and no JSON-LD key', () => {
  const special = [{ date: THANKSGIVING, segments: [] }];
  const records = buildRecords([store({ special }), store({ slug: 'plain' })]);
  assert.deepStrictEqual(records[0].special, special);
  assert.deepStrictEqual(records[1].special, []);

  const schema = buildSchema([store({ special }), store({ slug: 'plain' })]);
  assert.deepStrictEqual(schema.testville.specialOpeningHoursSpecification, [
    {
      '@type': 'OpeningHoursSpecification',
      validFrom: THANKSGIVING,
      validThrough: THANKSGIVING,
      opens: '00:00',
      closes: '00:00',
    },
  ]);
  assert.strictEqual('specialOpeningHoursSpecification' in schema.plain, false);
});

test('runtime: a special day replaces the week on its date', () => {
  const RG = runtime();
  const s = {
    timezone: 'America/Denver',
    week: weekOf(MIDNIGHT),
    special: [{ date: THANKSGIVING, segments: [{ open: 480, close: 1260, closesNextDay: false }] }],
  };
  assert.strictEqual(RG.todayHours(s, denver(THANKSGIVING, '12:00')), '8am–9pm');
  assert.strictEqual(RG.isOpenNow(s, denver(THANKSGIVING, '20:30')), true);
  assert.strictEqual(RG.isOpenNow(s, denver(THANKSGIVING, '21:30')), false);
  // The day before and after are untouched.
  assert.strictEqual(RG.todayHours(s, denver('2026-11-25', '12:00')), '8am–12am');
  assert.strictEqual(RG.isOpenNow(s, denver('2026-11-27', '21:30')), true);
});

test('runtime: a special day closed outright', () => {
  const RG = runtime();
  const s = { timezone: 'America/Denver', week: weekOf(MIDNIGHT), special: [{ date: THANKSGIVING, segments: [] }] };
  assert.strictEqual(RG.todayHours(s, denver(THANKSGIVING, '12:00')), 'Closed');
  assert.strictEqual(RG.isOpenNow(s, denver(THANKSGIVING, '12:00')), false);
});

test('runtime: the date is the store-local date, not UTC', () => {
  const RG = runtime();
  const s = { timezone: 'America/Denver', week: weekOf(MIDNIGHT), special: [{ date: THANKSGIVING, segments: [] }] };
  // 23:30 Wed in Denver is already Thursday in UTC — still a normal Wednesday.
  assert.strictEqual(RG.isOpenNow(s, denver('2026-11-25', '23:30')), true);
  assert.strictEqual(RG.todayHours(s, denver('2026-11-25', '23:30')), '8am–12am');
});

test("runtime: yesterday's special overnight hours carry past midnight", () => {
  const RG = runtime();
  const s = {
    timezone: 'America/Denver',
    week: weekOf(MIDNIGHT),
    special: [{ date: THANKSGIVING, segments: [{ open: 600, close: 120, closesNextDay: true }] }],
  };
  assert.strictEqual(RG.isOpenNow(s, denver('2026-11-27', '01:00')), true);
  assert.strictEqual(RG.isOpenNow(s, denver('2026-11-27', '03:00')), false);
});

test("runtime: a closed special day still lets yesterday's regular hours run out", () => {
  const RG = runtime();
  const s = { timezone: 'America/Denver', week: weekOf(LATE), special: [{ date: THANKSGIVING, segments: [] }] };
  // Wednesday's 8am-2am runs into Thanksgiving morning...
  assert.strictEqual(RG.isOpenNow(s, denver(THANKSGIVING, '01:00')), true);
  // ...but Thanksgiving itself is shut, so nothing carries into Friday.
  assert.strictEqual(RG.isOpenNow(s, denver(THANKSGIVING, '12:00')), false);
  assert.strictEqual(RG.isOpenNow(s, denver('2026-11-27', '01:00')), false);
});

test('runtime: holidayHours lists special days from today on', () => {
  const RG = runtime();
  const s = {
    timezone: 'America/Denver',
    week: weekOf(MIDNIGHT),
    special: [
      { date: '2026-11-28', segments: [{ open: 600, close: 1080, closesNextDay: false }] },
      { date: '2026-11-25', segments: [] },
      { date: THANKSGIVING, segments: [] },
      { date: '2026-12-01', segments: [{ open: 480, close: 720 }, { open: 780, close: 1260 }] },
    ],
  };
  assert.deepStrictEqual(plain(RG.holidayHours(s, denver(THANKSGIVING, '12:00'))), [
    { date: THANKSGIVING, label: 'Thu 11/26', hours: 'Closed', isToday: true },
    { date: '2026-11-28', label: 'Sat 11/28', hours: '10am–6pm', isToday: false },
    { date: '2026-12-01', label: 'Tue 12/1', hours: '8am–12pm, 1pm–9pm', isToday: false },
  ]);
});

test('runtime: data published before special days existed still works', () => {
  const RG = runtime();
  const s = { timezone: 'America/Denver', week: weekOf(MIDNIGHT) };
  assert.strictEqual(RG.isOpenNow(s, denver(THANKSGIVING, '22:00')), true);
  assert.strictEqual(RG.todayHours(s, denver(THANKSGIVING, '12:00')), '8am–12am');
  assert.deepStrictEqual(plain(RG.holidayHours(s, denver(THANKSGIVING, '12:00'))), []);
  assert.strictEqual(RG.isOpenNow(null), false);
  assert.strictEqual(RG.todayHours(undefined), '');
  assert.deepStrictEqual(plain(RG.holidayHours(null)), []);
});
