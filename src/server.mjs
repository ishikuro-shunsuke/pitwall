import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, paths, softHoldSeconds } from './config.mjs';
import * as store from './store.mjs';
import * as waiters from './waiters.mjs';
import { buildEntry, publicEntry } from './normalize.mjs';
import { collectImages, mimeForFile, mimeForExt } from './images.mjs';

store.init();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const sseClients = new Set();

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`invalid JSON: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function broadcast(type, entry) {
  const data = `event: ${type}\ndata: ${JSON.stringify(publicEntry(entry))}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

store.subscribe(({ type, entry }) => broadcast(type, entry));

function match(pathname, pattern) {
  const pp = pattern.split('/').filter(Boolean);
  const aa = pathname.split('/').filter(Boolean);
  if (pp.length !== aa.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i += 1) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(aa[i]);
    else if (pp[i] !== aa[i]) return null;
  }
  return params;
}

async function handleCursorResponse(req, res) {
  const body = await readBody(req);
  const conversationId = body.conversationId || body.conversation_id;
  const text = body.text || '';
  const images = Array.isArray(body.images) ? body.images : [];
  store.pushResponse(conversationId, text, images);
  sendJson(res, 200, { ok: true });
}

/**
 * Hooks read and hash image files themselves, then PUSH the bytes here. The
 * server never resolves a path from a payload: an agent inside a container
 * reports `/workspaces/...`, which does not exist on the host.
 */
async function handleImageUpload(req, res, url) {
  const sha = String(url.searchParams.get('sha') || '').toLowerCase();
  const ext = String(url.searchParams.get('ext') || '').toLowerCase();
  const mime = mimeForExt(ext);

  if (!/^[0-9a-f]{32}$/.test(sha) || !mime) {
    req.resume();
    return sendJson(res, 400, { error: 'bad sha or unsupported ext' });
  }

  let buffer;
  try {
    buffer = await readRawBody(req, config.maxImageBytes);
  } catch {
    return sendJson(res, 413, { error: 'image too large' });
  }
  if (!buffer.length) return sendJson(res, 400, { error: 'empty body' });

  const actual = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  if (actual !== sha) return sendJson(res, 400, { error: 'sha mismatch' });

  const stored = await store.storeImageBytes(buffer, { sha, ext, mime });
  sendJson(res, 200, { ok: true, ...stored });
}

/** Existence probe so a hook can skip re-uploading bytes already in the store. */
function handleImageProbe(_req, res, params) {
  const filename = path.basename(params.file);
  const found = mimeForExt(path.extname(filename)) && store.imageExists(filename);
  res.writeHead(found ? 200 : 404, found ? { 'Content-Type': mimeForFile(filename) } : undefined);
  res.end();
}

/** Notification types worth a timeline card; anything else is noise. */
const INTERESTING_NOTICES = new Set([
  'permission_prompt',
  'idle_prompt',
  'agent_needs_input',
  'elicitation_dialog',
  // Not a Claude Code notification type: the AskUserQuestion hook names its own.
  'ask_user_question',
]);

async function handleNotify(req, res) {
  const body = await readBody(req);
  const agent = body.agent || 'claude';
  const type = body.notificationType || body.notification_type;

  // Hooks filter too, but the endpoint accepts raw payloads, so re-check here.
  if (type && !INTERESTING_NOTICES.has(type)) {
    sendJson(res, 200, { ok: true, skipped: true, reason: 'uninteresting' });
    return;
  }

  const entry = buildEntry({
    agent,
    kind: 'notice',
    payload: body,
    body: body.body || body.message || body.title || '',
  });
  store.add(entry);
  sendJson(res, 200, { ok: true, id: entry.id });
}

async function handleWait(req, res) {
  const body = await readBody(req);
  const agent = body.agent || 'cursor';

  if (agent === 'cursor' && body.status === 'aborted') {
    sendJson(res, 200, { ok: true, skipped: true, reason: 'aborted' });
    return;
  }

  let turnMessages = [];
  let bodyText = body.body || body.last_assistant_message || '';
  const uploaded = Array.isArray(body.images) ? [...body.images] : [];

  if (agent === 'cursor') {
    const conversationId = body.conversationId || body.conversation_id;
    const buffered = store.takeResponses(conversationId);
    turnMessages = buffered.map((chunk) => chunk.text).filter(Boolean);
    for (const chunk of buffered) uploaded.push(...(chunk.images || []));
    if (!bodyText && turnMessages.length) {
      bodyText = turnMessages[turnMessages.length - 1];
    }
  }

  if (agent === 'cursor' && body.status === 'error') {
    const entry = buildEntry({
      agent,
      kind: 'notice',
      payload: { ...body, notice: 'turn-error' },
      body: bodyText,
      turnMessages,
    });
    store.add(entry);
    sendJson(res, 200, { ok: true, id: entry.id, kind: 'notice' });
    return;
  }

  const searchDirs = [
    body.repo?.root,
    body.host?.cwd,
    ...(body.workspace_roots || body.workspaceRoots || []),
  ].filter(Boolean);

  // The same screenshot is usually mentioned in several chunks of one turn.
  const byKey = new Map();
  for (const image of uploaded) {
    const key = image?.url || image?.ref;
    if (key && !byKey.has(key)) byKey.set(key, image);
  }
  const images = byKey.size
    ? [...byKey.values()].slice(0, config.maxImagesPerEntry)
    : await collectImages([bodyText, ...turnMessages].join('\n'), searchDirs);

  // A Claude card outlives the turn it came from, so the same session stopping
  // again means the older card would be answering something already scrolled
  // past. Let it go rather than leave two live cards for one session.
  const sessionId = body.sessionId || body.session_id || body.conversationId || body.conversation_id;
  if (agent === 'claude' && sessionId) {
    for (const open of store.list()) {
      if (open.agent !== 'claude' || open.status !== 'waiting') continue;
      if (open.sessionId !== sessionId) continue;
      const landed = waiters.resolve(open.id, { action: 'release', reason: 'superseded' });
      if (landed !== 'delivered') {
        store.update(open.id, {
          status: 'expired',
          resolvedAt: new Date().toISOString(),
          resolution: 'superseded',
        });
      }
    }
  }

  const entry = buildEntry({
    agent,
    kind: 'wait',
    payload: body,
    body: bodyText,
    turnMessages,
    images,
  });

  waiters.reserve(entry.id, {
    createdAtMs: entry.createdAtMs,
    softHoldSeconds: softHoldSeconds(agent),
    // The hook may die before its long poll ever starts, and then there is no
    // request to release — the card would sit in Timeline for good. Retire it
    // on the same deadline everything else honours.
    onExpire: () => {
      if (store.get(entry.id)?.status !== 'waiting') return;
      store.update(entry.id, {
        status: 'expired',
        resolvedAt: new Date().toISOString(),
        resolution: 'expired',
      });
    },
  });
  store.add(entry);
  sendJson(res, 200, {
    ok: true,
    id: entry.id,
    holdUntil: entry.holdUntil,
    holdMaxAt: entry.holdMaxAt,
  });
}

async function handleResolve(req, res, params) {
  const entry = store.get(params.id);
  if (!entry) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  // The hold outlasts a silent response: node's fetch gives a reply five
  // minutes to start arriving and then drops the socket, which reads here as
  // the agent having been interrupted. Send the headers now and a space every
  // so often — JSON.parse skips leading whitespace, so the poll still ends in
  // one parseable object.
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.flushHeaders();
  const heartbeat = setInterval(() => res.write(' '), 30_000);
  heartbeat.unref?.();
  res.on('close', () => clearInterval(heartbeat));
  const finish = (body) => {
    clearInterval(heartbeat);
    res.end(JSON.stringify(body));
  };

  // Client disconnect (agent interrupted) → mark detached.
  let finished = false;
  const onClose = () => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    if (entry.status === 'waiting' && waiters.isLive(entry.id)) {
      waiters.drop(entry.id);
      store.update(entry.id, {
        status: 'detached',
        resolvedAt: new Date().toISOString(),
        resolution: 'detached',
      });
    }
  };
  req.on('close', onClose);

  const resolution = await waiters.waitFor(entry.id);
  finished = true;
  req.off('close', onClose);

  if (!resolution || resolution.action === 'release') {
    const reason = resolution?.reason || 'expired';
    if (entry.status === 'waiting') {
      store.update(entry.id, {
        status: reason === 'detached' ? 'detached' : 'expired',
        resolvedAt: new Date().toISOString(),
        resolution: reason,
      });
    }
    finish({ action: 'release', reason });
    return;
  }

  if (resolution.action === 'reply') {
    store.update(entry.id, {
      status: 'answered',
      resolvedAt: new Date().toISOString(),
      resolution: 'reply',
      reply: resolution.message,
    });
    finish({ action: 'reply', message: resolution.message });
    return;
  }

  if (resolution.action === 'dismiss') {
    store.update(entry.id, {
      status: 'dismissed',
      resolvedAt: new Date().toISOString(),
      resolution: 'dismiss',
    });
    finish({ action: 'dismiss' });
    return;
  }

  finish({ action: 'release', reason: 'unknown' });
}

async function handleList(req, res, url) {
  const view = url.searchParams.get('view') || 'timeline';

  let items = store.list().map(publicEntry);

  if (view !== 'all') items = items.filter((e) => e.bucket === view);

  items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  sendJson(res, 200, {
    entries: items,
    serverTime: Date.now(),
  });
}

async function handleGetEntry(_req, res, params) {
  const entry = store.get(params.id);
  if (!entry) return sendJson(res, 404, { error: 'not found' });
  const hold = waiters.getHoldInfo(entry.id);
  sendJson(res, 200, {
    entry: publicEntry(entry),
    hold,
    live: waiters.isLive(entry.id),
  });
}

async function handleReply(req, res, params) {
  const entry = store.get(params.id);
  if (!entry) return sendJson(res, 404, { error: 'not found' });
  if (entry.status !== 'waiting') {
    return sendJson(res, 409, { error: 'not waiting', status: entry.status });
  }
  const body = await readBody(req);
  const message = String(body.message || '').trim();
  if (!message) return sendJson(res, 400, { error: 'message required' });

  const ok = waiters.resolve(params.id, { action: 'reply', message });
  if (!ok) return sendJson(res, 409, { error: 'hook no longer listening' });
  // Only a polling hook reaches handleResolve to record the answer. When the
  // reply was merely stashed, write it here too, or the card sits in `waiting`
  // for a hook that may never come back and the button looks dead.
  if (ok !== 'delivered') {
    store.update(params.id, {
      status: 'answered',
      resolvedAt: new Date().toISOString(),
      resolution: 'reply',
      reply: message,
    });
  }
  sendJson(res, 200, { ok: true });
}

async function handleDismiss(req, res, params) {
  const entry = store.get(params.id);
  if (!entry) return sendJson(res, 404, { error: 'not found' });
  if (entry.status === 'waiting') {
    const ok = waiters.resolve(params.id, { action: 'dismiss' });
    if (ok !== 'delivered') {
      store.update(params.id, {
        status: 'dismissed',
        resolvedAt: new Date().toISOString(),
        resolution: ok ? 'dismiss' : 'dismiss-offline',
      });
    }
    return sendJson(res, 200, { ok: true });
  }
  // A notice was never a question, and a card whose window has closed can no
  // longer take an answer — boxing either one only takes it off the feed. How
  // its agent ended stays on `resolvedAt` and `resolution`, so the archived
  // card still says whether anyone was there to hear it.
  if (store.bucketOf(entry) === 'timeline') {
    store.update(params.id, {
      status: 'dismissed',
      resolvedAt: entry.resolvedAt ?? new Date().toISOString(),
      resolution: entry.resolution ?? 'dismiss',
    });
    return sendJson(res, 200, { ok: true });
  }
  sendJson(res, 409, { error: 'already boxed', status: entry.status });
}

async function handleHold(req, res, params) {
  const entry = store.get(params.id);
  if (!entry) return sendJson(res, 404, { error: 'not found' });
  if (entry.status !== 'waiting') {
    return sendJson(res, 409, { error: 'not waiting' });
  }
  const deadlineMs = waiters.extendHold(params.id);
  if (deadlineMs == null) {
    return sendJson(res, 409, { error: 'hook no longer listening' });
  }
  store.update(params.id, { holdUntil: deadlineMs });
  sendJson(res, 200, {
    ok: true,
    holdUntil: deadlineMs,
    remainingMs: Math.max(0, deadlineMs - Date.now()),
  });
}

async function handleArchiveNotice(req, res, params) {
  const entry = store.get(params.id);
  if (!entry) return sendJson(res, 404, { error: 'not found' });
  if (entry.status !== 'notice') {
    return sendJson(res, 409, { error: 'not a notice' });
  }
  store.update(params.id, {
    status: 'dismissed',
    resolvedAt: new Date().toISOString(),
    resolution: 'archive',
  });
  sendJson(res, 200, { ok: true });
}

function handleSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ serverTime: Date.now() })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clearInterval(ping);
    }
  }, 25_000);
  ping.unref?.();
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  if (rel.includes('..')) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }

  if (rel.startsWith('/images/')) {
    const file = path.join(paths.images, path.basename(rel));
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': mimeForFile(file),
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
    return;
  }

  // The card body builds editor links out of the file references in the text,
  // so the browser is handed the server's own link module instead of a copy.
  const file = rel === '/deeplink.mjs' ? paths.deeplink : path.join(paths.public, rel);
  if (file !== paths.deeplink && !file.startsWith(paths.public)) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }
  try {
    const data = await fsp.readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

async function router(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const method = req.method || 'GET';

  try {
    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        waiting: store.list().filter((e) => e.status === 'waiting').length,
        time: Date.now(),
      });
    }

    if (method === 'GET' && pathname === '/api/events') return handleSse(req, res);
    if (method === 'GET' && pathname === '/api/entries') return handleList(req, res, url);

    let params = match(pathname, '/api/entries/:id');
    if (method === 'GET' && params) return handleGetEntry(req, res, params);

    params = match(pathname, '/api/entries/:id/reply');
    if (method === 'POST' && params) return handleReply(req, res, params);

    params = match(pathname, '/api/entries/:id/dismiss');
    if (method === 'POST' && params) return handleDismiss(req, res, params);

    params = match(pathname, '/api/entries/:id/hold');
    if (method === 'POST' && params) return handleHold(req, res, params);

    params = match(pathname, '/api/entries/:id/archive');
    if (method === 'POST' && params) return handleArchiveNotice(req, res, params);

    if (method === 'POST' && pathname === '/api/hooks/wait') return handleWait(req, res);
    if (method === 'POST' && pathname === '/api/hooks/response') return handleCursorResponse(req, res);
    if (method === 'POST' && pathname === '/api/hooks/notify') return handleNotify(req, res);
    if (method === 'POST' && pathname === '/api/hooks/images') return handleImageUpload(req, res, url);

    params = match(pathname, '/api/hooks/images/:file');
    if ((method === 'HEAD' || method === 'GET') && params) return handleImageProbe(req, res, params);

    params = match(pathname, '/api/hooks/wait/:id/resolve');
    if (method === 'GET' && params) return handleResolve(req, res, params);

    if (method === 'GET') return serveStatic(req, res, pathname);

    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    console.error('[pitwall]', error);
    if (!res.headersSent) sendJson(res, 500, { error: error.message || 'internal error' });
  }
}

export function startServer() {
  fs.mkdirSync(paths.public, { recursive: true });
  fs.mkdirSync(paths.images, { recursive: true });

  const server = http.createServer((req, res) => {
    router(req, res);
  });

  server.listen(config.port, config.host, () => {
    console.log(`[pitwall] http://${config.host}:${config.port}/`);
  });

  const shutdown = () => {
    console.log('[pitwall] shutting down…');
    for (const id of store.list().filter((e) => e.status === 'waiting').map((e) => e.id)) {
      waiters.drop(id);
    }
    store.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) startServer();
