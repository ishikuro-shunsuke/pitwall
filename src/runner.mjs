/**
 * Reaching a session whose hold has already run out.
 *
 * A Claude Code card is answerable for as long as its hook is still holding the
 * slot. Past that the hook is gone, and until now the card was a dead end: the
 * question is still there, the session is still on disk, and there was nothing
 * on the page that could reach it. The way back was a command to copy and a
 * terminal to paste it into — and where the session lives in a container, a
 * terminal in that container.
 *
 * So the browser does not reach in. Each place an agent runs keeps a runner,
 * and the runner reaches out: it holds a poll open here and takes the work that
 * belongs to it. Same direction as every hook, which is what makes a container
 * no different from this machine — nothing listens on the far side and no port
 * has to be opened to it.
 *
 * What a runner does with a job is run the session again. The result comes back
 * the way it always does, as the stop hook's own card, so nothing here has to
 * carry it.
 */
import { config } from './config.mjs';

let nextId = 1;

/** @type {Map<string, object>} */
const jobs = new Map();

/** Polls held open by runners with nothing to do yet. */
const idle = new Set();

/** Called with the job when it stops being deliverable. See `onSettled`. */
let settled = null;

export function onSettled(fn) {
  settled = fn;
}

function newJobId() {
  const id = `job_${Date.now().toString(36)}_${nextId}`;
  nextId += 1;
  return id;
}

/**
 * A runner names the directories it can run in, and a job names the one it has
 * to run in. Both are read on the same side of any container boundary — the
 * card carries the path the agent itself reported — so they are comparable
 * without translating anything.
 */
function serves(roots, cwd) {
  if (!cwd) return false;
  return roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
}

export function normalizeRoots(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  return list
    .map((s) => String(s).trim().replace(/\\/g, '/').replace(/\/+$/, ''))
    .filter(Boolean);
}

/** The job a waiting runner should be handed, oldest first. */
function pick(roots) {
  let found = null;
  for (const job of jobs.values()) {
    if (job.status !== 'queued' || !serves(roots, job.cwd)) continue;
    if (!found || job.createdAtMs < found.createdAtMs) found = job;
  }
  return found;
}

function handOver(job, waiter) {
  job.status = 'running';
  job.takenAtMs = Date.now();
  if (job.timer) clearTimeout(job.timer);
  job.timer = null;
  // `settle` takes the waiter out of `idle` itself, so it cannot be handed a
  // second job by the loop that is walking the set.
  waiter.settle(publicJob(job));
}

function publicJob(job) {
  return {
    id: job.id,
    entryId: job.entryId,
    sessionId: job.sessionId,
    cwd: job.cwd,
    message: job.message,
  };
}

/**
 * Queue a turn for whichever runner covers that directory.
 *
 * Nobody may be covering it — a container that is not running, a runner never
 * started — and that is not an error the browser can be told about in time to
 * be useful. The job waits its claim window and then gives up, which is what
 * `onSettled` is for: the card goes back to being unanswered, with the reason
 * on it, rather than sitting there looking sent.
 */
export function enqueue({ entryId, sessionId, cwd, message }) {
  const job = {
    id: newJobId(),
    entryId,
    sessionId,
    cwd: String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, ''),
    message,
    status: 'queued',
    createdAtMs: Date.now(),
    takenAtMs: null,
    timer: null,
  };
  jobs.set(job.id, job);

  for (const waiter of idle) {
    if (!serves(waiter.roots, job.cwd)) continue;
    handOver(job, waiter);
    return job;
  }

  job.timer = setTimeout(() => {
    if (jobs.get(job.id) !== job || job.status !== 'queued') return;
    jobs.delete(job.id);
    settled?.(job, { ok: false, error: 'no runner covering that directory' });
  }, config.runner.claimSeconds * 1000);
  job.timer.unref?.();
  return job;
}

/**
 * Long-poll side. Resolves with a job, or null when the window passes with
 * nothing to do — the runner asks again, and the gap between the two is the
 * only time a job can be queued without a poll to hand it to.
 */
export function take(roots, { waitMs = config.runner.pollSeconds * 1000, signal = null } = {}) {
  const ready = pick(roots);
  if (ready) {
    ready.status = 'running';
    ready.takenAtMs = Date.now();
    if (ready.timer) clearTimeout(ready.timer);
    ready.timer = null;
    return Promise.resolve(publicJob(ready));
  }

  return new Promise((resolve) => {
    const waiter = { roots, settle: null };
    // A poll whose connection has dropped must stop being a candidate before
    // the next job is queued, or that job is handed to nobody and the card is
    // left saying it was sent.
    const give = (job) => {
      if (!idle.delete(waiter)) return;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(job);
    };
    const abort = () => give(null);
    const timer = setTimeout(() => give(null), waitMs);
    timer.unref?.();
    waiter.settle = give;
    idle.add(waiter);
    if (signal?.aborted) return give(null);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * The runner reporting back. Success is not the end of the work — the session
 * is only just starting — it is the end of what this queue is responsible for,
 * and the card that comes out of the session arrives on its own.
 */
export function finish(jobId, { ok = true, error = null } = {}) {
  const job = jobs.get(jobId);
  if (!job) return false;
  jobs.delete(jobId);
  if (job.timer) clearTimeout(job.timer);
  if (!ok) settled?.(job, { ok: false, error: error || 'the runner could not start it' });
  return true;
}

export function status() {
  const queued = [...jobs.values()].filter((j) => j.status === 'queued').length;
  return { queued, running: jobs.size - queued, runners: idle.size };
}

/** Test seam: forget everything without waiting on any of the timers. */
export function reset() {
  for (const job of jobs.values()) {
    if (job.timer) clearTimeout(job.timer);
  }
  jobs.clear();
  for (const waiter of idle) waiter.settle?.(null);
  idle.clear();
}
