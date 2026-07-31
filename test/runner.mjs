#!/usr/bin/env node
/**
 * Answering a card whose hold has run out.
 *
 * Drives the queue between the browser and a runner without ever starting a
 * session: `claude` is not on the far end here, the HTTP is. What the runner
 * does with a job it has taken is its own business and is not tested from here.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4477 + Math.floor(Math.random() * 1000);
const DATA = await fsp.mkdtemp(path.join(os.tmpdir(), 'pitwall-runner-'));
const BASE = `http://127.0.0.1:${PORT}`;

/** Long enough for a claude card to be created, short enough to sit through. */
const HOLD_SECONDS = 2;
const CLAIM_SECONDS = 2;

let passed = 0;
let failed = 0;

function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}
function fail(name, err) {
  failed += 1;
  console.error(`  FAIL ${name}: ${err?.message || JSON.stringify(err)}`);
}

async function json(method, pathname, body, { timeoutMs = 5000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
      env: {
        ...process.env,
        PITWALL_PORT: String(PORT),
        PITWALL_HOST: '127.0.0.1',
        PITWALL_DATA: DATA,
        PITWALL_HOLD_SECONDS: String(HOLD_SECONDS),
        PITWALL_MAX_HOLD_SECONDS: String(HOLD_SECONDS),
        PITWALL_RUNNER_CLAIM_SECONDS: String(CLAIM_SECONDS),
        PITWALL_RUNNER_POLL_SECONDS: '2',
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
    child.stderr.on('data', (b) => process.stderr.write(b));
    child.on('exit', (code) => {
      if (!booted) reject(new Error(`server exited early: ${code}`));
    });
    setTimeout(() => {
      if (!booted) reject(new Error('server boot timeout'));
    }, 5000);
  });
}

/** A claude card, left alone until its hold runs out. */
async function expiredCard(sessionId, root = DATA) {
  const created = await json('POST', '/api/hooks/wait', {
    agent: 'claude',
    sessionId,
    last_assistant_message: 'A or B?',
    repo: { root, name: path.basename(root) },
    host: { cwd: root },
  });
  if (!created.data?.id) throw new Error('no id from wait');
  // Nothing polls `/resolve`, so the slot retires itself on its own clock.
  await sleep(HOLD_SECONDS * 1000 + 600);
  return created.data.id;
}

async function main() {
  console.log(`runner → ${BASE}  data=${DATA}`);
  const child = await startServer();

  try {
    // A card past its hold says so, and says it can still be reached.
    let id = await expiredCard('sess-resume-1');
    {
      const { data } = await json('GET', `/api/entries/${id}`);
      if (data.entry?.status === 'expired' && data.entry.resumable === true) {
        ok('an expired claude card is resumable');
      } else {
        fail('an expired claude card is resumable', {
          status: data.entry?.status, resumable: data.entry?.resumable,
        });
      }
    }

    // The reply goes to a runner that is already waiting, and the card leaves
    // the timeline the way any answered one does.
    {
      const pollP = json('GET', `/api/runner/next?roots=${encodeURIComponent(DATA)}`, null, { timeoutMs: 10_000 });
      await sleep(100);
      const reply = await json('POST', `/api/entries/${id}/reply`, { message: 'B please' });
      if (reply.status === 200 && reply.data.resumed) ok('a reply to an expired card is accepted');
      else fail('a reply to an expired card is accepted', reply.data);

      const poll = await pollP;
      const job = poll.data?.job;
      if (job?.sessionId === 'sess-resume-1' && job.message === 'B please' && job.cwd === DATA) {
        ok('the waiting runner is handed the job');
      } else {
        fail('the waiting runner is handed the job', poll.data);
      }

      const after = await json('GET', `/api/entries/${id}`);
      if (after.data.entry?.status === 'answered' && after.data.entry.resolution === 'resumed') {
        ok('the card is answered while the session restarts');
      } else {
        fail('the card is answered while the session restarts', after.data.entry);
      }

      // A runner that could not start it puts the card back, with the reason
      // and the text still in the box.
      const done = await json('POST', `/api/runner/jobs/${job.id}/done`, { ok: false, error: 'claude is not on PATH here' });
      if (done.status === 200) ok('the runner can report a failure');
      else fail('the runner can report a failure', done.data);

      const back = await json('GET', `/api/entries/${id}`);
      const entry = back.data.entry;
      if (entry?.status === 'expired'
        && entry.resumable === true
        && entry.resumeError === 'claude is not on PATH here'
        && entry.resumeText === 'B please'
        && !entry.reply) {
        ok('a failure puts the card back with the reason and the text');
      } else {
        fail('a failure puts the card back with the reason and the text', {
          status: entry?.status, error: entry?.resumeError, text: entry?.resumeText, reply: entry?.reply,
        });
      }
    }

    // A job for a directory this runner does not cover is not its job.
    {
      const other = path.join(DATA, 'not-mine');
      const poll = await json('GET', `/api/runner/next?roots=${encodeURIComponent(other)}`, null, { timeoutMs: 10_000 });
      if (poll.status === 204) ok('a runner is not handed another directory\'s job');
      else fail('a runner is not handed another directory\'s job', poll.data);
    }

    // Nobody covering it at all: the card comes back on its own, saying so.
    {
      const reply = await json('POST', `/api/entries/${id}/reply`, { message: 'still B' });
      if (reply.status !== 200) fail('a second reply is accepted', reply.data);
      else ok('a second reply is accepted');

      await sleep(CLAIM_SECONDS * 1000 + 600);
      const back = await json('GET', `/api/entries/${id}`);
      const entry = back.data.entry;
      if (entry?.status === 'expired' && /no runner/.test(entry.resumeError || '')) {
        ok('a job nobody takes comes back to the card');
      } else {
        fail('a job nobody takes comes back to the card', {
          status: entry?.status, error: entry?.resumeError,
        });
      }
    }

    // Cursor names a conversation, not a session `--resume` could read, so its
    // cards stay the dead end they were.
    {
      const created = await json('POST', '/api/hooks/wait', {
        agent: 'cursor',
        conversationId: 'conv-1',
        repo: { root: DATA, name: 'runner-repo' },
        host: { cwd: DATA },
      });
      await sleep(HOLD_SECONDS * 1000 + 600);
      const { data } = await json('GET', `/api/entries/${created.data.id}`);
      if (data.entry?.resumable === false) ok('an expired cursor card is not resumable');
      else fail('an expired cursor card is not resumable', data.entry);

      const reply = await json('POST', `/api/entries/${created.data.id}/reply`, { message: 'hi' });
      if (reply.status === 409) ok('and it refuses a reply');
      else fail('and it refuses a reply', reply);
    }

    // A poll has to say where it can run.
    {
      const { status } = await json('GET', '/api/runner/next');
      if (status === 400) ok('a poll without roots is refused');
      else fail('a poll without roots is refused', status);
    }
  } finally {
    child.kill('SIGTERM');
    await sleep(200);
    await fsp.rm(DATA, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
