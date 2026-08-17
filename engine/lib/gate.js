/**
 * Sanity gate.
 *
 * Google listings can be edited by the public and by Google's own inference,
 * and those edits land on the live listing without the owner acting. This gate
 * decides which incoming changes are routine enough to publish unattended and
 * which get held for a human.
 */

const { daySignature, DAY_ABBR, formatCompact, MINUTES_PER_DAY } = require('./hours');

const DEFAULT_MAX_SHIFT_MINUTES = 240; // 4 hours

/**
 * An interval's close as minutes from its own opening day's midnight, so a
 * past-midnight close sorts after the times it follows.
 *
 * A close already at 1440 is midnight tonight and terminal. Baselines written
 * before 2026-08-17 stored midnight as { close: 1440, closesNextDay: true };
 * adding another day to those would put the close 24h late and read as a
 * 25h+ shift, which held four stores for review. Both shapes land on 1440 here.
 */
function effectiveClose(interval) {
  if (!interval.closesNextDay || interval.close >= MINUTES_PER_DAY) return interval.close;
  return interval.close + MINUTES_PER_DAY;
}

/** Total minutes a week is open, treating past-midnight closes correctly. */
function weeklyOpenMinutes(week) {
  let total = 0;
  for (const day of week) {
    for (const interval of day) {
      total += Math.max(0, effectiveClose(interval) - interval.open);
    }
  }
  return total;
}

function openDayCount(week) {
  return week.filter((d) => d.length > 0).length;
}

/**
 * Largest single open-time or close-time movement between two weeks, in
 * minutes. Days that flip open<->closed are reported separately, not here.
 */
function maxShiftMinutes(before, after) {
  let max = 0;
  for (let d = 0; d < 7; d++) {
    const a = before[d];
    const b = after[d];
    if (a.length === 0 || b.length === 0) continue;
    if (a.length !== b.length) continue;
    for (let i = 0; i < a.length; i++) {
      const shift = Math.abs(effectiveClose(b[i]) - effectiveClose(a[i]));
      max = Math.max(max, Math.abs(b[i].open - a[i].open), shift);
    }
  }
  return max;
}

/** Days that changed between two weeks, as short labels. */
function changedDays(before, after) {
  const out = [];
  for (let d = 0; d < 7; d++) {
    if (daySignature(before[d]) !== daySignature(after[d])) out.push(DAY_ABBR[d]);
  }
  return out;
}

/**
 * Evaluate a proposed change.
 *
 * Returns { changed, ok, reasons, summary }. `ok: false` means hold and alert
 * rather than publish. A store with no prior state is always held on first run
 * so a human confirms the baseline.
 */
function evaluate({ name, before, after, place, maxShift = DEFAULT_MAX_SHIFT_MINUTES }) {
  const reasons = [];

  const status = place && place.businessStatus;
  if (status && status !== 'OPERATIONAL') {
    reasons.push(`Google reports business status ${status}`);
  }

  if (!place || !place.regularOpeningHours) {
    reasons.push('Google returned no regular opening hours');
    return {
      changed: false,
      ok: false,
      reasons,
      summary: `${name}: no hours from Google — keeping existing values`,
    };
  }

  if (!before) {
    return {
      changed: true,
      ok: false,
      reasons: ['no stored baseline yet — first run needs confirmation'],
      summary: `${name}: new baseline ${formatCompact(after)}`,
    };
  }

  const changed = changedDays(before, after);
  if (changed.length === 0) {
    // Hours are identical, but a listing-level problem (e.g. Google marking the
    // store temporarily closed) still needs a human — the site would otherwise
    // keep advertising a store Google considers shut.
    return {
      changed: false,
      ok: reasons.length === 0,
      reasons,
      summary:
        reasons.length === 0
          ? `${name}: unchanged`
          : `${name}: hours unchanged but ${reasons.join('; ')}`,
    };
  }

  if (openDayCount(after) === 0 && openDayCount(before) > 0) {
    reasons.push('every day would become closed');
  }

  const closedDays = [];
  for (let d = 0; d < 7; d++) {
    if (before[d].length > 0 && after[d].length === 0) closedDays.push(DAY_ABBR[d]);
  }
  if (closedDays.length > 0) {
    reasons.push(`${closedDays.join(', ')} would change from open to closed`);
  }

  const shift = maxShiftMinutes(before, after);
  if (shift > maxShift) {
    reasons.push(
      `a time moves by ${Math.round((shift / 60) * 10) / 10}h (limit ${maxShift / 60}h)`
    );
  }

  const beforeMinutes = weeklyOpenMinutes(before);
  const afterMinutes = weeklyOpenMinutes(after);
  if (beforeMinutes > 0 && afterMinutes / beforeMinutes <= 0.5) {
    reasons.push('weekly open hours would be cut in half or more');
  }

  return {
    changed: true,
    ok: reasons.length === 0,
    reasons,
    summary: `${name}: ${formatCompact(before)}  ->  ${formatCompact(after)}  [${changed.join(', ')}]`,
  };
}

/** Digits-only form, so formatting differences never read as a change. */
function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Evaluate a proposed phone change. Same contract as evaluate(), for one
 * field. Filling in a blank publishes unattended; replacing an existing
 * number is always held — a hijacked listing's most damaging edit is a
 * swapped phone number, and legitimate changes are rare enough that a human
 * glance costs nothing. Google returning no phone keeps the current value:
 * blanking good data is never routine.
 */
function evaluatePhone({ name, before, after }) {
  if (!phoneDigits(after)) {
    return { changed: false, ok: true, reasons: [], summary: `${name}: no phone from Google` };
  }
  if (phoneDigits(before) === phoneDigits(after)) {
    return { changed: false, ok: true, reasons: [], summary: `${name}: phone unchanged` };
  }
  if (!phoneDigits(before)) {
    return { changed: true, ok: true, reasons: [], summary: `${name}: phone filled in as ${after}` };
  }
  return {
    changed: true,
    ok: false,
    reasons: [`phone would change from ${before} to ${after}`],
    summary: `${name}: phone ${before}  ->  ${after}`,
  };
}

/**
 * Audit a listing's website against the brand's domain. Report-only — nothing
 * is published from this field; a mismatch means the Google listing needs
 * fixing (stale URL after a brand conversion, a hijacked listing, or a
 * missing link) and that fix happens in Google Business Profile, not here.
 */
function auditWebsite({ websiteUri, expectedHost }) {
  if (!expectedHost) return { ok: true, reasons: [] };
  if (!websiteUri) return { ok: false, reasons: ['listing has no website set'] };
  let host;
  try {
    host = new URL(websiteUri).hostname.replace(/^www\./, '');
  } catch {
    return { ok: false, reasons: [`listing website is not a valid URL: ${websiteUri}`] };
  }
  if (host === expectedHost || host.endsWith(`.${expectedHost}`)) {
    return { ok: true, reasons: [] };
  }
  return {
    ok: false,
    reasons: [`listing website points at ${host}, expected ${expectedHost}`],
  };
}

module.exports = {
  evaluate,
  evaluatePhone,
  phoneDigits,
  auditWebsite,
  weeklyOpenMinutes,
  openDayCount,
  maxShiftMinutes,
  changedDays,
  DEFAULT_MAX_SHIFT_MINUTES,
};
