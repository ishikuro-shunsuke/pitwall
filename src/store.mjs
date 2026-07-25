import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, paths } from './config.mjs';

/**
 * Entry statuses:
 *   waiting   - an agent is blocked right now, hook is holding the turn open
 *   answered  - you replied, the reply was handed back to the agent
 *   dismissed - you closed it without replying, the agent stopped normally
 *   expired   - nobody answered within the wait window, the agent stopped on its own
 *   detached  - hook connection dropped (user interrupted the agent)
 *   notice    - informational only (permission prompt, turn error); never blocking
 */
export const ACTIVE_STATUSES = new Set(['waiting', 'notice']);
export const ARCHIVE_STATUSES = new Set(['answered', 'dismissed', 'expired', 'detached']);

const listeners = new Set();

/** @type {Map<string, object>} */
const entries = new Map();

/** Per-session bookkeeping that only matters while the process is alive. */
const sessions = new Map();

/**
 * Cursor stop has no body; afterAgentResponse texts are buffered here keyed by
 * conversation_id until the matching stop arrives.
 */
const responseBuffers = new Map();

let writeTimer = null;
let writing = false;
let writeAgain = false;

export function init() {
  fs.mkdirSync(paths.images, { recursive: true });
  fs.mkdirSync(paths.responses, { recursive: true });
  if (!fs.existsSync(paths.entries)) return;

  try {
    const raw = JSON.parse(fs.readFileSync(paths.entries, 'utf8'));
    const cutoff = Date.now() - config.retentionDays * 86_400_000;
    for (const entry of raw.entries ?? []) {
      if (Date.parse(entry.createdAt) < cutoff) continue;
      // A `waiting` entry cannot survive a restart: its hook process is gone,
      // so the agent has already stopped and no reply can reach it anymore.
      if (entry.status === 'waiting') {
        entry.status = 'expired';
        entry.resolvedAt = entry.resolvedAt ?? new Date().toISOString();
        entry.resolution = 'server-restart';
      }
      entries.set(entry.id, entry);
    }
  } catch (error) {
    console.error('[pitwall] could not read entries file, starting empty:', error.message);
  }
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(type, entry) {
  for (const listener of listeners) {
    try {
      listener({ type, entry });
    } catch {
      /* a dead SSE client must not take the server down */
    }
  }
}

function persist() {
  if (writeTimer) return;
  writeTimer = setTimeout(flush, 150);
  writeTimer.unref?.();
}

async function flush() {
  writeTimer = null;
  if (writing) {
    writeAgain = true;
    return;
  }
  writing = true;
  try {
    const payload = JSON.stringify({ version: 1, entries: [...entries.values()] }, null, 2);
    const tmp = `${paths.entries}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, payload, 'utf8');
    await fsp.rename(tmp, paths.entries);
  } catch (error) {
    console.error('[pitwall] failed to persist entries:', error.message);
  } finally {
    writing = false;
    if (writeAgain) {
      writeAgain = false;
      persist();
    }
  }
}

export function newId(prefix = 'e') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

export function add(entry) {
  entries.set(entry.id, entry);
  persist();
  emit('created', entry);
  return entry;
}

export function get(id) {
  return entries.get(id);
}

export function update(id, patch) {
  const entry = entries.get(id);
  if (!entry) return null;
  Object.assign(entry, patch);
  persist();
  emit('updated', entry);
  return entry;
}

export function list() {
  return [...entries.values()];
}

/** Repos seen across all entries, for the filter dropdown. */
export function repos() {
  const byKey = new Map();
  for (const entry of entries.values()) {
    const key = entry.repo?.key;
    if (!key) continue;
    const seen = byKey.get(key) ?? { key, name: entry.repo.name, root: entry.repo.root, active: 0, total: 0 };
    seen.total += 1;
    if (ACTIVE_STATUSES.has(entry.status)) seen.active += 1;
    byKey.set(key, seen);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Claude Code stops honouring a Stop hook after 8 consecutive continuations, so
 * we count how many replies we have injected without a real terminal turn in
 * between and surface it before the ceiling is hit.
 */
export function sessionBlockCount(sessionId) {
  return sessions.get(sessionId)?.blocks ?? 0;
}

export function noteSessionTurn(sessionId, { continuedByHook }) {
  if (!sessionId) return 0;
  const state = sessions.get(sessionId) ?? { blocks: 0 };
  if (!continuedByHook) state.blocks = 0;
  sessions.set(sessionId, state);
  return state.blocks;
}

export function noteSessionBlock(sessionId) {
  if (!sessionId) return 0;
  const state = sessions.get(sessionId) ?? { blocks: 0 };
  state.blocks += 1;
  sessions.set(sessionId, state);
  return state.blocks;
}

export async function storeImage(sourcePath, { mime, ext }) {
  const stat = await fsp.stat(sourcePath);
  if (stat.size > config.maxImageBytes) {
    throw new Error(`image too large (${stat.size} bytes)`);
  }
  const buffer = await fsp.readFile(sourcePath);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  const filename = `${hash}${ext}`;
  const target = path.join(paths.images, filename);
  if (!fs.existsSync(target)) await fsp.writeFile(target, buffer);
  return { filename, url: `/images/${filename}`, bytes: stat.size, mime };
}

/** Buffer an afterAgentResponse chunk for a Cursor conversation. */
export function pushResponse(conversationId, text) {
  if (!conversationId || !text) return;
  const list = responseBuffers.get(conversationId) ?? [];
  list.push({ text: String(text), at: Date.now() });
  // Keep a bound so a stuck conversation cannot grow forever.
  if (list.length > 40) list.splice(0, list.length - 40);
  responseBuffers.set(conversationId, list);
}

/** Take (and clear) buffered responses for a conversation at stop time. */
export function takeResponses(conversationId) {
  if (!conversationId) return [];
  const list = responseBuffers.get(conversationId) ?? [];
  responseBuffers.delete(conversationId);
  return list.map((item) => item.text);
}

export function shutdown() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  try {
    const payload = JSON.stringify({ version: 1, entries: [...entries.values()] }, null, 2);
    fs.writeFileSync(paths.entries, payload, 'utf8');
  } catch (error) {
    console.error('[pitwall] failed final persist:', error.message);
  }
}
