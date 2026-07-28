#!/usr/bin/env node
/**
 * Google Tasks → timeline entries, against a stubbed Google.
 * Never touches the network, and never reads a real token.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DATA = await fsp.mkdtemp(path.join(os.tmpdir(), 'pitwall-todo-'));
process.env.PITWALL_DATA = DATA;
process.env.PITWALL_GOOGLE_CLIENT_ID = 'test-client';
process.env.PITWALL_GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.PITWALL_TODO_DUE_HOUR = '9';

const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks';
const TOKEN = path.join(DATA, 'google-token.json');
const writeToken = (extra) => fs.writeFileSync(TOKEN, JSON.stringify({
  refresh_token: 'test-refresh',
  account: 'me@example.com',
  // A zone well away from wherever this test is running, so a card that used
  // the server's own clock instead of the account's is a failure and not a
  // coincidence.
  timeZone: 'Asia/Tokyo',
  scope: SCOPES,
  ...extra,
}));
writeToken();

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
  else fail(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const ZONE = 'Asia/Tokyo';
const { zonedTime, zonedDate, nextDate } = await import('../src/zoned.mjs');

// --- the clock the whole test hangs off --------------------------------------

/**
 * Real time is used everywhere else in this suite, but a rule that fires at
 * 09:00 cannot be tested at whatever o'clock the suite happens to run. So the
 * clock is moved instead: a Tokyo morning, ten minutes past the hour.
 */
const TODAY = '2026-07-28';
const TOMORROW = nextDate(TODAY, ZONE);
let clock = zonedTime(TODAY, ZONE, 9, 10);
const realNow = Date.now;
Date.now = () => clock;

is('zonedDate reads the date where the account lives', zonedDate(clock, ZONE), TODAY);
is('and midnight in Tokyo is 15:00 UTC the day before',
  new Date(zonedTime('2026-07-28', ZONE)).toISOString(), '2026-07-27T15:00:00.000Z');
is('a day is still a day across a DST shift',
  nextDate('2026-03-08', 'America/New_York'), '2026-03-09');

const LISTS = [
  { id: 'list-a', title: 'My Tasks' },
  { id: 'list-b', title: 'Work' },
  { id: 'list-c', title: 'Someday' },
];

const due = (dateStr) => `${dateStr}T00:00:00.000Z`;

let tasks = {
  'list-a': [
    {
      id: 'today',
      title: 'Send the invoice',
      status: 'needsAction',
      due: due(TODAY),
      notes: 'Bank details are in the shared drive',
      webViewLink: 'https://tasks.google.com/task/today',
      links: [{ type: 'email', description: 'The thread', link: 'https://mail.example.com/1' }],
    },
    {
      id: 'late',
      title: 'Expenses',
      status: 'needsAction',
      due: due('2026-07-25'),
    },
    {
      id: 'undated',
      title: 'Someday, maybe',
      status: 'needsAction',
    },
    {
      id: 'done',
      title: 'Already ticked',
      status: 'completed',
      due: due(TODAY),
    },
    {
      id: 'gone',
      title: 'Deleted',
      status: 'needsAction',
      deleted: true,
      due: due(TODAY),
    },
  ],
  'list-b': [
    {
      id: 'soon',
      title: 'Deck for the review',
      status: 'needsAction',
      due: due(TOMORROW),
    },
  ],
  'list-c': [
    {
      id: 'other',
      title: 'From a third list',
      status: 'needsAction',
      due: due(TODAY),
    },
  ],
};

let tokenCalls = 0;
let broken = null;
const read = [];
const written = [];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.toString());
  const reply = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  if (url.href === 'https://oauth2.googleapis.com/token') {
    tokenCalls += 1;
    const form = new URLSearchParams(init.body);
    if (form.get('grant_type') !== 'refresh_token') return new Response('{}', { status: 400 });
    return reply({ access_token: 'test-access', expires_in: 3600 });
  }
  if (url.pathname.endsWith('/users/@me/lists')) {
    return reply({ items: LISTS });
  }
  const patch = url.pathname.match(/\/lists\/([^/]+)\/tasks\/([^/]+)$/);
  if (patch && init.method === 'PATCH') {
    const [listId, taskId] = patch.slice(1).map(decodeURIComponent);
    const body = JSON.parse(init.body);
    written.push({ listId, taskId, ...body });
    // Google stops handing back a task the moment it is completed, and the
    // test has to stop too, or nothing here proves the tick reached it.
    tasks = {
      ...tasks,
      [listId]: (tasks[listId] || []).map((t) => (t.id === taskId ? { ...t, ...body } : t)),
    };
    return reply({ id: taskId, ...body });
  }

  const listing = url.pathname.match(/\/lists\/([^/]+)\/tasks$/);
  if (listing) {
    const id = decodeURIComponent(listing[1]);
    read.push({ id, dueMax: Date.parse(url.searchParams.get('dueMax')) });
    if (id === broken) return new Response('{"error":"gone"}', { status: 404 });
    // The stub honours dueMax the way Google does, so nothing the code failed
    // to ask for can arrive anyway and pass the test by accident.
    const within = (tasks[id] || []).filter((t) => !t.due || Date.parse(t.due) <= read.at(-1).dueMax);
    return reply({ items: within });
  }
  return new Response(JSON.stringify({ error: `unstubbed ${url.href}` }), { status: 500 });
};

const { internals } = await import('../src/todo.mjs');
const store = await import('../src/store.mjs');
store.init();

const cards = () => store.list().filter((e) => e.agent === 'todo');

// --- pure pieces -------------------------------------------------------------

is('the zone comes off the link, not off this machine', internals.zone(), ZONE);
is('a UTC-midnight due stamp is just a date', internals.dueDate({ due: due('2026-07-25') }), '2026-07-25');
is('a task with no due date has none', internals.dueDate({}), null);
is('lateness is counted in whole days', internals.daysBetween('2026-07-25', TODAY, ZONE), 3);
is('and it survives a spring-forward', internals.daysBetween('2026-03-07', '2026-03-09', 'America/New_York'), 2);
is('on the day itself the card says so', internals.overdueLine(TODAY, TODAY, ZONE), '**Due today**');
is('one day late is a day, not days',
  internals.overdueLine('2026-07-27', TODAY, ZONE), '**Overdue by 1 day** · was due Mon 27 Jul');
is('later than that it counts them',
  internals.overdueLine('2026-07-25', TODAY, ZONE), '**Overdue by 3 days** · was due Sat 25 Jul');

// --- one poll, past the hour -------------------------------------------------

await internals.poll();
internals.fireDue();

is('a card each for what is due today and what is already late', cards().length, 3);

const byTitle = (t) => cards().find((c) => c.title === t);
{
  const card = byTitle('Send the invoice');
  if (!card) fail('the task due today is on the timeline', 'no card');
  else {
    is('it is a notice', card.status, 'notice');
    is('it takes the list\'s name', card.repo.name, 'My Tasks');
    is('it is coloured by the service, not by a repo', card.repo.key, 'gtasks');
    is('it carries no editor link', card.links.openWorkspace, null);
    is('the card knows what it is owed against', card.todo.due, TODAY);
    is('and that it is not late yet', card.todo.overdueDays, 0);
    const has = (needle) => card.body.includes(needle);
    is('the body leads with the day', has('**Due today**'), true);
    is('the notes come through', has('Bank details are in the shared drive'), true);
    is('a link on the task is one click', has('[The thread](https://mail.example.com/1)'), true);
    is('and the task is reachable in Google', has('(https://tasks.google.com/task/today)'), true);
  }
}
{
  const card = byTitle('Expenses');
  if (!card) fail('the overdue task is on the timeline', 'no card');
  else {
    is('an overdue card says how far past it is', card.todo.overdueDays, 3);
    is('and reads that way', card.body.includes('**Overdue by 3 days**'), true);
  }
}

is('a task with no due date is never news', Boolean(byTitle('Someday, maybe')), false);
is('a completed task stays quiet', Boolean(byTitle('Already ticked')), false);
is('a deleted task stays quiet', Boolean(byTitle('Deleted')), false);
is('tomorrow\'s task is held, not fired', internals.pendingKeys().some((k) => k.includes('|soon|')), true);
is('and it is held for tomorrow', internals.pendingKeys().includes(`list-b|soon|${TOMORROW}`), true);
is('today\'s tasks are also held for tomorrow morning',
  internals.pendingKeys().includes(`list-a|late|${TOMORROW}`), true);

// --- polling again -----------------------------------------------------------

await internals.poll();
internals.fireDue();
is('a second poll does not repeat a card', cards().length, 3);
is('and the token was fetched once', tokenCalls, 1);
is('every list is read when none were named', new Set(read.map((r) => r.id)).size, 3);
is('a due date is a UTC midnight, so the window has to clear tomorrow\'s',
  read.every((r) => r.dueMax >= Date.parse(due(TOMORROW))), true);

// --- tomorrow ----------------------------------------------------------------

clock = zonedTime(TOMORROW, ZONE, 9, 10);
await internals.poll();
internals.fireDue();
is('the morning after, what is still undone says so again', cards().length, 7);
is('including the one that only came due today', Boolean(byTitle('Deck for the review')), true);
{
  const late = cards().filter((c) => c.title === 'Expenses');
  is('the overdue one is on its second morning', late.length, 2);
  is('and has aged a day', Math.max(...late.map((c) => c.todo.overdueDays)), 4);
}

// --- it gets ticked off ------------------------------------------------------

clock = zonedTime(nextDate(TOMORROW, ZONE), ZONE, 9, 10);
tasks = {
  ...tasks,
  'list-a': tasks['list-a'].map((t) => (t.id === 'late' ? { ...t, status: 'completed' } : t)),
};
await internals.poll();
internals.fireDue();
is('a task ticked off in Google stops coming round',
  cards().filter((c) => c.title === 'Expenses').length, 2);

// --- one list goes bad -------------------------------------------------------

{
  clock = zonedTime(nextDate(nextDate(TOMORROW, ZONE), ZONE), ZONE, 9, 10);
  broken = 'list-a';
  const before = cards().length;
  await internals.poll();
  internals.fireDue();
  is('a list that stops answering does not silence the others', cards().length > before, true);
  broken = null;
}

// --- a morning missed while the server was off -------------------------------

{
  // Unlike a meeting, a task owed this morning is still owed this evening.
  clock = zonedTime('2026-08-02', ZONE, 22, 0);
  const before = cards().length;
  await internals.poll();
  internals.fireDue();
  is('a morning missed with the server down still arrives', cards().length > before, true);
}

// --- restart -----------------------------------------------------------------

await internals.saveSeen();
internals.seen.clear();
internals.loadSeen();
const settled = cards().length;
await internals.poll();
internals.fireDue();
is('what was already said survives a restart', cards().length, settled);

// --- naming the lists --------------------------------------------------------

{
  const { config } = await import('../src/config.mjs');
  config.todo.listIds = ['list-b'];
  read.length = 0;
  await internals.poll();
  is('naming a list leaves the rest unread', read.map((r) => r.id).join(), 'list-b');
  config.todo.listIds = [];
}

// --- ticking one off ---------------------------------------------------------

{
  clock = zonedTime('2026-08-05', ZONE, 9, 10);
  await internals.poll();
  internals.fireDue();
  const card = cards().find((c) => c.title === 'Send the invoice');
  const held = internals.pendingKeys().filter((k) => k.startsWith('list-a|today|'));
  is('the task has tomorrow morning still queued', held.length, 1);

  const todo = await import('../src/todo.mjs');
  await todo.complete(card.todo);

  is('the tick reaches Google', written.length, 1);
  is('and says the task is done', written[0]?.status, 'completed');
  is('against the task the card came off', `${written[0]?.listId}|${written[0]?.taskId}`, 'list-a|today');
  is('the mornings already queued for it are dropped',
    internals.pendingKeys().some((k) => k.startsWith('list-a|today|')), false);

  const ticked = cards().filter((c) => c.title === 'Send the invoice').length;
  const others = cards().length - ticked;
  clock = zonedTime('2026-08-06', ZONE, 9, 10);
  await internals.poll();
  internals.fireDue();
  is('the next morning does not bring it round again',
    cards().filter((c) => c.title === 'Send the invoice').length, ticked);
  is('while the tasks nobody ticked still arrive', cards().length - ticked > others, true);
  is('and it is not queued for the morning after either',
    internals.pendingKeys().some((k) => k.startsWith('list-a|today|')), false);
}

// --- boxing one -------------------------------------------------------------

{
  // Box is the card leaving pitwall, not the task leaving Google. Nothing here
  // reaches out, so what proves it is that Google was never written to again.
  const wrote = written.length;
  clock = zonedTime('2026-08-07', ZONE, 9, 10);
  await internals.poll();
  internals.fireDue();
  is('a card boxed rather than ticked writes nothing to Google', written.length, wrote);
  is('and its task is still on the timeline tomorrow',
    internals.pendingKeys().some((k) => k.startsWith('list-c|other|')), true);
}

// --- a link made before Tasks was asked for ----------------------------------

{
  const auth = await import('../src/google-auth.mjs');
  is('consent asks to write to tasks, not just read', auth.SCOPE.includes('/auth/tasks'), true);
  is('and still asks for the calendar', auth.SCOPE.includes('/auth/calendar.readonly'), true);
  is('a grant that covers tasks is recognised', auth.hasScope('https://www.googleapis.com/auth/tasks'), true);

  writeToken({ scope: 'https://www.googleapis.com/auth/calendar.readonly' });
  is('an older grant is not mistaken for one',
    auth.hasScope('https://www.googleapis.com/auth/tasks'), false);
  const todo = await import('../src/todo.mjs');
  is('and the module says so rather than polling into a refusal', todo.status().linked, false);
  writeToken();
}

Date.now = realNow;
await fsp.rm(DATA, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
