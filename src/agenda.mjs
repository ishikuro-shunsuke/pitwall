/**
 * The day ahead, on the timeline.
 *
 * A reminder answers "this one, now"; it says nothing about the shape of the
 * day it belongs to. That is the other question, and it is only worth asking
 * once — so one card each morning, every event on it, and nothing to answer.
 *
 * There is no poll here. A day is known in advance, so the timer sleeps until
 * the hour and the events are read then: a card built at last night's poll
 * would quote a day that had since been rearranged.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { config, paths } from './config.mjs';
import * as store from './store.mjs';
import { buildEntry } from './normalize.mjs';
import { isLinked, linkedTimeZone, NeedsLinkError } from './google-auth.mjs';
import { fetchCalendars, fetchEvents, boundaryMs, meetLink, skip } from './calendar.mjs';
import * as todo from './todo.mjs';
import * as chatworkTask from './chatwork-task.mjs';
import { zonedTime, zonedDate, nextDate } from './zoned.mjs';

/**
 * What is owed today, wherever it is kept. Each still has its own card at its
 * own hour; this is the one place that says how many of them there are before
 * the day starts.
 */
const TASK_SOURCES = [
  { name: 'Google Tasks', from: todo },
  { name: 'Chatwork', from: chatworkTask },
];

const SEEN_TTL_MS = 7 * 86_400_000;
/** Longest the timer ever sleeps, so a link appearing is noticed the same hour. */
const CHECK_MS = 300_000;
/** After a Google that would not answer. Tomorrow is too long to wait. */
const RETRY_MS = 600_000;
const LOCATION_CHARS = 60;

/** Days already spoken for. */
const seen = new Map();

let seenDirty = false;
let timer = null;
let running = false;
let retryAt = 0;
let complained = null;

function loadSeen() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.agendaSeen, 'utf8'));
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [day, at] of Object.entries(raw.seen ?? {})) {
      if (at > cutoff) seen.set(day, at);
    }
  } catch {
    /* first run, or a file we can rebuild by waiting for tomorrow */
  }
}

function snapshot() {
  const cutoff = Date.now() - SEEN_TTL_MS;
  const out = {};
  for (const [day, at] of seen) {
    if (at > cutoff) out[day] = at;
    else seen.delete(day);
  }
  return JSON.stringify({ version: 1, seen: out });
}

async function saveSeen() {
  if (!seenDirty) return;
  seenDirty = false;
  try {
    await fsp.writeFile(paths.agendaSeen, snapshot(), 'utf8');
  } catch (error) {
    console.error('[pitwall] could not persist agenda state:', error.message);
  }
}

function markSeen(day) {
  seen.set(day, Date.now());
  seenDirty = true;
}

function zone() {
  return config.agenda.timeZone
    || linkedTimeZone()
    || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Which day is owed a card, and when. Today until today has had one, and then
 * tomorrow — so an hour that passed with the server down is still delivered
 * when it comes back up, and a day that has turned is never delivered at all.
 */
function nextDue(timeZone, now) {
  const today = zonedDate(now, timeZone);
  const day = seen.has(today) ? nextDate(today, timeZone) : today;
  return { day, atMs: zonedTime(day, timeZone, config.agenda.hour) };
}

function fmt(ms, timeZone, opts) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, ...opts }).format(new Date(ms));
}

const DAY = { weekday: 'long', day: 'numeric', month: 'long' };
const CLOCK = { hour: '2-digit', minute: '2-digit', hour12: false };

/**
 * The hours an event takes out of this particular day. A meeting that started
 * yesterday or runs into tomorrow is clipped to the day the card is about,
 * because the times on the card are the times you have left.
 */
function span(item, dayStartMs, dayEndMs, timeZone) {
  if (item.allDay) return 'All day';
  const from = item.startMs < dayStartMs ? null : fmt(item.startMs, timeZone, CLOCK);
  const to = item.endMs > dayEndMs ? null : fmt(item.endMs, timeZone, CLOCK);
  if (!from && !to) return 'All day';
  if (!from) return `until ${to}`;
  if (!to) return `from ${from}`;
  return `${from}–${to}`;
}

function lineFor(item, dayStartMs, dayEndMs, timeZone) {
  const parts = [`**${span(item, dayStartMs, dayEndMs, timeZone)}** — ${item.title}`];
  if (item.location) {
    parts.push(item.location.length > LOCATION_CHARS
      ? `${item.location.slice(0, LOCATION_CHARS)}…`
      : item.location);
  }
  if (item.meet) parts.push(`[Join the call](${item.meet})`);
  return parts.join(' · ');
}

/** All-day first — it frames the rest — then in the order the day runs. */
function order(a, b) {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  return a.title.localeCompare(b.title);
}

/** Most overdue first: what has waited longest has waited longest. */
function taskOrder(a, b) {
  if (a.due !== b.due) return a.due < b.due ? -1 : 1;
  return a.title.localeCompare(b.title);
}

/**
 * A task has no hours to give, so the line carries only what an event's would
 * not already say — how far past its day it is, and which service is holding
 * it when that is not the obvious one.
 */
function taskLine(task) {
  const notes = [];
  // The hours first, where a task has any: it is the only thing on the line
  // that says where in the day it goes.
  if (task.at) notes.push(task.at);
  if (task.lateDays > 0) notes.push(`${task.lateDays} day${task.lateDays === 1 ? '' : 's'} late`);
  if (task.where) notes.push(task.where);
  return notes.length ? `${task.title} — ${notes.join(' · ')}` : task.title;
}

function bodyFor(items, tasks, missing, dayStartMs, dayEndMs, timeZone) {
  // Named off noon, which is the one hour of the day no shift can move onto
  // another date.
  const blocks = [`**${fmt(dayStartMs + 43_200_000, timeZone, DAY)}**`];
  if (items.length) {
    blocks.push(items.map((item) => lineFor(item, dayStartMs, dayEndMs, timeZone)).join('\n'));
  } else {
    // An empty diary is not an empty day when there is a list under it.
    blocks.push(tasks.length ? 'Nothing in the diary.' : 'Nothing on today.');
  }
  if (tasks.length) blocks.push(['**Still to do**', ...tasks.map(taskLine)].join('\n'));
  // A calendar or a list that would not answer leaves a hole in a card whose
  // whole claim is that it is the lot. Say where the hole is.
  if (missing.length) blocks.push(`Could not read ${missing.join(', ')}.`);
  return blocks.join('\n\n');
}

function titleFor(items, tasks = []) {
  const parts = [];
  if (items.length) parts.push(`${items.length} event${items.length === 1 ? '' : 's'}`);
  if (tasks.length) parts.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'}`);
  return parts.length ? `${parts.join(', ')} today` : 'Nothing on today';
}

/** Google's day view, opened on the day the card is about. */
function dayLink(day) {
  const [y, m, d] = day.split('-').map(Number);
  return `https://calendar.google.com/calendar/r/day/${y}/${m}/${d}`;
}

function entryFor(day, items, tasks, missing, dayStartMs, dayEndMs, timeZone) {
  const entry = buildEntry({
    agent: 'calendar',
    kind: 'notice',
    payload: {
      title: titleFor(items, tasks),
      notice: 'calendar-agenda',
      // The reminder cards name the calendar an event came off. This one is
      // every calendar at once, so the slot says what the card is instead.
      repo: { key: 'gcal', name: 'Today' },
    },
    body: bodyFor(items, tasks, missing, dayStartMs, dayEndMs, timeZone),
  });
  entry.agenda = {
    day,
    count: items.length,
    taskCount: tasks.length,
    missing,
    htmlLink: dayLink(day),
  };
  return entry;
}

async function collect(day, timeZone) {
  const dayStartMs = zonedTime(day, timeZone, 0);
  const dayEndMs = zonedTime(nextDate(day, timeZone), timeZone, 0);
  const { calendars } = await fetchCalendars();
  const items = [];
  const missing = [];
  // Invited on two calendars is one thing in the day, however many rows Google
  // has for it. A reminder can afford to repeat; a list cannot.
  const already = new Set();

  for (const calendar of calendars) {
    let events;
    try {
      events = await fetchEvents(calendar, dayStartMs, dayEndMs);
    } catch (error) {
      // One calendar you can no longer read must not take the day down with it.
      if (error instanceof NeedsLinkError) throw error;
      complain(`${calendar.name}: ${error.message}`);
      missing.push(calendar.name);
      continue;
    }

    for (const event of events) {
      if (skip(event)) continue;
      const startMs = boundaryMs(event.start, calendar.timeZone);
      if (startMs == null) continue;
      const key = `${event.iCalUID || event.id}|${startMs}`;
      if (already.has(key)) continue;
      already.add(key);
      items.push({
        title: event.summary?.trim() || '(no title)',
        startMs,
        endMs: boundaryMs(event.end, calendar.timeZone) ?? startMs + 3_600_000,
        allDay: !event.start?.dateTime,
        location: String(event.location || '').trim(),
        meet: meetLink(event),
      });
    }
  }

  const tasks = [];
  for (const source of TASK_SOURCES) {
    try {
      const owed = await source.from.outstanding(day, timeZone);
      tasks.push(...owed.tasks);
      missing.push(...owed.missing);
    } catch (error) {
      // A list nobody can read must not take the diary down with it.
      if (error instanceof NeedsLinkError) throw error;
      complain(`${source.name}: ${error.message}`);
      missing.push(source.name);
    }
  }

  items.sort(order);
  tasks.sort(taskOrder);
  return { items, tasks, missing, dayStartMs, dayEndMs };
}

async function deliver(day, timeZone) {
  const { items, tasks, missing, dayStartMs, dayEndMs } = await collect(day, timeZone);
  store.add(entryFor(day, items, tasks, missing, dayStartMs, dayEndMs, timeZone));
  markSeen(day);
  await saveSeen();
}

function schedule() {
  if (!running) return;
  const now = Date.now();
  const at = isLinked()
    ? Math.max(nextDue(zone(), now).atMs, retryAt)
    : now + CHECK_MS;
  const delay = Math.min(Math.max(at - now, 1000), CHECK_MS);
  timer = setTimeout(cycle, delay);
  timer.unref?.();
}

/** Once each, however long Google stays unreachable. */
function complain(message) {
  if (complained === message) return;
  complained = message;
  console.error(`[pitwall] agenda: ${message}`);
}

async function cycle() {
  timer = null;
  try {
    if (!isLinked()) {
      complain('no Google account linked — run `npm run link-google`');
    } else {
      const timeZone = zone();
      const { day, atMs } = nextDue(timeZone, Date.now());
      if (atMs <= Date.now()) {
        await deliver(day, timeZone);
        if (complained) {
          console.log('[pitwall] agenda: connected');
          complained = null;
        }
      }
    }
  } catch (error) {
    if (error instanceof NeedsLinkError) complain(`${error.message} — run \`npm run link-google\``);
    else complain(error.message);
    // The day is left unspoken for, so this is a retry rather than a skip.
    retryAt = Date.now() + RETRY_MS;
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
 * Written synchronously: shutdown does not wait on promises, and a morning
 * recorded as spoken but never written comes round again on the next boot.
 */
export function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  seenDirty = false;
  try {
    fs.writeFileSync(paths.agendaSeen, snapshot(), 'utf8');
  } catch (error) {
    console.error('[pitwall] could not persist agenda state:', error.message);
  }
}

export function status() {
  return {
    running,
    linked: isLinked(),
    nextAt: running && isLinked() ? nextDue(zone(), Date.now()).atMs : null,
  };
}

/** The pieces the tests drive directly, without the timer wrapped around them. */
export const internals = {
  zone,
  nextDue,
  span,
  lineFor,
  taskLine,
  titleFor,
  order,
  taskOrder,
  collect,
  deliver,
  cycle: () => cycle(),
  loadSeen,
  saveSeen,
  seen,
};
