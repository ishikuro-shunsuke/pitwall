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
const UNANSWERED_STATUSES = new Set(['dismissed', 'expired', 'detached']);

/**
 * Which tab an entry belongs to: 'timeline' while it is still live, then
 * 'archive' once it ended with your reply in the agent's hands, or
 * 'unanswered' when the agent stopped without ever hearing back. A notice was
 * never a question, so clearing one lands in 'archive'.
 */
export function bucketOf(entry) {
  if (ACTIVE_STATUSES.has(entry.status)) return 'timeline';
  if (entry.kind === 'notice') return 'archive';
  return UNANSWERED_STATUSES.has(entry.status) ? 'unanswered' : 'archive';
}

const listeners = new Set();

/** @type {Map<string, object>} */
const entries = new Map();

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

export function imageExists(filename) {
  return fs.existsSync(path.join(paths.images, filename));
}

/** Store bytes uploaded by a hook. Content-addressed, so re-uploads are no-ops. */
export async function storeImageBytes(buffer, { sha, ext, mime }) {
  const filename = `${sha}${ext}`;
  const target = path.join(paths.images, filename);
  if (!fs.existsSync(target)) await fsp.writeFile(target, buffer);
  return { filename, url: `/images/${filename}`, bytes: buffer.length, mime };
}

/** Buffer an afterAgentResponse chunk for a Cursor conversation. */
export function pushResponse(conversationId, text, images = []) {
  if (!conversationId) return;
  if (!text && !images.length) return;
  const list = responseBuffers.get(conversationId) ?? [];
  list.push({ text: String(text || ''), images, at: Date.now() });
  // Keep a bound so a stuck conversation cannot grow forever.
  if (list.length > 40) list.splice(0, list.length - 40);
  responseBuffers.set(conversationId, list);
}

/** Take (and clear) buffered responses for a conversation at stop time. */
export function takeResponses(conversationId) {
  if (!conversationId) return [];
  const list = responseBuffers.get(conversationId) ?? [];
  responseBuffers.delete(conversationId);
  return list;
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
