import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, paths } from './config.mjs';
import * as store from './store.mjs';
import * as waiters from './waiters.mjs';
import { buildEntry, publicEntry } from './normalize.mjs';
import { collectImages, mimeForFile } from './images.mjs';

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
  store.pushResponse(conversationId, text);
  sendJson(res, 200, { ok: true });
}

async function handleNotify(req, res) {
  const body = await readBody(req);
  const agent = body.agent || 'claude';
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

  if (agent === 'cursor') {
    const conversationId = body.conversationId || body.conversation_id;
    turnMessages = store.takeResponses(conversationId);
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

  const images = await collectImages(
    [bodyText, ...turnMessages].join('\n'),
    searchDirs,
  );

  const sessionId = body.sessionId || body.session_id || body.conversationId || body.conversation_id;
  if (agent === 'claude' && sessionId) {
    store.noteSessionTurn(sessionId, { continuedByHook: Boolean(body.stop_hook_active) });
  }
  const sessionBlocks = agent === 'claude' ? store.sessionBlockCount(sessionId) : 0;

  const entry = buildEntry({
    agent,
    kind: 'wait',
    payload: body,
    body: bodyText,
    turnMessages,
    images,
    sessionBlocks,
  });

  waiters.reserve(entry.id, { createdAtMs: entry.createdAtMs });
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

  // Client disconnect (agent interrupted) → mark detached.
  let finished = false;
  const onClose = () => {
    if (finished) return;
    finished = true;
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
    sendJson(res, 200, { action: 'release', reason });
    return;
  }

  if (resolution.action === 'reply') {
    if (entry.agent === 'claude' && entry.sessionId) {
      store.noteSessionBlock(entry.sessionId);
    }
    store.update(entry.id, {
      status: 'answered',
      resolvedAt: new Date().toISOString(),
      resolution: 'reply',
      reply: resolution.message,
    });
    sendJson(res, 200, { action: 'reply', message: resolution.message });
    return;
  }

  if (resolution.action === 'dismiss') {
    store.update(entry.id, {
      status: 'dismissed',
      resolvedAt: new Date().toISOString(),
      resolution: 'dismiss',
    });
    sendJson(res, 200, { action: 'dismiss' });
    return;
  }

  sendJson(res, 200, { action: 'release', reason: 'unknown' });
}

async function handleList(req, res, url) {
  const view = url.searchParams.get('view') || 'timeline';
  const repo = url.searchParams.getAll('repo');
  const agent = url.searchParams.getAll('agent');
  const order = url.searchParams.get('order') || 'desc';

  let items = store.list().map(publicEntry);

  if (view === 'timeline') {
    items = items.filter((e) => store.ACTIVE_STATUSES.has(e.status));
  } else if (view === 'archive') {
    items = items.filter((e) => store.ARCHIVE_STATUSES.has(e.status));
  }

  if (repo.length) {
    const set = new Set(repo);
    items = items.filter((e) => set.has(e.repo?.key));
  }
  if (agent.length) {
    const set = new Set(agent);
    items = items.filter((e) => set.has(e.agent));
  }

  items.sort((a, b) => {
    const da = Date.parse(a.createdAt);
    const db = Date.parse(b.createdAt);
    return order === 'asc' ? da - db : db - da;
  });

  sendJson(res, 200, {
    entries: items,
    repos: store.repos(),
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
  sendJson(res, 200, { ok: true });
}

async function handleDismiss(req, res, params) {
  const entry = store.get(params.id);
  if (!entry) return sendJson(res, 404, { error: 'not found' });
  if (entry.status === 'waiting') {
    const ok = waiters.resolve(params.id, { action: 'dismiss' });
    if (!ok) {
      store.update(params.id, {
        status: 'dismissed',
        resolvedAt: new Date().toISOString(),
        resolution: 'dismiss-offline',
      });
    }
    return sendJson(res, 200, { ok: true });
  }
  if (entry.status === 'notice') {
    store.update(params.id, {
      status: 'dismissed',
      resolvedAt: new Date().toISOString(),
      resolution: 'dismiss',
    });
    return sendJson(res, 200, { ok: true });
  }
  sendJson(res, 409, { error: 'not dismissable', status: entry.status });
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

  const file = path.join(paths.public, rel);
  if (!file.startsWith(paths.public)) {
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
