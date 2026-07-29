/**
 * Google Calendar's own reminders, on the timeline.
 *
 * Calendar can only push to a public HTTPS address, which pitwall does not
 * have, so the events are pulled: a poll keeps the next couple of days in
 * memory and a timer fires each reminder at the minute the event asked for.
 * What counts as a reminder is whatever the event says — its overrides, or the
 * calendar's defaults when it says `useDefault` — so the setting stays in
 * Google, where you already keep it, and this file has no notion of its own.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { config, paths } from './config.mjs';
import * as store from './store.mjs';
import { buildEntry } from './normalize.mjs';
import { apiGet, isLinked, NeedsLinkError } from './google-auth.mjs';
import { zonedMidnight } from './zoned.mjs';
import { plainText } from './html-text.mjs';

const API = 'https://www.googleapis.com/calendar/v3';
const SEEN_TTL_MS = 7 * 86_400_000;

/** Reminder keys already turned into a card, so a poll cannot repeat one. */
const seen = new Map();

let seenDirty = false;
let timer = null;
let running = false;
let nextPollAt = 0;
/** key → { atMs, make } for reminders whose moment has not come yet. */
let pending = new Map();
let complained = null;
/** Where "before anyone was listening" ends. See `fireDue`. */
const startedAt = Date.now();

function loadSeen() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.calendarSeen, 'utf8'));
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [key, at] of Object.entries(raw.seen ?? {})) {
      if (at > cutoff) seen.set(key, at);
    }
  } catch {
    /* first run, or a file we can rebuild by watching the sky again */
  }
}

function snapshot() {
  const cutoff = Date.now() - SEEN_TTL_MS;
  const out = {};
  for (const [key, at] of seen) {
    if (at > cutoff) out[key] = at;
    else seen.delete(key);
  }
  return JSON.stringify({ version: 1, seen: out });
}

async function saveSeen() {
  if (!seenDirty) return;
  seenDirty = false;
  try {
    await fsp.writeFile(paths.calendarSeen, snapshot(), 'utf8');
  } catch (error) {
    console.error('[pitwall] could not persist calendar state:', error.message);
  }
}

function markSeen(key) {
  seen.set(key, Date.now());
  seenDirty = true;
}

/** When an event's edge falls, as an instant. Shared with the agenda card. */
export function boundaryMs(edge, timeZone) {
  if (!edge) return null;
  if (edge.dateTime) return Date.parse(edge.dateTime);
  if (edge.date) return zonedMidnight(edge.date, edge.timeZone || timeZone);
  return null;
}

function fmt(ms, timeZone, opts) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, ...opts }).format(new Date(ms));
}

const DAY = { weekday: 'short', day: 'numeric', month: 'short' };
const CLOCK = { hour: '2-digit', minute: '2-digit', hour12: false };

function whenLine(startMs, endMs, allDay, timeZone) {
  if (allDay) {
    // Google's end date on an all-day event is the morning after it finishes.
    const lastMs = endMs - 86_400_000;
    const first = fmt(startMs, timeZone, DAY);
    if (lastMs - startMs < 43_200_000) return `${first} · all day`;
    return `${first} – ${fmt(lastMs, timeZone, DAY)} · all day`;
  }
  const sameDay = fmt(startMs, timeZone, DAY) === fmt(endMs, timeZone, DAY);
  const head = `${fmt(startMs, timeZone, DAY)} ${fmt(startMs, timeZone, CLOCK)}`;
  const tail = sameDay
    ? fmt(endMs, timeZone, CLOCK)
    : `${fmt(endMs, timeZone, DAY)} ${fmt(endMs, timeZone, CLOCK)}`;
  return `${head}–${tail}`;
}

function attendeeLine(event) {
  const others = (event.attendees || [])
    .filter((a) => !a.self && !a.resource && a.responseStatus !== 'declined')
    .map((a) => a.displayName || String(a.email || '').split('@')[0])
    .filter(Boolean);
  if (!others.length) return null;
  const shown = others.slice(0, 3).join(', ');
  const rest = others.length - 3;
  return rest > 0 ? `With ${shown} and ${rest} more` : `With ${shown}`;
}

export function meetLink(event) {
  if (event.hangoutLink) return event.hangoutLink;
  for (const point of event.conferenceData?.entryPoints || []) {
    if (point.entryPointType === 'video' && point.uri) return point.uri;
  }
  return null;
}

function bodyFor(event, startMs, endMs, allDay, timeZone) {
  const head = `**${whenLine(startMs, endMs, allDay, timeZone)}**`;
  const blocks = [event.location ? `${head} · ${event.location}` : head];

  const meet = meetLink(event);
  if (meet) blocks.push(`[Join the call](${meet})`);

  const withWhom = attendeeLine(event);
  if (withWhom) blocks.push(withWhom);

  const description = plainText(event.description);
  if (description) {
    blocks.push(description.length > 800 ? `${description.slice(0, 800)}…` : description);
  }

  // The way to the event is a button on the card, not a line under it.
  return blocks.join('\n\n');
}

/**
 * How many minutes before the start this event wants to be announced. An event
 * that overrides its calendar's defaults is taken at its word, including an
 * empty override list — that is somebody having switched the reminder off.
 * Popup and email say the same thing here, so the same minute is one card.
 */
function reminderMinutes(event, calendar) {
  const reminders = event.reminders || {};
  const list = reminders.useDefault === false
    ? reminders.overrides || []
    : calendar.defaultReminders || [];
  const minutes = new Set();
  for (const r of list) {
    const m = Number(r?.minutes);
    if (Number.isFinite(m) && m >= 0) minutes.add(m);
  }
  return [...minutes];
}

/** The note Google leaves on a task it has put on the grid. */
const TASK_URL = /https:\/\/tasks\.google\.com\/task\/([A-Za-z0-9_-]+)/;

/**
 * The task behind an event, where there is one.
 *
 * A task given a time in Google's own UI arrives here as a focus-time block,
 * indistinguishable from a focus-time block somebody meant to book — except
 * for the line Google adds to the description saying where to go to edit it.
 * That line names the task, in the short form the Tasks API spells base64url.
 */
export function taskOf(event) {
  if (event.eventType !== 'focusTime') return null;
  const found = TASK_URL.exec(event.description || '');
  if (!found) return null;
  return { taskId: Buffer.from(found[1], 'utf8').toString('base64url') };
}

export function skip(event) {
  if (event.status === 'cancelled') return true;
  // "In the office" markers are not appointments and nobody set a reminder on
  // them on purpose; they would still inherit the calendar's default.
  if (event.eventType === 'workingLocation') return true;
  // A task on the grid is a task, and it has a card of its own with the button
  // that ticks it off. Twice over it would be the same thing said two ways.
  if (taskOf(event)) return true;
  return (event.attendees || []).some((a) => a.self && a.responseStatus === 'declined');
}

export async function fetchCalendars() {
  const url = new URL(`${API}/users/me/calendarList`);
  url.searchParams.set('minAccessRole', 'reader');
  url.searchParams.set('maxResults', '250');
  const data = await apiGet(url);
  const all = data.items || [];
  const wanted = config.calendar.ids;
  const chosen = wanted.length
    ? all.filter((c) => wanted.includes(c.id) || (wanted.includes('primary') && c.primary))
    : all.filter((c) => c.selected !== false);
  return {
    /**
     * Google shows you every calendar in one zone — your own — and a card that
     * quoted a subscribed calendar's zone instead would name an hour you would
     * then have to convert. All-day reminders still count from the start of the
     * day where the event lives, which is why both zones are kept.
     */
    displayZone: (all.find((c) => c.primary) || chosen[0])?.timeZone
      || Intl.DateTimeFormat().resolvedOptions().timeZone,
    calendars: chosen.map((c) => ({
      id: c.id,
      name: c.summaryOverride || c.summary || c.id,
      timeZone: c.timeZone || 'UTC',
      defaultReminders: c.defaultReminders || [],
    })),
  };
}

export async function fetchEvents(calendar, fromMs, toMs) {
  const items = [];
  let pageToken = null;
  do {
    const url = new URL(`${API}/calendars/${encodeURIComponent(calendar.id)}/events`);
    url.searchParams.set('timeMin', new Date(fromMs).toISOString());
    url.searchParams.set('timeMax', new Date(toMs).toISOString());
    // Recurring events have to be expanded here: a reminder belongs to an
    // occurrence, and the series row carries no start to count back from.
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    // A shared calendar can run past one page inside the window, and the
    // reminders that fell off the end would go missing without a word.
    const data = await apiGet(url);
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken && items.length < 2000);
  return items;
}

function entryFor(calendar, event, startMs, endMs, allDay, minutes, displayZone) {
  const entry = buildEntry({
    agent: 'calendar',
    kind: 'notice',
    payload: {
      title: event.summary || '(no title)',
      notice: 'calendar-reminder',
      // The repo slot names the thing a card belongs to, and gives it its
      // colour. Every card off Google wears its service's colour, and the
      // slot's name is left to say which calendar it came off.
      repo: { key: 'gcal', name: calendar.name },
    },
    body: bodyFor(event, startMs, endMs, allDay, displayZone),
  });
  entry.calendar = {
    calendarId: calendar.id,
    eventId: event.id,
    startMs,
    endMs,
    allDay,
    leadMinutes: minutes,
    htmlLink: event.htmlLink || null,
  };
  return entry;
}

async function poll() {
  const now = Date.now();
  const { calendars, displayZone } = await fetchCalendars();
  // A calendar that asks for a day's notice needs its events loaded more than a
  // day out, or the moment to speak passes before the event is ever in view.
  const longestLead = Math.max(
    0,
    ...calendars.flatMap((c) => (c.defaultReminders || []).map((r) => Number(r.minutes) || 0)),
  );
  const horizon = now + (Math.max(config.calendar.lookaheadMinutes, longestLead) + 60) * 60_000;
  const next = new Map();

  for (const calendar of calendars) {
    // A reminder can be set further ahead than its event's own start, so the
    // window opens before now — anything already due is sorted out below.
    let events;
    try {
      events = await fetchEvents(calendar, now - 60_000, horizon);
    } catch (error) {
      // One calendar you can no longer read must not take the others down with
      // it. Say so once, and carry on with the rest.
      if (error instanceof NeedsLinkError) throw error;
      complain(`${calendar.name}: ${error.message}`);
      for (const [key, item] of pending) {
        if (key.startsWith(`${calendar.id}|`)) next.set(key, item);
      }
      continue;
    }
    for (const event of events) {
      if (skip(event)) continue;
      const startMs = boundaryMs(event.start, calendar.timeZone);
      if (startMs == null) continue;
      const allDay = !event.start?.dateTime;
      const endMs = boundaryMs(event.end, calendar.timeZone) ?? startMs + 3_600_000;

      for (const minutes of reminderMinutes(event, calendar)) {
        const atMs = startMs - minutes * 60_000;
        // Keyed on the start as well as the id, so an event moved to a new time
        // is a new reminder rather than one already spent.
        const key = `${calendar.id}|${event.id}|${startMs}|${minutes}`;
        if (seen.has(key)) continue;
        next.set(key, {
          atMs,
          endMs,
          make: () => entryFor(calendar, event, startMs, endMs, allDay, minutes, displayZone),
        });
      }
    }
  }

  pending = next;
}

function fireDue() {
  const now = Date.now();
  const stale = config.calendar.staleMinutes * 60_000;

  for (const [key, item] of pending) {
    if (item.atMs > now) continue;
    pending.delete(key);
    markSeen(key);
    // The meeting has already run: there is nothing left to be early for.
    if (item.endMs <= now) continue;
    // Late, and from before anyone was listening — the server was off when the
    // moment came. Swallow it rather than open with news that is over. A late
    // one from after the server started is a long notice on an event that only
    // just came into view, and saying it now is the whole point.
    if (item.atMs < startedAt && now - item.atMs > stale) continue;
    store.add(item.make());
  }
}

function schedule() {
  if (!running) return;
  let at = nextPollAt;
  for (const item of pending.values()) at = Math.min(at, item.atMs);
  const delay = Math.min(Math.max(at - Date.now(), 1000), config.calendar.pollSeconds * 1000);
  timer = setTimeout(cycle, delay);
  timer.unref?.();
}

/**
 * Say a thing like this once. The poll runs every couple of minutes forever,
 * and an unreachable Google would otherwise fill the log with one line a
 * minute saying what the first line said.
 */
function complain(message) {
  if (complained === message) return;
  complained = message;
  console.error(`[pitwall] calendar: ${message}`);
}

async function cycle() {
  timer = null;
  try {
    if (!isLinked()) {
      complain('no Google account linked — run `npm run link-google`');
      pending = new Map();
      nextPollAt = Date.now() + config.calendar.pollSeconds * 1000;
    } else if (Date.now() >= nextPollAt) {
      await poll();
      nextPollAt = Date.now() + config.calendar.pollSeconds * 1000;
      if (complained) {
        console.log('[pitwall] calendar: connected');
        complained = null;
      }
    }
    fireDue();
    await saveSeen();
  } catch (error) {
    if (error instanceof NeedsLinkError) complain(`${error.message} — run \`npm run link-google\``);
    else complain(error.message);
    nextPollAt = Date.now() + config.calendar.pollSeconds * 1000;
  }
  schedule();
}

export function start() {
  if (running) return false;
  running = true;
  loadSeen();
  cycle();
  return true;
}

/**
 * Written synchronously: shutdown does not wait on promises, and a reminder
 * recorded as fired but never written comes round again on the next boot.
 */
export function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  seenDirty = false;
  try {
    fs.writeFileSync(paths.calendarSeen, snapshot(), 'utf8');
  } catch (error) {
    console.error('[pitwall] could not persist calendar state:', error.message);
  }
}

export function status() {
  return {
    running,
    linked: isLinked(),
    pending: pending.size,
    nextPollAt: running ? nextPollAt : null,
  };
}

/** The pieces the tests drive directly, without the timer wrapped around them. */
export const internals = {
  taskOf,
  zonedMidnight,
  whenLine,
  reminderMinutes,
  plainText,
  bodyFor,
  skip,
  poll,
  fireDue,
  loadSeen,
  saveSeen,
  seen,
  pendingKeys: () => [...pending.keys()],
};
