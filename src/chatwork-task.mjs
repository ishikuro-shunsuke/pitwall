/**
 * Chatwork tasks, on the timeline.
 *
 * Somebody else usually sets these — a task in Chatwork is a message with your
 * name against it — so what the card has to say is who is waiting and since
 * when. One card on the morning it is due, and again every morning it stays
 * open, until it is ticked off.
 *
 * A deadline arrives as an instant, and the day it falls on is the day where
 * the account lives. Chatwork's API never says where that is, so the zone is
 * this machine's unless `PITWALL_CHATWORK_TIMEZONE` says otherwise — and a
 * deadline set as a date lands one second before midnight, which is exactly the
 * hour a wrong zone would tip over.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { config, paths } from './config.mjs';
import * as store from './store.mjs';
import { buildEntry } from './normalize.mjs';
import * as api from './chatwork-api.mjs';
import { NeedsTokenError, hasToken } from './chatwork-api.mjs';
import { chatworkText, withoutOpeningAddress } from './chatwork-text.mjs';
import { messageUrl } from './chatwork.mjs';
import { zonedTime, zonedDate, nextDate } from './zoned.mjs';

const SEEN_TTL_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;
const TITLE_CHARS = 90;

/** `task|day` for every morning already spoken for. */
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
    const raw = JSON.parse(fs.readFileSync(paths.chatworkTaskSeen, 'utf8'));
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [key, at] of Object.entries(raw.seen ?? {})) {
      if (at > cutoff) seen.set(key, at);
    }
  } catch {
    /* first run, or a file we can rebuild by asking Chatwork again */
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
    await fsp.writeFile(paths.chatworkTaskSeen, snapshot(), 'utf8');
  } catch (error) {
    console.error('[pitwall] could not persist chatwork task state:', error.message);
  }
}

function markSeen(key) {
  seen.set(key, Date.now());
  seenDirty = true;
}

function zone() {
  return config.chatwork.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Whole days between two calendar dates, counted through noon to dodge DST. */
function daysBetween(fromDate, toDate, timeZone) {
  const from = zonedTime(fromDate, timeZone, 12);
  const to = zonedTime(toDate, timeZone, 12);
  return Math.round((to - from) / DAY_MS);
}

function fmtDate(dateStr, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(zonedTime(dateStr, timeZone, 12)));
}

/**
 * The clock on a deadline, where there is one. A task set to a date is due at
 * the end of that day, and saying "by 23:59" adds nothing to "due today".
 */
function fmtClock(task, timeZone) {
  if (task.limit_type !== 'time' || !task.limit_time) return '';
  return ` · ${new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(task.limit_time * 1000))}`;
}

function overdueLine(task, due, day, timeZone) {
  const clock = fmtClock(task, timeZone);
  const late = daysBetween(due, day, timeZone);
  if (late <= 0) return `**Due today**${clock}`;
  const plural = late === 1 ? 'day' : 'days';
  return `**Overdue by ${late} ${plural}** · was due ${fmtDate(due, timeZone)}${clock}`;
}

/** A task carries one blob of text and no title of its own, so this is both. */
function titleOf(text) {
  const head = String(text || '').trim().split('\n')[0].trim();
  if (!head) return '(no text)';
  return head.length > TITLE_CHARS ? `${head.slice(0, TITLE_CHARS)}…` : head;
}

function bodyFor(task, text, title, due, day, timeZone) {
  const blocks = [overdueLine(task, due, day, timeZone)];

  const from = task.assigned_by_account?.name;
  if (from) blocks.push(`Set by ${from} in ${task.room?.name || 'Chatwork'}`);

  // Only when there is more to it than the line already at the head of the card.
  if (text && text !== title) {
    blocks.push(text.length > 800 ? `${text.slice(0, 800)}…` : text);
  }

  return blocks.join('\n\n');
}

/**
 * Which day the deadline falls on, there. A date-typed deadline is stored as
 * the last second of its day, so reading the instant in the right zone is all
 * it takes for both kinds to name the day a person would name.
 */
function dueDate(task, timeZone) {
  const at = Number(task.limit_time) || 0;
  // No deadline at all. A task nobody put a date on is not owed on any morning.
  if (at <= 0) return null;
  return zonedDate(at * 1000, timeZone);
}

function entryFor(task, due, day, timeZone) {
  const text = chatworkText(withoutOpeningAddress(task.body));
  const title = titleOf(text);
  const roomId = String(task.room?.room_id ?? '');
  const entry = buildEntry({
    agent: 'chatwork',
    kind: 'notice',
    payload: {
      title,
      notice: 'chat-task-due',
      repo: { key: 'chatwork', name: task.room?.name || `room ${roomId}` },
    },
    body: bodyFor(task, text, title, due, day, timeZone),
  });
  entry.chatworkTask = {
    roomId,
    taskId: String(task.task_id),
    due,
    day,
    overdueDays: Math.max(0, daysBetween(due, day, timeZone)),
    // A task is a message with a deadline on it, so there is a message to open.
    webUrl: task.message_id ? messageUrl(roomId, task.message_id) : null,
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
  const tasks = (await api.get('/my/tasks', { status: 'open' })) || [];
  const next = new Map();

  for (const task of tasks) {
    if (task.status && task.status !== 'open') continue;
    const due = dueDate(task, timeZone);
    if (!due) continue;
    for (const day of days) {
      // Nothing before the deadline: a task is not news until it is owed.
      if (due > day) continue;
      const key = `${task.task_id}|${day}`;
      if (seen.has(key)) continue;
      next.set(key, {
        atMs: zonedTime(day, timeZone, config.chatwork.taskDueHour),
        due,
        make: () => entryFor(task, due, day, timeZone),
      });
    }
  }

  pending = next;
}

/**
 * A task that was owed this morning is still owed this afternoon, so a morning
 * missed because the server was off is delivered late rather than swallowed.
 * Only today and tomorrow are ever held, which keeps "late" down to the one day.
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
  const delay = Math.min(Math.max(at - Date.now(), 1000), config.chatwork.taskPollSeconds * 1000);
  timer = setTimeout(cycle, delay);
  timer.unref?.();
}

/** Once each, however long Chatwork stays unreachable. */
function complain(message) {
  if (complained === message) return;
  complained = message;
  console.error(`[pitwall] chatwork tasks: ${message}`);
}

async function cycle() {
  timer = null;
  try {
    if (!hasToken()) {
      complain('no Chatwork token — set PITWALL_CHATWORK_TOKEN');
      pending = new Map();
      nextPollAt = Date.now() + config.chatwork.taskPollSeconds * 1000;
    } else if (Date.now() >= nextPollAt) {
      await poll();
      nextPollAt = Date.now() + config.chatwork.taskPollSeconds * 1000;
      if (complained) {
        console.log('[pitwall] chatwork tasks: connected');
        complained = null;
      }
    }
    fireDue();
    await saveSeen();
  } catch (error) {
    if (error instanceof NeedsTokenError) complain(`${error.message} — set PITWALL_CHATWORK_TOKEN`);
    else complain(error.message);
    nextPollAt = Date.now() + config.chatwork.taskPollSeconds * 1000;
  }
  schedule();
}

/**
 * Tick a task off in Chatwork, from its card.
 *
 * The next poll would drop it anyway — a done task is not open — but the
 * mornings already queued for it are cleared here so a card cannot arrive
 * between the tick and that poll.
 */
export async function complete({ roomId, taskId }) {
  await api.put(
    `/rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}/status`,
    { body: 'done' },
  );
  for (const key of [...pending.keys()]) {
    if (!key.startsWith(`${taskId}|`)) continue;
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
    fs.writeFileSync(paths.chatworkTaskSeen, snapshot(), 'utf8');
  } catch (error) {
    console.error('[pitwall] could not persist chatwork task state:', error.message);
  }
}

export function status() {
  return {
    running,
    linked: hasToken(),
    pending: pending.size,
    nextPollAt: running ? nextPollAt : null,
  };
}

/** The pieces the tests drive directly, without the timer wrapped around them. */
export const internals = {
  dueDate,
  daysBetween,
  overdueLine,
  titleOf,
  bodyFor,
  zone,
  poll,
  fireDue,
  loadSeen,
  saveSeen,
  seen,
  pendingKeys: () => [...pending.keys()],
};
