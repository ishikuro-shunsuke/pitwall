#!/usr/bin/env node
/**
 * What a card belongs to, and waving one through to a later hour.
 *
 * Google is never called here: the Tasks half of Blue flag is covered by the
 * stubbed service in test/todo.mjs. This drives the parts that are pitwall's
 * own — which keys make a project, which wait to be told, and what a card looks
 * like on the way out and back.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4477 + Math.floor(Math.random() * 1000);
const DATA = await fsp.mkdtemp(path.join(os.tmpdir(), 'pitwall-projects-'));
const BASE = `http://127.0.0.1:${PORT}`;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
      env: {
        ...process.env,
        PITWALL_PORT: String(PORT),
        PITWALL_HOST: '127.0.0.1',
        PITWALL_DATA: DATA,
        PITWALL_HOLD_SECONDS: '30',
        PITWALL_MAX_HOLD_SECONDS: '60',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let booted = false;
    child.stdout.on('data', (b) => {
      if (!booted && b.toString().includes('http://')) {
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

const entriesById = async () => {
  const { data } = await json('GET', '/api/entries?view=all');
  return new Map((data.entries || []).map((e) => [e.id, e]));
};

async function makeAgentCard(sessionId, root, name) {
  const { data } = await json('POST', '/api/hooks/wait', {
    agent: 'claude',
    sessionId,
    last_assistant_message: 'A or B?',
    repo: { root, name },
    host: { cwd: root },
  });
  return data.id;
}

/**
 * The keys, driven straight. A chat room and a task list reach a card from
 * inside their own service rather than off a hook payload, so there is no
 * request that could put one on the timeline from out here.
 */
async function keys() {
  process.env.PITWALL_DATA = DATA;
  const projects = await import(`${ROOT}/src/projects.mjs`);
  const card = (over) => ({ agent: 'chatwork', repo: { name: 'x' }, ...over });

  const cases = [
    ['repo', card({ agent: 'claude', repo: { root: '/w/kirin', name: 'kirin' } }), 'repo:/w/kirin'],
    ['list', card({ agent: 'todo', todo: { listId: 'L1' }, repo: { name: 'delta-infra' } }), 'list:L1'],
    ['room', card({ chatwork: { roomId: '4412' } }), 'room:4412'],
    ['mail', card({ agent: 'mail', mail: { from: 'Sato@Acme.example' } }), 'mail:sato@acme.example'],
    ['cal', card({ agent: 'calendar', calendar: {}, title: '[nova-crm] 週次' }), 'cal:nova-crm'],
    ['cal-none', card({ agent: 'calendar', calendar: {}, title: '歯医者' }), null],
  ];
  const wrong = cases.filter(([, entry, want]) => projects.keyOf(entry) !== want);
  if (!wrong.length) ok('every source names its key');
  else fail('every source names its key', wrong.map(([n, e, w]) => `${n}: ${projects.keyOf(e)} ≠ ${w}`));

  // A booking's brackets are the project; a list and a repository make theirs
  // from their own name. A room and a sender arrive by the hundred and wait.
  const made = {
    repo: projects.ensure(cases[0][1]),
    list: projects.ensure(cases[1][1]),
    cal: projects.ensure(cases[4][1]),
    room: projects.ensure(cases[2][1]),
    mail: projects.ensure(cases[3][1]),
  };
  if (made.repo === 'kirin' && made.list === 'delta-infra' && made.cal === 'nova-crm'
    && made.room === null && made.mail === null) {
    ok('three kinds make their own project and two wait to be told');
  } else {
    fail('three kinds make their own project and two wait to be told', made);
  }

  // Told, then untold, and it does not quietly come back on the next card.
  projects.assign('room:4412', 'nova-crm');
  const told = projects.nameFor('room:4412');
  projects.assign('room:4412', null);
  const untold = projects.nameFor('room:4412');
  const again = projects.ensure(cases[2][1]);
  if (told === 'nova-crm' && untold === null && again === null) {
    ok('a key taken out of every project stays out');
  } else {
    fail('a key taken out of every project stays out', { told, untold, again });
  }

  // Spelling is the whole of the match.
  projects.assign('room:4412', 'Nova-CRM');
  const names = projects.list().map((p) => p.name);
  if (names.includes('Nova-CRM') && names.includes('nova-crm')) {
    ok('a different spelling is a different project');
  } else {
    fail('a different spelling is a different project', names);
  }
}

async function main() {
  console.log(`projects → ${BASE}  data=${DATA}`);
  await keys();
  const child = await startServer();

  try {
    // A repository is something you made on purpose, and there are few of them.
    const kirin = await makeAgentCard('s-kirin', '/workspaces/kirin-etl', 'kirin-etl');
    {
      const card = (await entriesById()).get(kirin);
      if (card?.project === 'kirin-etl' && card.projectKey === 'repo:/workspaces/kirin-etl') {
        ok('a repository makes its project the first time it is seen');
      } else {
        fail('a repository makes its project the first time it is seen', card);
      }
    }

    // The key moved, not the card: a repository put somewhere else takes its
    // whole history with it.
    {
      await json('POST', `/api/entries/${kirin}/project`, { name: 'acme-portal' });
      const card = (await entriesById()).get(kirin);
      const { data } = await json('GET', '/api/projects');
      const names = data.projects.map((p) => p.name);
      if (card.project === 'acme-portal' && !names.includes('kirin-etl')) {
        ok('rebinding moves every card and drops the project left holding none');
      } else {
        fail('rebinding moves every card and drops the project left holding none', { card, names });
      }
    }

    // Out of everything, and it stays out — the next card off that repository
    // must not quietly make the project again.
    {
      await json('POST', `/api/entries/${kirin}/project`, { name: null });
      const before = (await entriesById()).get(kirin);
      await makeAgentCard('s-kirin-2', '/workspaces/kirin-etl', 'kirin-etl');
      const after = [...(await entriesById()).values()]
        .filter((e) => e.projectKey === 'repo:/workspaces/kirin-etl');
      if (before.project === null && after.every((e) => e.project === null)) {
        ok('taking a repository out of every project sticks');
      } else {
        fail('taking a repository out of every project sticks', { before: before.project, after: after.map((e) => e.project) });
      }
    }

    // Both lines, or nothing.
    const soon = new Date(Date.now() + 3600_000).toISOString();
    {
      const noMove = await json('POST', `/api/entries/${kirin}/pass`, { outLap: 'x', dueAt: soon });
      const noLap = await json('POST', `/api/entries/${kirin}/pass`, { firstMove: 'x', dueAt: soon });
      const past = await json('POST', `/api/entries/${kirin}/pass`, {
        firstMove: 'x', outLap: 'y', dueAt: new Date(Date.now() - 1000).toISOString(),
      });
      if (noMove.status === 400 && noLap.status === 400 && past.status === 400) {
        ok('both lines and a future time are required');
      } else {
        fail('both lines and a future time are required', {
          noMove: noMove.status, noLap: noLap.status, past: past.status,
        });
      }
    }

    // Waved through: off the timeline, into History, holding what you wrote.
    {
      const res = await json('POST', `/api/entries/${kirin}/pass`, {
        firstMove: 'loads.sql を開いて retention の行を書く',
        outLap: 'ステージング1本ぶんだけ通す',
        dueAt: soon,
      });
      const card = (await entriesById()).get(kirin);
      if (res.status === 200
        && card.status === 'passed'
        && card.bucket === 'archive'
        && card.pass.firstMove.startsWith('loads.sql')
        && card.pass.count === 1
        && card.pass.was === 'waiting') {
        ok('a passed card leaves the timeline holding both lines');
      } else {
        fail('a passed card leaves the timeline holding both lines', { res: res.data, card });
      }
    }

    // Due while nobody was looking: it comes back as it stood, and the count
    // remembers that this is not the first time.
    {
      const now = new Date(Date.now() + 400).toISOString();
      await json('POST', `/api/entries/${kirin}/pass`, {
        firstMove: 'もう一度', outLap: '1本だけ', dueAt: now,
      });
      await sleep(1500);
      const card = (await entriesById()).get(kirin);
      if (card.status === 'waiting' && card.bucket === 'timeline' && card.pass.count === 2) {
        ok('it comes back as it stood, counting the times');
      } else {
        fail('it comes back as it stood, counting the times', {
          status: card.status, bucket: card.bucket, count: card.pass?.count,
        });
      }
    }

    // Nothing durable behind it, so nothing to file it under.
    {
      const res = await json('POST', '/api/hooks/notify', {
        agent: 'desktop',
        notificationType: 'ask_user_question',
        body: 'どちらにしますか',
      });
      const card = (await entriesById()).get(res.data.id);
      const put = await json('POST', `/api/entries/${res.data.id}/project`, { name: 'x' });
      if (card?.projectKey === null && put.status === 409) {
        ok('a card with nothing behind it has nothing to hang a project on');
      } else {
        fail('a card with nothing behind it has nothing to hang a project on', {
          key: card?.projectKey, put: put.status,
        });
      }
    }
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    await fsp.rm(DATA, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
