#!/usr/bin/env node
/**
 * The Claude Desktop connector, against a temporary pitwall server.
 *
 * Two halves: the `?hold=` poll on its own over plain HTTP, and the MCP server
 * spoken to over a pipe the way Claude Desktop speaks to it.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5477 + Math.floor(Math.random() * 1000);
const DATA = await fsp.mkdtemp(path.join(os.tmpdir(), 'pitwall-mcp-'));
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}
function fail(name, detail) {
  failed += 1;
  console.error(`  FAIL ${name}: ${detail}`);
}
function is(name, actual, expected) {
  if (actual === expected) ok(name);
  else fail(name, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

async function json(method, pathname, body, { timeoutMs = 5000 } = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
      env: {
        ...process.env,
        PITWALL_PORT: String(PORT),
        PITWALL_HOST: '127.0.0.1',
        PITWALL_DATA: DATA,
        PITWALL_HOLD_SECONDS: '6',
        PITWALL_MAX_HOLD_SECONDS: '60',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let booted = false;
    child.stdout.on('data', (buf) => {
      if (!booted && buf.toString().includes('http://')) {
        booted = true;
        resolve(child);
      }
    });
    child.on('exit', (code) => {
      if (!booted) reject(new Error(`server exited early: ${code}`));
    });
    setTimeout(() => {
      if (!booted) reject(new Error('server boot timeout'));
    }, 5000);
  });
}

/** An MCP server on a pipe, with replies matched back to the id that asked. */
function startMcp({ url = BASE, pollSeconds = 3 } = {}) {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'bin', 'pitwall-mcp.mjs'), '--url', url, '--poll-seconds', String(pollSeconds)],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const pending = new Map();
  const stray = [];
  let buffer = '';

  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        stray.push(line);
        continue;
      }
      const settle = pending.get(message.id);
      if (settle) {
        pending.delete(message.id);
        settle(message);
      } else {
        stray.push(line);
      }
    }
  });

  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const call = (name, args) => rpc('tools/call', { name, arguments: args });

  return { child, rpc, notify, call, stray, kill: () => child.kill('SIGTERM') };
}

const waitCard = async () => {
  const { data } = await json('POST', '/api/hooks/wait', { agent: 'desktop', body: 'q?' });
  return data.id;
};
const statusOf = async (id) => {
  const { data } = await json('GET', '/api/entries?view=all');
  return data.entries.find((e) => e.id === id)?.status;
};
const cardWhere = async (fn) => {
  const { data } = await json('GET', '/api/entries?view=all');
  return data.entries.find(fn);
};

async function main() {
  console.log(`mcp → ${BASE}  data=${DATA}`);
  const server = await startServer();
  let mcp = null;

  try {
    /* ---------------------------------------------- the ?hold= poll alone -- */

    const a = await waitCard();
    const first = await json('GET', `/api/hooks/wait/${a}/resolve?hold=1`);
    is('hold= hands the poll back', first.data.action, 'pending');
    is('and names the entry', first.data.id, a);
    is('which is still waiting', await statusOf(a), 'waiting');

    await json('POST', `/api/entries/${a}/reply`, { message: 'between polls' });
    is('a reply with nothing polling is recorded', await statusOf(a), 'answered');
    const second = await json('GET', `/api/hooks/wait/${a}/resolve?hold=1`);
    is('and the next poll collects it', second.data.action, 'reply');
    is('with the text intact', second.data.message, 'between polls');

    const b = await waitCard();
    const live = json('GET', `/api/hooks/wait/${b}/resolve?hold=10`, null, { timeoutMs: 12_000 });
    await sleep(200);
    await json('POST', `/api/entries/${b}/reply`, { message: 'during' });
    is('a reply mid-poll beats the pending timer', (await live).data.action, 'reply');

    const c = await waitCard();
    const ctrl = new AbortController();
    const dropped = fetch(`${BASE}/api/hooks/wait/${c}/resolve?hold=30`, {
      signal: ctrl.signal,
    }).catch(() => null);
    await sleep(300);
    ctrl.abort();
    await dropped;
    await sleep(200);
    is('a dropped hold= poll leaves the card alone', await statusOf(c), 'waiting');

    // The hook path is unchanged: a poll with no hold= still means the agent is
    // holding, and dropping it still means it was interrupted.
    const d = await waitCard();
    const ctrl2 = new AbortController();
    const plain = fetch(`${BASE}/api/hooks/wait/${d}/resolve`, { signal: ctrl2.signal })
      .catch(() => null);
    await sleep(300);
    ctrl2.abort();
    await plain;
    await sleep(200);
    is('a dropped plain poll still detaches', await statusOf(d), 'detached');

    const e = await waitCard();
    const clamped = await json('GET', `/api/hooks/wait/${e}/resolve?hold=99999`, null, {
      timeoutMs: 20_000,
    });
    is('an absurd hold= is clamped to the hold', clamped.data.action, 'release');

    /* --------------------------------------------------------- the server -- */

    mcp = startMcp();

    const init = await mcp.rpc('initialize', { protocolVersion: '2025-11-25' });
    is('initialize echoes a version it knows', init.result.protocolVersion, '2025-11-25');
    is('and offers tools', typeof init.result.capabilities.tools, 'object');
    is('and tells the model what pitwall is for', typeof init.result.instructions, 'string');

    const odd = await mcp.rpc('initialize', { protocolVersion: '1.0.0' });
    is('an unknown version is answered, not refused', odd.result.protocolVersion, '2025-11-25');

    mcp.notify('notifications/initialized');
    await sleep(200);
    is('a notification is never answered', mcp.stray.length, 0);

    const listed = await mcp.rpc('tools/list');
    is('three tools', listed.result.tools.length, 3);
    is(
      'named for what they do',
      listed.result.tools.map((t) => t.name).join(','),
      'ask_user,wait_for_reply,notify_user',
    );
    is(
      'each with an object schema',
      listed.result.tools.every((t) => t.inputSchema.type === 'object'),
      true,
    );

    const missing = await mcp.rpc('foo/bar');
    is('an unknown method is a protocol error', missing.error.code, -32601);

    /* ------------------------------------------------------- the round trip -- */

    const asking = mcp.call('ask_user', { question: 'Ship it?', options: ['yes', 'no'] });
    let card = null;
    for (let i = 0; i < 40 && !card; i += 1) {
      await sleep(50);
      card = await cardWhere((x) => x.agent === 'desktop' && x.status === 'waiting');
    }
    if (!card) throw new Error('no card appeared for ask_user');
    ok('asking puts a card on the timeline');
    is('under an id of its own', card.id.slice(0, 3), 'de_');
    is('titled with the question', card.title, 'Ship it?');
    is('the question is the card\'s own sentence', card.body.includes('**Ship it?**'), true);
    is('and the choices are listed', card.body.includes('- yes'), true);
    is('with somewhere to say it came from', card.repo.name, 'Claude Desktop');
    is('and no link to an editor that has no file', card.links?.file ?? null, null);

    await json('POST', `/api/entries/${card.id}/reply`, { message: 'yes, ship it' });
    const answered = await asking;
    is('the reply comes back as the result', answered.result.content[0].text.includes('yes, ship it'), true);
    is('and answering is not an error', answered.result.isError ?? false, false);

    /* -------------------------------------------- pending, then an answer -- */

    const slow = await mcp.call('ask_user', { question: 'Still there?' });
    const pendingText = slow.result.content[0].text;
    is('a question nobody answers comes back pending', pendingText.includes('Nobody has answered yet'), true);
    const pendingCard = await cardWhere((x) => x.agent === 'desktop' && x.status === 'waiting');
    is('naming the id to call back with', pendingText.includes(pendingCard.id), true);
    is('and the card is still waiting', pendingCard.status, 'waiting');

    await json('POST', `/api/entries/${pendingCard.id}/reply`, { message: 'still here' });
    const resumed = await mcp.call('wait_for_reply', { id: pendingCard.id });
    is('wait_for_reply picks the answer up', resumed.result.content[0].text.includes('still here'), true);

    const stale = await mcp.call('wait_for_reply', { id: 'de_nosuchthing' });
    is('an id pitwall never had is an error', stale.result.isError, true);

    /* ------------------------------------------------------ box and expiry -- */

    const boxing = mcp.call('ask_user', { question: 'Box me' });
    let boxCard = null;
    for (let i = 0; i < 40 && !boxCard; i += 1) {
      await sleep(50);
      boxCard = await cardWhere((x) => x.agent === 'desktop' && x.status === 'waiting');
    }
    await json('POST', `/api/entries/${boxCard.id}/dismiss`);
    const boxed = await boxing;
    is('boxing says so', boxed.result.content[0].text.includes('chose not to answer'), true);
    is('and is not an error', boxed.result.isError ?? false, false);

    // PITWALL_HOLD_SECONDS is 6 and the poll window is 3, so the second poll
    // outlives the hold.
    const giving = await mcp.call('ask_user', { question: 'Nobody home' });
    const givingId = giving.result.content[0].text.match(/id "([^"]+)"/)?.[1];
    const gaveUp = await mcp.call('wait_for_reply', { id: givingId });
    is('an unanswered card ends in being told so', gaveUp.result.content[0].text.includes('Nobody answered'), true);
    is('which is an outcome, not a failure', gaveUp.result.isError ?? false, false);

    /* ------------------------------------------------------------ notices -- */

    const noted = await mcp.call('notify_user', { message: 'done with the thing' });
    is('a note is not an error', noted.result.isError ?? false, false);
    const notice = await cardWhere((x) => x.agent === 'desktop' && x.status === 'notice');
    is('and lands as a notice from the desktop, not from Claude Code', notice?.agent, 'desktop');
    is('carrying what it said', notice.body, 'done with the thing');

    /* ------------------------------------------------------ bad arguments -- */

    const blank = await mcp.call('ask_user', { question: '   ' });
    is('a blank question is the model\'s to fix', blank.result.isError, true);
    const unknown = await mcp.rpc('tools/call', { name: 'nope', arguments: {} });
    is('an unknown tool is a protocol error', unknown.error.code, -32602);

    /* -------------------------------------------------- pitwall not running -- */

    const orphan = startMcp({ url: 'http://127.0.0.1:1' });
    await orphan.rpc('initialize', { protocolVersion: '2025-11-25' });
    const nowhere = await orphan.call('ask_user', { question: 'anyone?' });
    is('with pitwall down, asking is an error', nowhere.result.isError, true);
    is('that says where it looked', nowhere.result.content[0].text.includes('127.0.0.1:1'), true);
    is('and nothing strange reached its stdout', orphan.stray.length, 0);
    orphan.kill();

    /* ------------------------------------------------------------ the pipe -- */

    is('nothing but JSON-RPC ever reached stdout', mcp.stray.length, 0);
  } catch (error) {
    fail('threw', error?.stack || error);
  } finally {
    mcp?.kill();
    server.kill('SIGTERM');
    await fsp.rm(DATA, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

await main();
