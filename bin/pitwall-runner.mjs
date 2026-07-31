#!/usr/bin/env node
/**
 * The process that answers a card whose hold has run out.
 *
 * One of these runs wherever sessions run — this machine, each container, each
 * distro. It holds a poll open against pitwall and takes the work for the
 * directories it was started with, so nothing listens on this side and no port
 * has to be opened to it. Same direction as the hooks, which is the only reason
 * a container needs nothing setting up.
 *
 * The work is one thing: start the session again with what you typed. What the
 * session says next comes back through its own stop hook, as a card, so there
 * is nothing here to report but whether it started.
 *
 *   node bin/pitwall-runner.mjs --url http://host.docker.internal:4477 --root /workspaces/proj
 *
 * `--root` may be given more than once, and defaults to the working directory.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);

function flag(name) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}`) {
      if (argv[i + 1]) out.push(argv[i + 1]);
      i += 1;
    } else if (argv[i].startsWith(`--${name}=`)) {
      out.push(argv[i].slice(name.length + 3));
    }
  }
  return out;
}

const BASE = (flag('url')[0] || process.env.PITWALL_URL || 'http://127.0.0.1:4477').replace(/\/+$/, '');
const CLAUDE = flag('claude')[0] || process.env.PITWALL_CLAUDE || 'claude';
const ROOTS = (flag('root').length ? flag('root') : [process.cwd()])
  .map((p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, ''));

/**
 * Longer than the server holds a poll open, so a quiet window ends at the
 * server's choosing rather than here — an abort on this side looks the same as
 * a runner that walked away, and the job it was about to be handed would have
 * to wait for the next round.
 */
const POLL_TIMEOUT_MS = 60_000;

/** How long to wait before asking again once something has gone wrong. */
const RETRY_MS = 5_000;

/** How long a started session has to fall over before it counts as started. */
const GRACE_MS = 3_000;

let running = true;

function log(...args) {
  console.log('[pitwall-runner]', ...args);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function next() {
  const url = new URL('/api/runner/next', BASE);
  url.searchParams.set('roots', ROOTS.join(','));
  const res = await fetch(url, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`pitwall answered ${res.status}`);
  const data = await res.json();
  return data.job || null;
}

async function done(jobId, body) {
  try {
    await fetch(new URL(`/api/runner/jobs/${jobId}/done`, BASE), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    // The job is already out of the queue on any answer we could have sent, so
    // there is nothing to retry — the card is the only thing left uninformed.
    log('could not report back:', error.message);
  }
}

/**
 * Resume, rather than a fresh session with the text pasted in: the transcript
 * is where two days of context still is, and the card only carries the last
 * thing said. `-p` is what makes it run without a terminal to talk to.
 *
 * The exit is not waited for. A stop hook holds its own card open for as long
 * as half an hour, so waiting here would mean one session at a time.
 */
function start(job) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, ['--resume', job.sessionId, '-p', job.message], {
      cwd: job.cwd,
      stdio: 'ignore',
      detached: false,
      env: process.env,
    });

    let answered = false;
    const answer = (body) => {
      if (answered) return;
      answered = true;
      resolve(body);
    };

    child.on('error', (error) => {
      answer({ ok: false, error: error.code === 'ENOENT' ? `${CLAUDE} is not on PATH here` : error.message });
    });
    // A session that is going to refuse — an id that is not on disk, a config
    // it cannot read — says so within moments. One still alive after that is
    // working, and will be for as long as the turn takes.
    child.on('spawn', () => {
      const grace = setTimeout(() => answer({ ok: true }), GRACE_MS);
      grace.unref?.();
    });
    child.on('exit', (code) => {
      if (code === 0) answer({ ok: true });
      else answer({ ok: false, error: `${CLAUDE} exited ${code}` });
    });
  });
}

async function loop() {
  log(`watching ${ROOTS.join(', ')} for ${BASE}`);
  let complained = false;

  while (running) {
    let job = null;
    try {
      job = await next();
      if (complained) {
        log('connected');
        complained = false;
      }
    } catch (error) {
      if (!complained) {
        log('cannot reach pitwall:', error.message);
        complained = true;
      }
      await sleep(RETRY_MS);
      continue;
    }

    if (!job) continue;
    log(`resuming ${job.sessionId} in ${job.cwd}`);
    const result = await start(job);
    if (!result.ok) log(`could not start it: ${result.error}`);
    await done(job.id, result);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    running = false;
    process.exit(0);
  });
}

await loop();
