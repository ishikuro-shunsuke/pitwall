/**
 * Waving a card through to a time you name.
 *
 * Not a way of putting something off — the card comes back with the two lines
 * you wrote on it, and those are the whole point. **First move** is what you
 * open and what you type into it, so the version of you who gets the card back
 * can start without deciding anything. **Out lap** is how far to go before the
 * real shape of the work shows itself, which is the only honest way to size a
 * job you have not started: not what finishing looks like, but what enough
 * looks like to see finishing from.
 *
 * Both are required. A card you cannot write those two lines about is one you
 * have not thought about enough to hand to a later hour, and the button stays
 * down until you have.
 *
 * The clock is checked rather than held: a card due at seven with the server
 * off until nine comes back at nine. Nothing here is lost to a restart, because
 * nothing here is kept anywhere but on the card.
 */
import * as store from './store.mjs';

const TICK_MS = 30_000;
const MAX_TEXT = 500;

let timer = null;
let running = false;

function clip(value) {
  const text = String(value ?? '').trim();
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

/**
 * A card standing on the timeline, or one already waved through that is being
 * sent further on. Anything filed away for good is not.
 */
export function canPass(entry) {
  if (!entry) return false;
  return store.bucketOf(entry) === 'timeline' || entry.status === 'passed';
}

/**
 * Hand a card to a later hour. The status it had is kept so it can be given
 * back exactly as it was — a question still owed an answer comes back owed one.
 */
export function pass(id, { firstMove, outLap, dueAtMs }) {
  const entry = store.get(id);
  if (!entry) return { error: 'not found', status: 404 };
  if (!canPass(entry)) return { error: 'already dealt with', status: 409 };

  const move = clip(firstMove);
  const lap = clip(outLap);
  if (!move) return { error: 'first move required', status: 400 };
  if (!lap) return { error: 'out lap required', status: 400 };
  if (!Number.isFinite(dueAtMs) || dueAtMs <= Date.now()) {
    return { error: 'a time in the future is required', status: 400 };
  }

  const before = entry.pass ?? null;
  store.update(id, {
    status: 'passed',
    pass: {
      firstMove: move,
      outLap: lap,
      at: new Date().toISOString(),
      atMs: Date.now(),
      dueAtMs,
      dueAt: new Date(dueAtMs).toISOString(),
      // How many times this card has been waved through. Shown on it when it
      // comes back: the fourth one is telling you something the first was not.
      count: (before?.count ?? 0) + 1,
      // Where to put it back. A card passed while already passed keeps the
      // status it had before any of this started.
      was: before?.was ?? entry.status,
    },
  });
  schedule();
  return { ok: true, entry: store.get(id) };
}

/** Give a card back, exactly as it stood when it was waved through. */
function returnNow(entry) {
  store.update(entry.id, {
    status: entry.pass.was,
    pass: { ...entry.pass, dueAtMs: null, returnedAt: new Date().toISOString() },
  });
}

export function due(nowMs = Date.now()) {
  return store.list().filter((e) => e.status === 'passed' && e.pass?.dueAtMs && e.pass.dueAtMs <= nowMs);
}

/** Oldest due first, so a backlog reads the way it stacked up. */
export function sweep(nowMs = Date.now()) {
  const ready = due(nowMs).sort((a, b) => a.pass.dueAtMs - b.pass.dueAtMs);
  for (const entry of ready) returnNow(entry);
  return ready.length;
}

function nextDueMs() {
  let soonest = Infinity;
  for (const entry of store.list()) {
    if (entry.status !== 'passed' || !entry.pass?.dueAtMs) continue;
    soonest = Math.min(soonest, entry.pass.dueAtMs);
  }
  return soonest;
}

function schedule() {
  if (!running) return;
  if (timer) clearTimeout(timer);
  const wait = Math.min(Math.max(nextDueMs() - Date.now(), 250), TICK_MS);
  timer = setTimeout(cycle, wait);
  timer.unref?.();
}

function cycle() {
  timer = null;
  sweep();
  schedule();
}

export function start() {
  if (running) return false;
  running = true;
  // On the way up, so a morning that passed with the server down arrives now
  // rather than never.
  cycle();
  return true;
}

export function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

export function status() {
  const waiting = store.list().filter((e) => e.status === 'passed' && e.pass?.dueAtMs).length;
  const next = nextDueMs();
  return { running, waiting, nextAt: Number.isFinite(next) ? next : null };
}
