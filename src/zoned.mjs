/**
 * Clock arithmetic in somebody else's time zone.
 *
 * Both of the things pitwall pulls out of Google carry a bare calendar date
 * with no offset on it — an all-day event, a task's due date — and the moment
 * that date turns into is the one where the account lives, not where this
 * server happens to run.
 */

function offsetAt(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - ms;
}

/** A wall-clock time on a calendar date, as an instant. */
export function zonedTime(dateStr, timeZone, hour = 0, minute = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  const guess = wall - offsetAt(Date.UTC(y, m - 1, d, 12), timeZone);
  // A time that sits inside a DST shift lands an hour out on the first guess.
  return wall - offsetAt(guess, timeZone);
}

export function zonedMidnight(dateStr, timeZone) {
  return zonedTime(dateStr, timeZone);
}

/** Which calendar date an instant falls on, there. `YYYY-MM-DD`. */
export function zonedDate(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** The day after a calendar date, counted through that zone's own midnight. */
export function nextDate(dateStr, timeZone) {
  // Noon plus a day clears both directions of a DST shift without landing back
  // on the day it started.
  return zonedDate(zonedTime(dateStr, timeZone, 12) + 86_400_000, timeZone);
}
