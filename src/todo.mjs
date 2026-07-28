/**
 * Google Tasks, on the timeline.
 *
 * A task carries a due date and nothing else: the API drops the time of day
 * that the Tasks app lets you set, and there are no reminders on it to inherit.
 * So the hour is pitwall's to choose — one card per task on the morning it is
 * due, and again every morning it stays undone, until it is ticked off in
 * Google.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { config, paths } from './config.mjs';
import * as store from './store.mjs';
import { buildEntry } from './normalize.mjs';
import { apiGet, apiPatch, isLinked, hasScope, linkedTimeZone, NeedsLinkError } from './google-auth.mjs';
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

function overdueLine(due, day, timeZone) {
  const late = daysBetween(due, day, timeZone);
  if (late <= 0) return '**Due today**';
  const plural = late === 1 ? 'day' : 'days';
  return `**Overdue by ${late} ${plural}** · was due ${fmtDate(due, timeZone)}`;
}

function linkLines(task) {
  return (task.links || [])
    .filter((l) => l?.link)
    .map((l) => `[${l.description || l.type || 'link'}](${l.link})`);
}

function bodyFor(task, due, day, timeZone) {
  const blocks = [overdueLine(due, day, timeZone)];

  const notes = String(task.notes || '').trim();
  if (notes) blocks.push(notes.length > 800 ? `${notes.slice(0, 800)}…` : notes);

  const links = linkLines(task);
  if (links.length) blocks.push(links.join('\n'));

  if (task.webViewLink) blocks.push(`[Open in Google Tasks](${task.webViewLink})`);
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

function entryFor(list, task, due, day, timeZone) {
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
    body: bodyFor(task, due, day, timeZone),
  });
  entry.todo = {
    listId: list.id,
    taskId: task.id,
    due,
    day,
    overdueDays: Math.max(0, daysBetween(due, day, timeZone)),
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
        next.set(key, {
          atMs: zonedTime(day, timeZone, config.todo.dueHour),
          due,
          make: () => entryFor(list, task, due, day, timeZone),
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
