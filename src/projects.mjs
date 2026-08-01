/**
 * What a card belongs to.
 *
 * Five sources, one shape: every card carries a key naming the thing it came
 * out of — a repository, a task list, a calendar prefix, a sender, a room — and
 * a key is bound to at most one project. Bind the key rather than the card, and
 * the next card off that repository lands in the same place without being asked
 * about.
 *
 * Three of the five make a project the first time they are seen. A repository,
 * a Google Tasks list and a `[name]` written at the front of an event are all
 * things you made on purpose, and there are only ever a few of them. A sender
 * and a chat room are not: they arrive by the hundred, and one project each
 * would bury the ones that mean something. Those wait to be told.
 *
 * A binding recorded as `null` is not the same as no binding at all. Without
 * that distinction, taking a repository out of a project would last exactly
 * until its next card, which would find nothing bound and make it again.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { paths } from './config.mjs';
import * as store from './store.mjs';

/** name → { createdAt } */
const projects = new Map();

/** key → project name, or null for one you have taken out of every project. */
const bindings = new Map();

let dirty = false;
let writeTimer = null;

/**
 * Keys that make their project the first time they turn up. The rest of a key
 * is data — a path, a list id — so the prefix is the whole of the rule.
 */
const MAKES_ITS_OWN = new Set(['repo', 'list', 'cal']);

/**
 * `[acme-portal] 週次` — the one place a calendar can say what a booking is for
 * when every booking is on the same calendar. Written by you, so it counts as
 * having been named rather than guessed at.
 */
const PREFIXED = /^\s*\[([^\]]{1,60})\]\s*(.*)$/;

export function parsePrefix(title) {
  const m = PREFIXED.exec(String(title || ''));
  if (!m) return null;
  const name = m[1].trim();
  if (!name) return null;
  // The prefix is the card's project, so the title it leaves behind is the
  // whole of what the booking is. An empty one keeps the original.
  return { name, rest: m[2].trim() || String(title).trim() };
}

/**
 * The thing a card came out of, or null where there is nothing durable to hang
 * it on. Prefixed so a room id and a task list id can never be the same key.
 */
export function keyOf(entry) {
  if (!entry) return null;
  if (entry.agent === 'claude' || entry.agent === 'cursor' || entry.agent === 'desktop') {
    const root = entry.repo?.root || entry.host?.cwd;
    return root ? `repo:${String(root).replace(/\\/g, '/').replace(/\/+$/, '')}` : null;
  }
  if (entry.todo?.listId) return `list:${entry.todo.listId}`;
  if (entry.chatworkTask?.roomId) return `room:${entry.chatworkTask.roomId}`;
  if (entry.chatwork?.roomId) return `room:${entry.chatwork.roomId}`;
  if (entry.mail?.from) return `mail:${String(entry.mail.from).toLowerCase()}`;
  if (entry.calendar || entry.agenda) {
    const found = parsePrefix(entry.title);
    return found ? `cal:${found.name}` : null;
  }
  return null;
}

function makesItsOwn(key) {
  return MAKES_ITS_OWN.has(String(key).split(':', 1)[0]);
}

/**
 * The name a new project takes from the key that made it. A repository is its
 * directory, a calendar booking is what was written in the brackets, and a task
 * list is its own name — which the card carries, since the key is only an id.
 */
function nameFromKey(key, entry) {
  const [kind, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  if (kind === 'repo') return entry?.repo?.name || rest.split('/').filter(Boolean).pop() || rest;
  if (kind === 'cal') return rest;
  if (kind === 'list') return entry?.repo?.name || rest;
  return rest;
}

function touch() {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    save();
  }, 200);
  writeTimer.unref?.();
}

export function load() {
  projects.clear();
  bindings.clear();
  try {
    const raw = JSON.parse(fs.readFileSync(paths.projects, 'utf8'));
    for (const [name, meta] of Object.entries(raw.projects ?? {})) {
      projects.set(name, { createdAt: meta?.createdAt || new Date().toISOString() });
    }
    for (const [key, name] of Object.entries(raw.bindings ?? {})) {
      bindings.set(key, name === null ? null : String(name));
    }
  } catch {
    /* first run */
  }
}

function snapshot() {
  return JSON.stringify({
    version: 1,
    projects: Object.fromEntries(projects),
    bindings: Object.fromEntries(bindings),
  });
}

async function save() {
  if (!dirty) return;
  dirty = false;
  try {
    await fsp.writeFile(paths.projects, snapshot(), 'utf8');
  } catch (error) {
    console.error('[pitwall] could not persist projects:', error.message);
  }
}

/**
 * Called as a card arrives. Returns the project it belongs to, making one where
 * the key is the kind that makes its own and has never been seen.
 */
export function ensure(entry) {
  const key = keyOf(entry);
  if (!key) return null;
  if (bindings.has(key)) return bindings.get(key);
  if (!makesItsOwn(key)) {
    // Seen, and deliberately left out of everything until you say otherwise.
    // Recorded so the dropdown can offer it without the card having to be open.
    bindings.set(key, null);
    touch();
    return null;
  }
  const name = nameFromKey(key, entry);
  if (!projects.has(name)) projects.set(name, { createdAt: new Date().toISOString() });
  bindings.set(key, name);
  touch();
  return name;
}

/** What to show on a card. Read on the way out, so a rebind moves every card. */
export function nameFor(key) {
  if (!key) return null;
  return bindings.get(key) ?? null;
}

/**
 * Put a key into a project, or take it out of every project with `null`.
 * A name nobody has used before is a new project.
 */
export function assign(key, name) {
  if (!key) return null;
  const wanted = name === null || name === undefined ? null : String(name).trim();
  if (wanted) {
    if (!projects.has(wanted)) projects.set(wanted, { createdAt: new Date().toISOString() });
    bindings.set(key, wanted);
  } else {
    bindings.set(key, null);
  }
  touch();
  prune();
  return bindings.get(key);
}

/**
 * How many cards each project holds, counting the archive: a project is what it
 * has ever been about, not what is on the timeline this minute. Anything left
 * holding nothing is gone — which in practice only catches one made in error
 * and moved out of straight away, and later the day retention drops its last
 * card.
 */
export function counts() {
  const out = new Map();
  for (const name of projects.keys()) out.set(name, 0);
  for (const entry of store.list()) {
    const name = nameFor(keyOf(entry));
    if (name && out.has(name)) out.set(name, out.get(name) + 1);
  }
  return out;
}

export function prune() {
  const held = counts();
  let changed = false;
  for (const [name, n] of held) {
    if (n > 0) continue;
    // A binding still pointing at it means a card is on its way, so it stays.
    if ([...bindings.values()].includes(name)) continue;
    projects.delete(name);
    changed = true;
  }
  if (changed) touch();
}

/** Everything the dropdown needs, most-used first, then alphabetical. */
export function list() {
  const held = counts();
  return [...projects.keys()]
    .map((name) => ({ name, count: held.get(name) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function shutdown() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  if (!dirty) return;
  dirty = false;
  try {
    fs.writeFileSync(paths.projects, snapshot(), 'utf8');
  } catch (error) {
    console.error('[pitwall] could not persist projects:', error.message);
  }
}

/** Test seam. */
export const internals = { projects, bindings, makesItsOwn, nameFromKey };
