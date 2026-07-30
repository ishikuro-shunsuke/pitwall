#!/usr/bin/env node
/**
 * Chatwork → timeline entries, against a stubbed Chatwork.
 * Never touches the network, and never reads a real token.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DATA = await fsp.mkdtemp(path.join(os.tmpdir(), 'pitwall-chatwork-'));
process.env.PITWALL_DATA = DATA;
process.env.PITWALL_CHATWORK_TIMEZONE = 'Asia/Tokyo';
process.env.PITWALL_CHATWORK_TASK_DUE_HOUR = '9';

// The token lives where the panel puts it, which is the only place it lives.
const SETTINGS = path.join(DATA, 'settings.json');
fs.writeFileSync(SETTINGS, JSON.stringify({ version: 1, chatwork: { token: 'test-token' } }));

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

/**
 * A task fires at nine in the morning where the account lives, which is not
 * whatever o'clock this suite happens to run at. So the clock is moved instead.
 */
const TODAY = '2026-07-28';
const TOMORROW = nextDate(TODAY, ZONE);
let clock = zonedTime(TODAY, ZONE, 9, 10);
const realNow = Date.now;
Date.now = () => clock;

const at = (dateStr, hour, minute = 0) => Math.floor(zonedTime(dateStr, ZONE, hour, minute) / 1000);

// --- the account on the other end --------------------------------------------

const ME = 100;
const REN = { account_id: 200, name: 'Ren Tanaka' };
const KAI = { account_id: 300, name: 'Kai' };
const BOARD = { account_id: 400, name: 'Office' };

let messages = {
  10: [
    {
      message_id: '5001',
      account: REN,
      body: '[To:100] You\nThe parser is off by one at the sector boundary.\n[qt][qtmeta aid=100 time=1753600000]the old numbers looked fine[/qt]',
      send_time: at(TODAY, 8, 30),
    },
    { message_id: '5002', account: REN, body: 'and the rig is booked all afternoon', send_time: at(TODAY, 8, 31) },
    { message_id: '5003', account: { account_id: ME, name: 'You' }, body: '[To:200] Ren\nlooking now', send_time: at(TODAY, 8, 32) },
    { message_id: '5004', account: KAI, body: '[rp aid=100 to=10-5001] You\nsame here', send_time: at(TODAY, 8, 33) },
  ],
  11: [
    { message_id: '6001', account: REN, body: 'Are you free at three?', send_time: at(TODAY, 8, 40) },
    { message_id: '6002', account: { account_id: ME, name: 'You' }, body: 'probably', send_time: at(TODAY, 8, 41) },
  ],
  12: [
    { message_id: '7001', account: BOARD, body: '[toall]\nThe office is shut on Friday', send_time: at(TODAY, 8, 50) },
  ],
  13: [
    { message_id: '8001', account: KAI, body: 'nothing to do with you', send_time: at(TODAY, 8, 55) },
  ],
};

const lastOf = (roomId) => Math.max(0, ...(messages[roomId] || []).map((m) => m.send_time));

const rooms = () => [
  { room_id: 10, name: 'Race strategy', type: 'group', unread_num: 3, mention_num: 1, last_update_time: lastOf(10) },
  { room_id: 11, name: 'Ren Tanaka', type: 'direct', unread_num: 2, mention_num: 0, last_update_time: lastOf(11) },
  { room_id: 12, name: 'Announcements', type: 'group', unread_num: 5, mention_num: 1, last_update_time: lastOf(12) },
  { room_id: 13, name: 'Aero', type: 'group', unread_num: 4, mention_num: 0, last_update_time: lastOf(13) },
  { room_id: 14, name: 'My notes', type: 'my', unread_num: 0, mention_num: 0, last_update_time: 0 },
];

const DUE_TODAY = at(TODAY, 23, 59) + 59;
let tasks = [
  {
    task_id: 900,
    room: { room_id: 10, name: 'Race strategy' },
    assigned_by_account: REN,
    message_id: '5001',
    body: '[To:100] You\nCheck the tyre degradation numbers\nboth stints',
    limit_time: DUE_TODAY,
    limit_type: 'date',
    status: 'open',
  },
  {
    task_id: 901,
    room: { room_id: 11, name: 'Ren Tanaka' },
    assigned_by_account: REN,
    message_id: '6001',
    body: 'Sign the fuel form',
    limit_time: at('2026-07-25', 23, 59) + 59,
    limit_type: 'date',
    status: 'open',
  },
  {
    task_id: 902,
    room: { room_id: 10, name: 'Race strategy' },
    assigned_by_account: KAI,
    message_id: '5004',
    body: 'Someday, maybe',
    limit_time: 0,
    limit_type: 'none',
    status: 'open',
  },
  {
    task_id: 903,
    room: { room_id: 10, name: 'Race strategy' },
    assigned_by_account: KAI,
    message_id: '5002',
    body: 'Briefing deck',
    limit_time: at(TOMORROW, 15, 0),
    limit_type: 'time',
    status: 'open',
  },
];

// --- the stub ----------------------------------------------------------------

const opened = [];
const posted = [];
const marked = [];
const ticked = [];
let tokensSeen = new Set();
let alreadyRead = false;
let broken = null;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const reply = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const form = () => Object.fromEntries(new URLSearchParams(init.body || ''));

  if (url.origin !== 'https://api.chatwork.com') {
    return new Response(JSON.stringify({ errors: [`unstubbed ${url.href}`] }), { status: 500 });
  }
  const token = new Headers(init.headers).get('X-ChatWorkToken');
  tokensSeen.add(token);
  if (token === 'nope') {
    return new Response(JSON.stringify({ errors: ['Invalid API token'] }), { status: 401 });
  }
  const route = url.pathname.replace(/^\/v2/, '');

  if (route === '/me') return reply({ account_id: ME, name: 'You' });
  if (route === '/rooms') return reply(rooms());
  if (route === '/my/tasks') return reply(tasks.filter((t) => t.status === url.searchParams.get('status')));

  let m = route.match(/^\/rooms\/(\d+)\/messages$/);
  if (m && (init.method || 'GET') === 'GET') {
    const id = Number(m[1]);
    opened.push({ id, force: url.searchParams.get('force') });
    if (id === broken) return new Response(JSON.stringify({ errors: ['no'] }), { status: 403 });
    const list = messages[id] || [];
    // Chatwork answers an empty room with a body-less 204, not an empty list.
    return list.length ? reply(list) : new Response(null, { status: 204 });
  }
  if (m && init.method === 'POST') {
    posted.push({ roomId: m[1], ...form() });
    return reply({ message_id: '9999' });
  }

  m = route.match(/^\/rooms\/(\d+)\/messages\/read$/);
  if (m && init.method === 'PUT') {
    const asked = form();
    marked.push({ roomId: m[1], ...asked });
    // A message taken back stops being somewhere to read up to.
    if (!(messages[Number(m[1])] || []).some((x) => x.message_id === asked.message_id)) {
      return new Response(JSON.stringify({ errors: ['The message is not found.'] }), { status: 404 });
    }
    // Nothing left to mark is a refusal, which is Chatwork's way of saying it
    // was already done.
    if (alreadyRead) {
      return new Response(JSON.stringify({ errors: ['No update'] }), { status: 400 });
    }
    return reply({ unread_num: 0, mention_num: 0 });
  }

  m = route.match(/^\/rooms\/(\d+)\/tasks\/(\d+)\/status$/);
  if (m && init.method === 'PUT') {
    const body = form();
    ticked.push({ roomId: m[1], taskId: m[2], ...body });
    // A done task stops being open, and the stub stops handing it back, or
    // nothing here proves the tick reached Chatwork.
    tasks = tasks.map((t) => (String(t.task_id) === m[2] ? { ...t, status: body.body } : t));
    return reply({ task_id: Number(m[2]) });
  }

  return new Response(JSON.stringify({ errors: [`unstubbed ${route}`] }), { status: 500 });
};

const chatwork = await import('../src/chatwork.mjs');
const chatworkTask = await import('../src/chatwork-task.mjs');
const { chatworkText, withoutOpeningAddress } = await import('../src/chatwork-text.mjs');
const store = await import('../src/store.mjs');
store.init();

const cards = () => store.list().filter((e) => e.agent === 'chatwork' && e.chatwork);
const taskCards = () => store.list().filter((e) => e.agent === 'chatwork' && e.chatworkTask);

// --- the markup comes off ----------------------------------------------------

is('a mention tag goes and the name stays',
  chatworkText('[To:100] You\nready?'), 'You\nready?');
is('a reply tag goes the same way',
  chatworkText('[rp aid=100 to=10-5001] You\nsame here'), 'You\nsame here');
is('a quoted message does not come along',
  chatworkText('answering\n[qt][qtmeta aid=1 time=2]the question[/qt]'), 'answering');
is('code keeps its shape',
  chatworkText('look:\n[code]a = 1[/code]'), 'look:\n\n```\na = 1\n```');
is('an info box keeps its heading',
  chatworkText('[info][title]Stand-up[/title]09:30 as usual[/info]'), '**Stand-up**\n09:30 as usual');
is('a file says its name', chatworkText('[download:77]setup.csv[/download]'), 'file: setup.csv');
is('everyone is everyone', chatworkText('[toall]\nshut on Friday'), '@all\nshut on Friday');

is('the line that only says your name comes off the front',
  withoutOpeningAddress('[To:100] You\nready?'), 'ready?');
is('so does a reply header',
  withoutOpeningAddress('[rp aid=100 to=10-1] Ren Tanaka\nsame here'), 'same here');
is('a message written on the same line as the address stays whole',
  withoutOpeningAddress('[To:100] Ren, can you look at the sector times?'),
  '[To:100] Ren, can you look at the sector times?');
is('and a message that is nothing but an address keeps it',
  withoutOpeningAddress('[To:100] You'), '[To:100] You');

is('a mention names you', chatwork.internals.addressesMe('[To:100] You\nhi', 100), true);
is('somebody else is not you', chatwork.internals.addressesMe('[To:200] Ren\nhi', 100), false);
is('a reply names you too', chatwork.internals.addressesMe('[rp aid=100 to=10-1] You', 100), true);
is('and one number is not another',
  chatwork.internals.addressesMe('[To:1000] Someone', 100), false);

// --- the first poll is a backlog ---------------------------------------------

await chatwork.internals.poll();
is('nothing waiting before pitwall existed reaches the feed', cards().length, 0);
is('but it is all recorded as spoken for', chatwork.internals.isPrimed(), true);
is('the token went with every call', [...tokensSeen].join(), 'test-token');
is('a room with a mention was opened', opened.some((o) => o.id === 10), true);
is('so was the one-to-one', opened.some((o) => o.id === 11), true);
is('a group with unread but nothing for you stayed shut', opened.some((o) => o.id === 13), false);
is('and the whole room was asked for, not the part Chatwork thinks is new',
  opened.every((o) => o.force === '1'), true);

// --- a room that has not moved is not opened again ---------------------------

opened.length = 0;
await chatwork.internals.poll();
is('a poll that finds nothing new opens nothing', opened.length, 0);

// --- what arrives afterwards -------------------------------------------------

clock += 60_000;
messages[10] = [...messages[10], {
  message_id: '5005',
  account: REN,
  body: '[To:100] You\nCan you take the debrief at four?',
  send_time: at(TODAY, 9, 11),
}];
messages[11] = [...messages[11], {
  message_id: '6003',
  account: REN,
  body: 'still on for three?',
  send_time: at(TODAY, 9, 11),
}];
messages[12] = [...messages[12], {
  message_id: '7002',
  account: BOARD,
  body: '[toall]\nand the Monday after',
  send_time: at(TODAY, 9, 11),
}];
await chatwork.internals.poll();

is('a mention and a one-to-one both land', cards().length, 2);

const mention = cards().find((c) => c.chatwork.messageId === '5005');
if (!mention) fail('the mention is on the timeline', 'no card');
else {
  is('it is a notice', mention.status, 'notice');
  is('it takes the room\'s name', mention.repo.name, 'Race strategy');
  is('and the service\'s colour', mention.repo.key, 'chatwork');
  is('it carries no editor link', mention.links.openWorkspace, null);
  is('the body names who wrote', mention.body.includes('**Ren Tanaka**'), true);
  is('and says what they said', mention.body.includes('Can you take the debrief at four?'), true);
  is('the mention tag is not in it', mention.body.includes('[To:'), false);
  is('nor the line that only said your name', mention.body.includes('You'), false);
  is('the message is reachable in Chatwork',
    mention.chatwork.webUrl, 'https://www.chatwork.com/#!rid10-5005');
  is('and the body does not repeat the link', mention.body.includes('chatwork.com'), false);
}

is('a one-to-one needs no mention',
  cards().some((c) => c.chatwork.messageId === '6003'), true);
is('and it hangs on the name of whoever it is with',
  cards().find((c) => c.chatwork.messageId === '6003')?.repo.name, 'Ren Tanaka');
is('everyone at once is nobody in particular',
  cards().some((c) => c.chatwork.roomId === '12'), false);
is('what you said yourself is never a card',
  cards().some((c) => c.chatwork.messageId === '5003'), false);

// --- a room that stops answering ---------------------------------------------

{
  broken = 10;
  clock += 60_000;
  messages[10] = [...messages[10], {
    message_id: '5006', account: REN, body: '[To:100] You\nand the tyres?', send_time: at(TODAY, 9, 12),
  }];
  messages[11] = [...messages[11], {
    message_id: '6004', account: REN, body: 'four then', send_time: at(TODAY, 9, 12),
  }];
  await chatwork.internals.poll();
  is('a room that refuses does not silence the others',
    cards().some((c) => c.chatwork.messageId === '6004'), true);
  is('and what it was holding is not lost',
    cards().some((c) => c.chatwork.messageId === '5006'), false);
  broken = null;
  await chatwork.internals.poll();
  is('the next poll opens it again and the message lands',
    cards().some((c) => c.chatwork.messageId === '5006'), true);
}

// --- more at once than a poll will card --------------------------------------

{
  const { config } = await import('../src/config.mjs');
  config.chatwork.maxPerPoll = 2;
  clock += 60_000;
  messages[10] = [...messages[10],
    { message_id: '5101', account: KAI, body: '[To:100] You\none', send_time: at(TODAY, 9, 20) },
    { message_id: '5102', account: KAI, body: '[To:100] You\ntwo', send_time: at(TODAY, 9, 21) },
    { message_id: '5103', account: KAI, body: '[To:100] You\nthree', send_time: at(TODAY, 9, 22) },
  ];
  const before = cards().length;
  await chatwork.internals.poll();
  is('a burst is capped at what the poll may add', cards().length - before, 2);
  is('and it is the newest that are kept',
    cards().some((c) => c.chatwork.messageId === '5103'), true);
  is('the oldest of them does not arrive a poll later',
    cards().some((c) => c.chatwork.messageId === '5101'), false);
  config.chatwork.maxPerPoll = 20;
}

// --- answering ---------------------------------------------------------------

{
  const card = cards().find((c) => c.chatwork.messageId === '5005');
  await chatwork.replyAndRead(card.chatwork, 'Four works.');
  is('the answer goes into the room it came from', posted.at(-1)?.roomId, '10');
  is('under the message it answers',
    posted.at(-1)?.body.startsWith('[rp aid=200 to=10-5005] Ren Tanaka\n'), true);
  is('and carries what was typed', posted.at(-1)?.body.endsWith('Four works.'), true);
  is('then the room is read up to it', marked.at(-1)?.message_id, '5005');
  is('in that room', marked.at(-1)?.roomId, '10');
}

{
  // Chatwork refuses when there is nothing left to mark, which is the state the
  // card was asking for in the first place.
  alreadyRead = true;
  const card = cards().find((c) => c.chatwork.messageId === '6003');
  let threw = null;
  try {
    await chatwork.markRead(card.chatwork);
  } catch (error) {
    threw = error.message;
  }
  is('a message already read is not a failure', threw, null);
  alreadyRead = false;
}

// --- a message taken back ----------------------------------------------------

{
  clock += 60_000;
  messages[11] = [...messages[11],
    { message_id: '6200', account: REN, body: '[deleted]', send_time: at(TODAY, 9, 30) },
    { message_id: '6201', account: REN, body: 'this one stands', send_time: at(TODAY, 9, 31) },
  ];
  await chatwork.internals.poll();
  is('a message somebody took back is never a card',
    cards().some((c) => c.chatwork.messageId === '6200'), false);
  is('while the one beside it still is',
    cards().some((c) => c.chatwork.messageId === '6201'), true);

  // Taken back after its card was made. The card is a moment that happened, so
  // it stays — but Box has to be able to take it off, and Chatwork has nothing
  // left to be read up to.
  const card = cards().find((c) => c.chatwork.messageId === '6201');
  messages[11] = messages[11].filter((x) => x.message_id !== '6201');
  let threw = null;
  try {
    await chatwork.markRead(card.chatwork);
  } catch (error) {
    threw = error.message;
  }
  is('a card pointing at a message that has gone can still be boxed', threw, null);
}

// --- a restart ---------------------------------------------------------------

{
  await chatwork.internals.saveSeen();
  chatwork.internals.seen.clear();
  chatwork.internals.opened.clear();
  chatwork.internals.loadSeen();
  const settled = cards().length;
  await chatwork.internals.poll();
  is('what was already carded survives a restart', cards().length, settled);
}

// --- naming the rooms --------------------------------------------------------

{
  const { config } = await import('../src/config.mjs');
  config.chatwork.roomIds = ['11'];
  chatwork.internals.opened.clear();
  opened.length = 0;
  await chatwork.internals.poll();
  is('naming a room leaves the rest unopened', opened.map((o) => o.id).join(), '11');
  config.chatwork.roomIds = [];
}

// --- tasks -------------------------------------------------------------------

is('the zone is the one that was named, not this machine\'s',
  chatworkTask.internals.zone(), ZONE);
is('a deadline set as a date is the day it names',
  chatworkTask.internals.dueDate({ limit_time: DUE_TODAY }, ZONE), TODAY);
is('a task nobody put a deadline on has no day',
  chatworkTask.internals.dueDate({ limit_time: 0 }, ZONE), null);
is('and read in the wrong zone an early deadline slips a day',
  chatworkTask.internals.dueDate({ limit_time: at(TOMORROW, 8, 0) }, 'UTC'), TODAY);
is('lateness is counted in whole days',
  chatworkTask.internals.daysBetween('2026-07-25', TODAY, ZONE), 3);
is('on the day itself the card says so',
  chatworkTask.internals.overdueLine({ limit_type: 'date' }, TODAY, TODAY, ZONE), '**Due today**');
is('a deadline with a clock on it says the clock too',
  chatworkTask.internals.overdueLine({ limit_type: 'time', limit_time: at(TODAY, 15, 0) }, TODAY, TODAY, ZONE),
  '**Due today** · 15:00');
is('later than that it counts the days',
  chatworkTask.internals.overdueLine({ limit_type: 'date' }, '2026-07-25', TODAY, ZONE),
  '**Overdue by 3 days** · was due Sat 25 Jul');

await chatworkTask.internals.poll();
chatworkTask.internals.fireDue();

is('a card each for what is due today and what is already late', taskCards().length, 2);

{
  const card = taskCards().find((c) => c.chatworkTask.taskId === '900');
  if (!card) fail('the task due today is on the timeline', 'no card');
  else {
    is('the first line of it is the title', card.title, 'Check the tyre degradation numbers');
    is('and the tag in front of it is gone', card.title.includes('[To:'), false);
    is('it hangs on the room the task was set in', card.repo.name, 'Race strategy');
    is('the body leads with the day', card.body.includes('**Due today**'), true);
    is('and says who is waiting', card.body.includes('Set by Ren Tanaka'), true);
    is('the rest of the task comes through', card.body.includes('both stints'), true);
    is('it knows it is not late yet', card.chatworkTask.overdueDays, 0);
    is('and the message it was set on is one click away',
      card.chatworkTask.webUrl, 'https://www.chatwork.com/#!rid10-5001');
  }
}
is('an overdue task says how far past it is',
  taskCards().find((c) => c.chatworkTask.taskId === '901')?.chatworkTask.overdueDays, 3);
is('a task with no deadline is never news',
  taskCards().some((c) => c.chatworkTask.taskId === '902'), false);
is('tomorrow\'s task is held, not fired',
  chatworkTask.internals.pendingKeys().includes(`903|${TOMORROW}`), true);

await chatworkTask.internals.poll();
chatworkTask.internals.fireDue();
is('a second poll does not repeat a card', taskCards().length, 2);

// --- the morning after -------------------------------------------------------

clock = zonedTime(TOMORROW, ZONE, 9, 10);
await chatworkTask.internals.poll();
chatworkTask.internals.fireDue();
is('what is still undone says so again the next morning', taskCards().length, 5);
is('including the one that only came due today',
  taskCards().some((c) => c.chatworkTask.taskId === '903'), true);
is('and the late one has aged a day',
  Math.max(...taskCards().filter((c) => c.chatworkTask.taskId === '901')
    .map((c) => c.chatworkTask.overdueDays)), 4);

// --- ticking one off ---------------------------------------------------------

{
  const card = taskCards().find((c) => c.chatworkTask.taskId === '900');
  await chatworkTask.complete(card.chatworkTask);
  is('the tick reaches Chatwork', ticked.length, 1);
  is('and says the task is done', ticked[0]?.body, 'done');
  is('against the task the card came off',
    `${ticked[0]?.roomId}|${ticked[0]?.taskId}`, '10|900');
  is('the mornings already queued for it are dropped',
    chatworkTask.internals.pendingKeys().some((k) => k.startsWith('900|')), false);

  const done = taskCards().filter((c) => c.chatworkTask.taskId === '900').length;
  clock = zonedTime(nextDate(TOMORROW, ZONE), ZONE, 9, 10);
  await chatworkTask.internals.poll();
  chatworkTask.internals.fireDue();
  is('and it does not come round the next morning',
    taskCards().filter((c) => c.chatworkTask.taskId === '900').length, done);
  is('while the ones nobody ticked still arrive',
    taskCards().some((c) => c.chatworkTask.taskId === '901' && c.chatworkTask.day !== TOMORROW), true);
}

// --- a morning missed while the server was off -------------------------------

{
  clock = zonedTime('2026-08-02', ZONE, 22, 0);
  const before = taskCards().length;
  await chatworkTask.internals.poll();
  chatworkTask.internals.fireDue();
  is('a morning missed with the server down still arrives', taskCards().length > before, true);
}

// --- a restart, for tasks too ------------------------------------------------

{
  await chatworkTask.internals.saveSeen();
  chatworkTask.internals.seen.clear();
  chatworkTask.internals.loadSeen();
  const settled = taskCards().length;
  await chatworkTask.internals.poll();
  chatworkTask.internals.fireDue();
  is('what was already said survives a restart', taskCards().length, settled);
}

// --- the token the panel writes ----------------------------------------------

{
  const api = await import('../src/chatwork-api.mjs');
  const settings = await import('../src/settings.mjs');

  const who = await api.verify('test-token');
  is('a token Chatwork takes says whose it is', who.name, 'You');
  let refused = null;
  try {
    await api.verify('nope');
  } catch (error) {
    refused = error.name;
  }
  is('and one it will not take says so at once', refused, 'NeedsTokenError');

  await settings.saveChatworkToken('from-the-panel');
  is('a token typed into the panel is the one that is used',
    settings.chatworkToken(), 'from-the-panel');
  is('the file is readable by nobody else',
    fs.statSync(SETTINGS).mode & 0o777, 0o600);

  await settings.saveChatworkToken('');
  is('an empty box takes it off again', settings.chatworkToken(), '');
  is('with no token the module says so rather than polling into a refusal',
    chatwork.status().linked, false);
  is('and so does the task side', chatworkTask.status().linked, false);
  let threw = null;
  try {
    await chatwork.internals.poll();
  } catch (error) {
    threw = error.name;
  }
  is('a poll made anyway stops at the token', threw, 'NeedsTokenError');
}

Date.now = realNow;
// The store writes on a timer, and a write that lands mid-delete leaves the
// directory behind it.
store.shutdown();
await fsp.rm(DATA, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
