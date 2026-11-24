/**
 * Canonical store-hours model + renderers.
 *
 * Everything on the site that displays hours goes through here, so the several
 * display formats can never drift apart again.
 *
 * Canonical shape ("week"): an array of 7 slots indexed the same way as
 * JS Date#getDay() and the Google Places API — 0 = Sunday .. 6 = Saturday.
 * Each slot is an array of intervals (usually 0 or 1; 2+ means split hours):
 *
 *   { open: 480, close: 1320, closesNextDay: false }   // minutes past midnight
 *
 * An empty array means closed that day. `close: 1440` means midnight.
 */

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SCHEMA_DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Display order used across the site: Monday first, Sunday last.
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const MINUTES_PER_DAY = 1440;

/** Build an empty week (every day closed). */
function emptyWeek() {
  return [[], [], [], [], [], [], []];
}

/**
 * Convert a Google Places API (New) `regularOpeningHours` object into a week.
 *
 * Google gives `periods: [{ open: {day, hour, minute}, close: {day, hour, minute} }]`.
 * A period with no `close` means the place is open 24h from that point.
 */
function fromGooglePeriods(regularOpeningHours) {
  const week = emptyWeek();
  const periods = regularOpeningHours && regularOpeningHours.periods;
  if (!Array.isArray(periods) || periods.length === 0) return week;

  // Google's documented signal for "open 24/7": a single period, open day 0
  // at 00:00, with no close.
  if (periods.length === 1 && !periods[0].close) {
    for (let d = 0; d < 7; d++) {
      week[d] = [{ open: 0, close: MINUTES_PER_DAY, closesNextDay: false }];
    }
    return week;
  }

  for (const period of periods) {
    if (!period.open) continue;
    const day = period.open.day;
    if (typeof day !== 'number' || day < 0 || day > 6) continue;
    week[day].push(intervalFromPeriod(period));
  }

  for (let d = 0; d < 7; d++) week[d].sort((a, b) => a.open - b.open);
  return week;
}

function pointMinutes(point) {
  return (point.hour || 0) * 60 + (point.minute || 0);
}

/**
 * One Google period as one interval of the canonical shape. Shared by the
 * standing schedule and the dated special-day periods, so midnight means the
 * same thing in both.
 */
function intervalFromPeriod(period) {
  const open = pointMinutes(period.open);
  if (!period.close) return { open, close: MINUTES_PER_DAY, closesNextDay: false };

  let close = pointMinutes(period.close);
  let closesNextDay = false;
  // A close on a later day (or an earlier clock time on the same day) means
  // the store trades past midnight.
  if (period.close.day !== period.open.day || close <= open) {
    // Closing exactly at midnight ends this day rather than running into the
    // next one, so it stays a same-day interval ending at 1440. Setting both
    // close = 1440 and closesNextDay would double-count: consumers add a day
    // to a closesNextDay interval, putting the close 24h too late.
    if (close === 0) close = MINUTES_PER_DAY;
    else closesNextDay = true;
  }
  return { open, close, closesNextDay };
}

/** Google's { year, month, day } as "YYYY-MM-DD", or null if incomplete. */
function isoDate(d) {
  if (!d || !d.year || !d.month || !d.day) return null;
  return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
}

/** Day of week (0 = Sunday) of a "YYYY-MM-DD" calendar date. */
function weekdayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "YYYY-MM-DD" shifted by whole days. Pure calendar math, no timezone. */
function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Today's calendar date ("YYYY-MM-DD") in an IANA timezone. */
function dateInZone(timeZone = 'America/Denver', date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const o = {};
  for (const part of parts) o[part.type] = part.value;
  return `${o.year}-${o.month}-${o.day}`;
}

/**
 * Special days (holidays, temporary closures) from Google's
 * `currentOpeningHours`, as [{ date: "YYYY-MM-DD", segments }] sorted by date.
 * `segments` has the same interval shape as a `week` slot; empty means closed
 * all day. Dates are the store's local calendar dates — Google reports the
 * dated periods in the place's own timezone.
 *
 * `currentOpeningHours` covers the 7 days from local midnight today. Google
 * lists the dates with special hours in `specialDays`; the hours themselves
 * are the `periods` whose open falls on that date. Shapes seen in real
 * responses (engine/fixtures/places-special-days.json, captured 2026-11-24):
 *
 *   - a midnight close is { hour: 0, minute: 0 } on the NEXT date, exactly as
 *     in the regular schedule;
 *   - the period running into the end of the window is cut off at 23:59 with
 *     `truncated: true` — the real close is at or after midnight, so it is
 *     read as midnight (the next day's sync sees the untruncated period);
 *   - a period carried over from before the window opens at 00:00 today with
 *     `truncated: true`. It belongs to yesterday, so it is skipped.
 *
 * A special day identical to the standing hours for its weekday is dropped:
 * `week` already says the same thing.
 */
function specialFromGoogle(currentOpeningHours, week) {
  const current = currentOpeningHours;
  if (!current || !Array.isArray(current.specialDays)) return [];
  const periods = Array.isArray(current.periods) ? current.periods : [];

  const byDate = new Map();
  for (const special of current.specialDays) {
    const date = isoDate(special && special.date);
    if (!date || byDate.has(date)) continue;

    const segments = [];
    for (const period of periods) {
      if (!period.open || period.open.truncated) continue;
      if (isoDate(period.open.date) !== date) continue;
      if (period.close && period.close.truncated) {
        segments.push({ open: pointMinutes(period.open), close: MINUTES_PER_DAY, closesNextDay: false });
        continue;
      }
      segments.push(intervalFromPeriod(period));
    }
    segments.sort((a, b) => a.open - b.open);

    if (week && daySignature(segments) === daySignature(week[weekdayOf(date)])) continue;
    byDate.set(date, { date, segments });
  }

  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * The special days to publish, from a fresh read (null when Google returned
 * nothing for the store) and the previously published days.
 *
 * Google's window starts at local midnight today, so a fresh read no longer
 * has yesterday's special day — but that day's overnight hours can still be
 * running when a sync lands after midnight. Yesterday's entry is carried for
 * one more day so the runtime's carry-over check still sees it. Without a
 * fresh read, the last known days are kept: held never means blank.
 */
function carrySpecial(fresh, prior, today) {
  const yesterday = addDays(today, -1);
  const kept = (Array.isArray(prior) ? prior : []).filter((s) => s && s.date >= yesterday);
  if (!fresh) return kept;
  const carried = kept.filter((s) => s.date === yesterday && !fresh.some((f) => f.date === s.date));
  return [...carried, ...fresh];
}

/** "Thu 11/26" for a "YYYY-MM-DD" date. */
function formatDateLabel(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${DAY_ABBR[weekdayOf(iso)]} ${m}/${d}`;
}

/** Stable string identity for a day's intervals, used for grouping. */
function daySignature(intervals) {
  if (!intervals || intervals.length === 0) return 'closed';
  return intervals.map((i) => `${i.open}-${i.close}${i.closesNextDay ? '+' : ''}`).join(',');
}

/** True if every day of the week is open midnight-to-midnight. */
function isAlwaysOpen(week) {
  return week.every(
    (day) => day.length === 1 && day[0].open === 0 && day[0].close >= MINUTES_PER_DAY
  );
}

/**
 * Collapse the week into runs of consecutive days (in display order) that share
 * identical hours. Returns [{ days: [dayIndex...], intervals, signature }].
 */
function groupWeek(week) {
  const groups = [];
  for (const dayIndex of DISPLAY_ORDER) {
    const intervals = week[dayIndex];
    const signature = daySignature(intervals);
    const last = groups[groups.length - 1];
    if (last && last.signature === signature) {
      last.days.push(dayIndex);
    } else {
      groups.push({ days: [dayIndex], intervals, signature });
    }
  }
  return groups;
}

/**
 * Format minutes-past-midnight as a compact display time.
 * 480 -> "8am", 690 -> "11:30am", 720 -> "12pm", 1440 -> "12am"
 */
function splitTime(minutes) {
  const m = minutes % MINUTES_PER_DAY;
  const hour24 = Math.floor(m / 60);
  const minute = m % 60;
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12, minute, suffix: hour24 < 12 ? 'am' : 'pm' };
}

function formatTime(minutes) {
  const { hour12, minute, suffix } = splitTime(minutes);
  return minute === 0 ? `${hour12}${suffix}` : `${hour12}:${String(minute).padStart(2, '0')}${suffix}`;
}

/** Always shows minutes — matches the CMS `store-hours` convention (8:00am). */
function formatTimePadded(minutes) {
  const { hour12, minute, suffix } = splitTime(minutes);
  return `${hour12}:${String(minute).padStart(2, '0')}${suffix}`;
}

function formatDayLabel(days, dash) {
  if (days.length === 1) return DAY_ABBR[days[0]];
  return `${DAY_ABBR[days[0]]}${dash}${DAY_ABBR[days[days.length - 1]]}`;
}

function formatIntervals(intervals, dash, timeFn = formatTime) {
  if (!intervals || intervals.length === 0) return 'Closed';
  return intervals.map((i) => `${timeFn(i.open)}${dash}${timeFn(i.close)}`).join(', ');
}

/**
 * Render a week using the given punctuation.
 *   dash      - between day names and between times
 *   separator - between groups
 */
function render(week, { dash = '-', separator = ', ' } = {}) {
  if (isAlwaysOpen(week)) return 'Open 24 hours';

  const groups = groupWeek(week);

  if (groups.length === 1) {
    const only = groups[0];
    if (only.signature === 'closed') return 'Closed';
    return `Daily ${formatIntervals(only.intervals, dash)}`;
  }

  return groups
    .map((g) => `${formatDayLabel(g.days, dash)} ${formatIntervals(g.intervals, dash)}`)
    .join(separator);
}

/** store-finder.html / store-finder-section.html style. */
function formatCompact(week) {
  return render(week, { dash: '-', separator: ', ' });
}

/** locations-map.html style: en dash + middot. */
function formatDotted(week) {
  return render(week, { dash: '–', separator: ' · ' });
}

/** Webflow CMS `store-hours` style: full day names, one group per line. */
function formatProse(week) {
  if (isAlwaysOpen(week)) return 'Open 24 hours';
  return groupWeek(week)
    .map((g) => {
      const label =
        g.days.length === 1
          ? DAY_FULL[g.days[0]]
          : `${DAY_FULL[g.days[0]]} - ${DAY_FULL[g.days[g.days.length - 1]]}`;
      return `${label}: ${formatIntervals(g.intervals, ' - ', formatTimePadded)}`;
    })
    .join('\n');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function toIsoTime(minutes) {
  const m = Math.min(minutes, MINUTES_PER_DAY - 1);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/**
 * schema.org `openingHoursSpecification` entries for a LocalBusiness node.
 * Groups are emitted as-is so consecutive identical days share one entry.
 */
function toSchemaOrg(week) {
  const specs = [];
  for (const group of groupWeek(week)) {
    if (group.signature === 'closed') continue;
    const dayOfWeek = group.days.map((d) => SCHEMA_DAY[d]);
    for (const interval of group.intervals) {
      specs.push({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek,
        opens: toIsoTime(interval.open),
        closes: toIsoTime(interval.close),
      });
    }
  }
  return specs;
}

/**
 * schema.org `specialOpeningHoursSpecification` entries for special days. Each
 * is pinned to its single date (validFrom = validThrough); a day closed
 * outright is opens = closes = "00:00", schema.org's marker for closed.
 */
function toSchemaOrgSpecial(special) {
  const specs = [];
  for (const day of special || []) {
    const base = {
      '@type': 'OpeningHoursSpecification',
      validFrom: day.date,
      validThrough: day.date,
    };
    if (!day.segments || day.segments.length === 0) {
      specs.push({ ...base, opens: '00:00', closes: '00:00' });
      continue;
    }
    for (const interval of day.segments) {
      specs.push({ ...base, opens: toIsoTime(interval.open), closes: toIsoTime(interval.close) });
    }
  }
  return specs;
}

/**
 * Current wall-clock day + minute in an IANA timezone.
 * Uses Intl rather than the browser's local clock so a customer in another
 * state still sees the store's real open/closed state.
 */
function nowInZone(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date);

  const lookup = {};
  for (const part of parts) lookup[part.type] = part.value;

  const day = DAY_ABBR.indexOf(lookup.weekday);
  // Intl can render midnight as "24" under hour12:false.
  const hour = parseInt(lookup.hour, 10) % 24;
  const minute = parseInt(lookup.minute, 10);
  return { day, minutes: hour * 60 + minute };
}

/**
 * Is the store open right now? Checks today's intervals plus any interval from
 * yesterday that runs past midnight.
 */
function isOpenNow(week, timeZone = 'America/Denver', date = new Date()) {
  const { day, minutes } = nowInZone(timeZone, date);
  if (day < 0) return false;

  for (const interval of week[day] || []) {
    if (minutes < interval.open) continue;
    // A closesNextDay interval runs to the end of today and beyond.
    if (interval.closesNextDay || minutes < interval.close) return true;
  }

  const yesterday = (day + 6) % 7;
  for (const interval of week[yesterday] || []) {
    if (interval.closesNextDay && minutes < interval.close % MINUTES_PER_DAY) return true;
  }

  return false;
}

/** Today's hours as a short display string, e.g. "8am-10pm" or "Closed". */
function todayLabel(week, timeZone = 'America/Denver', date = new Date()) {
  const { day } = nowInZone(timeZone, date);
  if (day < 0) return '';
  return formatIntervals(week[day], '–');
}

module.exports = {
  DAY_ABBR,
  DAY_FULL,
  DISPLAY_ORDER,
  MINUTES_PER_DAY,
  emptyWeek,
  fromGooglePeriods,
  specialFromGoogle,
  carrySpecial,
  isoDate,
  weekdayOf,
  addDays,
  dateInZone,
  formatDateLabel,
  toSchemaOrgSpecial,
  groupWeek,
  daySignature,
  isAlwaysOpen,
  formatTime,
  formatTimePadded,
  formatIntervals,
  formatCompact,
  formatDotted,
  formatProse,
  toSchemaOrg,
  isOpenNow,
  todayLabel,
  nowInZone,
  render,
};
