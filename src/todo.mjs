/**
 * Google Tasks, on the timeline.
 *
 * A task carries a due date and nothing else: the Tasks API drops the time of
 * day, and there are no reminders on it to inherit. So the hour is pitwall's
 * to choose — one card per task on the morning it is due, and again every
 * morning it stays undone, until it is ticked off in Google.
 *
 * Except when Google has put the task on the calendar grid, which is the one
 * place the time it was given survives. Then the card lands at that time
 * instead, and the calendar leaves the event alone: it is this card's task.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { config, paths } from './config.mjs';
import * as store from './store.mjs';
import { buildEntry } from './normalize.mjs';
import {
  apiGet, apiPatch, apiPost, isLinked, hasScope, linkedTimeZone, NeedsLinkError,
} from './google-auth.mjs';
import { fetchEvents, boundaryMs, taskOf } from './calendar.mjs';
import { zonedTime, zonedDate, nextDate } from './zoned.mjs';

const API = 'https://tasks.googleapis.com/tasks/v1';
const SCOPE = 'https://www.googleapis.com/auth/tasks';
const SEEN_TTL_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

/** `list|task|day` for every morning already spoken for. */
const seen = new Map();

let seenDirty = false;
let timer = null;
let running = false;
let nextPollAt = 0;
/** key → { atMs, make } for mornings that have not come round yet. */
let pending = new Map();
let complained = null;

function loadSeen() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.todoSeen, 'utf8'));
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [key, at] of Object.entries(raw.seen ?? {})) {
      if (at > cutoff) seen.set(key, at);
    }
  } catch {
    /* first run, or a file we can rebuild by asking Google again */
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
    await fsp.writeFile(paths.todoSeen, snapshot(), 'utf8');
  } catch (error) {
    console.error('[pitwall] could not persist todo state:', error.message);
  }
}

function markSeen(key) {
  seen.set(key, Date.now());
  seenDirty = true;
}

function zone() {
  return config.todo.timeZone
    || linkedTimeZone()
    || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Google hands the due date back as a UTC midnight; only the date is real. */
function dueDate(task) {
  const raw = String(task.due || '');
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

function fmtDate(dateStr, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(zonedTime(dateStr, timeZone, 12)));
}

/** Whole days between two calendar dates, counted through noon to dodge DST. */
function daysBetween(fromDate, toDate, timeZone) {
  const from = zonedTime(fromDate, timeZone, 12);
  const to = zonedTime(toDate, timeZone, 12);
  return Math.round((to - from) / DAY_MS);
}

function overdueLine(due, day, timeZone, block = null) {
  const clock = block ? ` · ${clockRange(block, timeZone)}` : '';
  const late = daysBetween(due, day, timeZone);
  if (late <= 0) return `**Due today**${clock}`;
  const plural = late === 1 ? 'day' : 'days';
  return `**Overdue by ${late} ${plural}** · was due ${fmtDate(due, timeZone)}${clock}`;
}

/**
 * Where Google has put a task on the grid, and when.
 *
 * Keyed by the day the block falls on rather than by the task alone: a task
 * that stays undone outlives its block, and tomorrow's card has no time of its
 * own to inherit.
 */
async function scheduled(days, timeZone) {
  const placed = new Map();
  const fromMs = zonedTime(days[0], timeZone, 0);
  const toMs = zonedTime(nextDate(days[days.length - 1], timeZone), timeZone, 0);
  let events;
  try {
    // Tasks land on the calendar you own, so there is one calendar to ask.
    events = await fetchEvents({ id: 'primary' }, fromMs, toMs);
  } catch (error) {
    // The times are a bonus. Without them every card lands on the hour, which
    // is where they all landed before Google started scheduling anything.
    if (error instanceof NeedsLinkError) throw error;
    complain(`could not read the grid for task times: ${error.message}`);
    return placed;
  }

  for (const event of events) {
    if (event.status === 'cancelled') continue;
    const task = taskOf(event);
    if (!task) continue;
    const startMs = boundaryMs(event.start, timeZone);
    if (startMs == null) continue;
    placed.set(`${task.taskId}|${zonedDate(startMs, timeZone)}`, {
      startMs,
      endMs: boundaryMs(event.end, timeZone) ?? startMs + 3_600_000,
    });
  }
  return placed;
}

/** The hours a scheduled task takes, for the card that announces it. */
function clockRange(block, timeZone) {
  if (!block) return '';
  const at = (ms) => new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));
  return `${at(block.startMs)}–${at(block.endMs)}`;
}

function linkLines(task) {
  return (task.links || [])
    .filter((l) => l?.link)
    .map((l) => `[${l.description || l.type || 'link'}](${l.link})`);
}

function bodyFor(task, due, day, timeZone, block = null) {
  const blocks = [overdueLine(due, day, timeZone, block)];

  const notes = String(task.notes || '').trim();
  if (notes) blocks.push(notes.length > 800 ? `${notes.slice(0, 800)}…` : notes);

  const links = linkLines(task);
  if (links.length) blocks.push(links.join('\n'));

  // The way to the task is a button on the card, not a line under it.
  return blocks.join('\n\n');
}

async function fetchLists() {
  const items = [];
  let pageToken = null;
  do {
    const url = new URL(`${API}/users/@me/lists`);
    url.searchParams.set('maxResults', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await apiGet(url);
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken && items.length < 500);

  const wanted = config.todo.listIds;
  const chosen = wanted.length ? items.filter((l) => wanted.includes(l.id)) : items;
  return chosen.map((l) => ({ id: l.id, name: l.title || l.id }));
}

async function fetchTasks(list, dueMaxMs) {
  const items = [];
  let pageToken = null;
  do {
    const url = new URL(`${API}/lists/${encodeURIComponent(list.id)}/tasks`);
    // Anything still open and due by the end of the window. No lower bound:
    // something a fortnight late is exactly what wants saying again.
    url.searchParams.set('dueMax', new Date(dueMaxMs).toISOString());
    url.searchParams.set('showCompleted', 'false');
    url.searchParams.set('showHidden', 'false');
    url.searchParams.set('maxResults', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await apiGet(url);
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken && items.length < 1000);
  return items;
}

function entryFor(list, task, due, day, timeZone, block = null) {
  const entry = buildEntry({
    agent: 'todo',
    kind: 'notice',
    payload: {
      title: task.title?.trim() || '(no title)',
      notice: 'task-due',
      // The repo slot names the thing a card belongs to, and gives it its
      // colour. Every card off Google wears its service's colour, and the
      // slot's name is left to say which list it came off.
      repo: { key: 'gtasks', name: list.name },
    },
    body: bodyFor(task, due, day, timeZone, block),
  });
  entry.todo = {
    listId: list.id,
    taskId: task.id,
    due,
    day,
    overdueDays: Math.max(0, daysBetween(due, day, timeZone)),
    startMs: block?.startMs ?? null,
    webViewLink: task.webViewLink || null,
  };
  return entry;
}

async function poll() {
  const now = Date.now();
  const timeZone = zone();
  const today = zonedDate(now, timeZone);
  const tomorrow = nextDate(today, timeZone);
  // Tomorrow is held ready so its morning does not depend on a poll landing
  // between the hour and the next one.
  const days = [today, tomorrow];
  const placed = await scheduled(days, timeZone);
  const lists = await fetchLists();
  const next = new Map();

  for (const list of lists) {
    let tasks;
    try {
      // A due date is a UTC midnight, so the last one that can matter is
      // tomorrow's — asked for with a day's slack, and sifted properly below.
      tasks = await fetchTasks(list, zonedTime(tomorrow, timeZone, 12) + DAY_MS);
    } catch (error) {
      // One list you can no longer read must not take the others down with it.
      if (error instanceof NeedsLinkError) throw error;
      complain(`${list.name}: ${error.message}`);
      for (const [key, item] of pending) {
        if (key.startsWith(`${list.id}|`)) next.set(key, item);
      }
      continue;
    }

    for (const task of tasks) {
      if (task.deleted || task.status === 'completed') continue;
      const due = dueDate(task);
      if (!due) continue;
      for (const day of days) {
        // Nothing before the due date: a task is not news until it is owed.
        if (due > day) continue;
        const key = `${list.id}|${task.id}|${day}`;
        if (seen.has(key)) continue;
        const block = placed.get(`${task.id}|${day}`) || null;
        next.set(key, {
          atMs: block ? block.startMs : zonedTime(day, timeZone, config.todo.dueHour),
          due,
          make: () => entryFor(list, task, due, day, timeZone, block),
        });
      }
    }
  }

  pending = next;
}

/**
 * Unlike a meeting, a task that was owed this morning is still owed this
 * afternoon — so a morning missed because the server was off is delivered late
 * rather than swallowed. Only today and tomorrow are ever held, which is what
 * keeps "late" down to the one day.
 */
function fireDue() {
  const now = Date.now();
  const due = [...pending].filter(([, item]) => item.atMs <= now);
  // Oldest first, so a backlog arriving at once reads the way it stacked up.
  due.sort((a, b) => (a[1].due < b[1].due ? -1 : a[1].due > b[1].due ? 1 : 0));
  for (const [key, item] of due) {
    pending.delete(key);
    markSeen(key);
    store.add(item.make());
  }
}

function schedule() {
  if (!running) return;
  let at = nextPollAt;
  for (const item of pending.values()) at = Math.min(at, item.atMs);
  const delay = Math.min(Math.max(at - Date.now(), 1000), config.todo.pollSeconds * 1000);
  timer = setTimeout(cycle, delay);
  timer.unref?.();
}

/** Once each, however long Google stays unreachable. */
function complain(message) {
  if (complained === message) return;
  complained = message;
  console.error(`[pitwall] todo: ${message}`);
}

async function cycle() {
  timer = null;
  try {
    if (!isLinked()) {
      complain('no Google account linked — run `npm run link-google`');
      pending = new Map();
      nextPollAt = Date.now() + config.todo.pollSeconds * 1000;
    } else if (!hasScope(SCOPE)) {
      // Linked before Tasks was asked for. The grant on disk will never widen
      // by itself, and every poll against it would come back refused.
      complain('the Google link predates Tasks — run `npm run link-google -- --force`');
      pending = new Map();
      nextPollAt = Date.now() + config.todo.pollSeconds * 1000;
    } else if (Date.now() >= nextPollAt) {
      await poll();
      nextPollAt = Date.now() + config.todo.pollSeconds * 1000;
      if (complained) {
        console.log('[pitwall] todo: connected');
        complained = null;
      }
    }
    fireDue();
    await saveSeen();
  } catch (error) {
    if (error instanceof NeedsLinkError) complain(`${error.message} — run \`npm run link-google\``);
    else complain(error.message);
    nextPollAt = Date.now() + config.todo.pollSeconds * 1000;
  }
  schedule();
}

/**
 * Tick a task off in Google, from its card.
 *
 * The next poll would drop it anyway — it stops coming back the moment it is
 * completed — but the mornings already queued for it are cleared here so a
 * card cannot arrive between the tick and that poll. They are recorded as
 * spoken for as well, in case Google is still catching up when the poll lands.
 */
export async function complete({ listId, taskId }) {
  const url = `${API}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`;
  await apiPatch(url, { status: 'completed' });
  for (const key of [...pending.keys()]) {
    if (!key.startsWith(`${listId}|${taskId}|`)) continue;
    pending.delete(key);
    markSeen(key);
  }
  await saveSeen();
}

/**
 * Waving a task through to another day.
 *
 * Google owns the task, so the day it is owed on has to move there rather than
 * here — a card held back in pitwall would still leave the task overdue in
 * Google, and the morning card would go on saying so. The old one is ticked off
 * and a new one takes its place, carrying what you wrote about it, which is
 * also how Google ends up with the note.
 *
 * The API keeps the date and drops the time, so the hour is `dueHour` again on
 * the day it comes round, exactly as it was the first time.
 */
export async function passToNewDay({ listId, taskId }, { title, firstMove, outLap, day }) {
  const base = `${API}/lists/${encodeURIComponent(listId)}`;
  const notes = [
    firstMove ? `First move: ${firstMove}` : '',
    outLap ? `Out lap: ${outLap}` : '',
  ].filter(Boolean).join('\n');

  // Made before the old one is ticked off: a tick that lands with nothing to
  // replace it loses the task, and a duplicate is a great deal easier to see.
  const made = await apiPost(`${base}/tasks`, {
    title,
    notes,
    // A date at UTC midnight is the only shape the API reads, and only the date
    // survives the trip anyway.
    due: `${day}T00:00:00.000Z`,
  });

  await apiPatch(`${base}/tasks/${encodeURIComponent(taskId)}`, { status: 'completed' });

  for (const key of [...pending.keys()]) {
    if (!key.startsWith(`${listId}|${taskId}|`)) continue;
    pending.delete(key);
    markSeen(key);
  }
  // The new task is owed on a day pitwall may already have spoken for, so its
  // first morning is left unclaimed and the next poll picks it up.
  await saveSeen();
  return { id: made?.id || null };
}

/**
 * Everything still owed by the end of a day, for the card that lists the whole
 * morning in one place. Read at the hour it is spoken rather than held from a
 * poll, so it cannot quote a list that has since been worked through.
 */
export async function outstanding(day, timeZone) {
  if (!hasScope(SCOPE)) return { tasks: [], missing: ['Google Tasks'] };
  const tasks = [];
  const missing = [];
  const placed = await scheduled([day], timeZone);
  const lists = await fetchLists();

  for (const list of lists) {
    let rows;
    try {
      rows = await fetchTasks(list, zonedTime(day, timeZone, 12) + DAY_MS);
    } catch (error) {
      // One list you can no longer read must not take the morning down with it.
      if (error instanceof NeedsLinkError) throw error;
      missing.push(list.name);
      continue;
    }
    for (const task of rows) {
      if (task.deleted || task.status === 'completed') continue;
      const due = dueDate(task);
      if (!due || due > day) continue;
      tasks.push({
        title: task.title?.trim() || '(no title)',
        due,
        lateDays: Math.max(0, daysBetween(due, day, timeZone)),
        at: clockRange(placed.get(`${task.id}|${day}`), timeZone) || null,
        where: null,
      });
    }
  }
  return { tasks, missing };
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
    fs.writeFileSync(paths.todoSeen, snapshot(), 'utf8');
  } catch (error) {
    console.error('[pitwall] could not persist todo state:', error.message);
  }
}

export function status() {
  return {
    running,
    linked: isLinked() && hasScope(SCOPE),
    pending: pending.size,
    nextPollAt: running ? nextPollAt : null,
  };
}

/** The pieces the tests drive directly, without the timer wrapped around them. */
export const internals = {
  dueDate,
  scheduled,
  clockRange,
  daysBetween,
  overdueLine,
  bodyFor,
  zone,
  poll,
  fireDue,
  loadSeen,
  saveSeen,
  seen,
  pendingKeys: () => [...pending.keys()],
};
