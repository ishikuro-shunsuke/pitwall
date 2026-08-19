#!/usr/bin/env node
/**
 * Google Calendar → one card a morning, against a stubbed Google.
 * Never touches the network, and never reads a real token.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DATA = await fsp.mkdtemp(path.join(os.tmpdir(), 'pitwall-agenda-'));
process.env.PITWALL_DATA = DATA;
// The OAuth pair lives in the file the panel writes, and nowhere else.
fs.writeFileSync(
  path.join(DATA, 'google-client.json'),
  JSON.stringify({ installed: { client_id: 'test-client', client_secret: 'test-secret' } }),
);
process.env.PITWALL_AGENDA_HOUR = '7';

const ZONE = 'Asia/Tokyo';
fs.writeFileSync(path.join(DATA, 'google-token.json'), JSON.stringify({
  refresh_token: 'test-refresh',
  account: 'me@example.com',
  // A zone well away from wherever this test is running, so a card that used
  // the server's own clock instead of the account's is a failure and not a
  // coincidence.
  timeZone: ZONE,
  scope: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks',
}));

/** Due dates land as a UTC midnight, which is all the API ever records. */
const TASKS = [
  { id: 't1', title: '経費精算', status: 'needsAction', due: '2026-07-25T00:00:00.000Z' },
  { id: 't2', title: 'Send the invoice', status: 'needsAction', due: '2026-07-28T00:00:00.000Z' },
  { id: 't3', title: 'Tomorrow can wait', status: 'needsAction', due: '2026-07-29T00:00:00.000Z' },
  { id: 't4', title: 'Already ticked', status: 'completed', due: '2026-07-28T00:00:00.000Z' },
  { id: 't5', title: 'Someday, maybe', status: 'needsAction' },
];

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

const { zonedTime, nextDate } = await import('../src/zoned.mjs');

// --- the clock the whole test hangs off --------------------------------------

/**
 * A card that lands at 07:00 cannot be tested at whatever o'clock the suite
 * happens to run, so the clock is moved instead: a Tokyo morning, before the
 * hour, with the day's events already in Google.
 */
const TODAY = '2026-07-28';
const TOMORROW = nextDate(TODAY, ZONE);
let clock = zonedTime(TODAY, ZONE, 6, 30);
const realNow = Date.now;
Date.now = () => clock;

const CALENDARS = [
  { id: 'work', summary: 'Work', timeZone: ZONE, primary: true, defaultReminders: [] },
  { id: 'personal', summary: 'Personal', timeZone: ZONE, defaultReminders: [] },
  { id: 'team', summary: 'Team', timeZone: ZONE, defaultReminders: [] },
];

const at = (dateStr, hour, minute = 0) => new Date(zonedTime(dateStr, ZONE, hour, minute)).toISOString();
const timed = (dateStr, fromH, toH, extra = {}) => ({
  start: { dateTime: at(dateStr, fromH) },
  end: { dateTime: at(dateStr, toH) },
  ...extra,
});

let events = {
  work: [
    { id: 'yesterday', summary: 'Yesterday, and over', ...timed('2026-07-27', 10, 11) },
    {
      id: 'overnight',
      summary: 'The build that runs all night',
      start: { dateTime: at('2026-07-27', 22) },
      end: { dateTime: at(TODAY, 2) },
    },
    { id: 'standup', summary: 'Standup', ...timed(TODAY, 9, 10) },
    {
      id: 'review',
      iCalUID: 'review@google.com',
      summary: 'Design review',
      location: 'Meeting room 2, on the third floor of the annexe, by the lifts',
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      ...timed(TODAY, 14, 15),
    },
    {
      id: 'offsite',
      summary: 'Company offsite',
      start: { date: TODAY },
      end: { date: TOMORROW },
    },
    {
      id: 'late',
      summary: 'Call with the other coast',
      start: { dateTime: at(TODAY, 23) },
      end: { dateTime: at(TOMORROW, 1) },
    },
    { id: 'cancelled', summary: 'Called off', status: 'cancelled', ...timed(TODAY, 12, 13) },
    {
      id: 'declined',
      summary: 'Said no to this one',
      attendees: [{ self: true, responseStatus: 'declined' }],
      ...timed(TODAY, 16, 17),
    },
    { id: 'where', summary: 'In the office', eventType: 'workingLocation', ...timed(TODAY, 9, 18) },
  ],
  personal: [
    { id: 'dentist', summary: 'Dentist', ...timed(TODAY, 11, 12) },
    // The same meeting, off a second calendar you are also on.
    { id: 'review-copy', iCalUID: 'review@google.com', summary: 'Design review', ...timed(TODAY, 14, 15) },
  ],
  team: [],
};

let tokenCalls = 0;
let broken = null;
const read = [];

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
  if (url.pathname.endsWith('/users/me/calendarList')) return reply({ items: CALENDARS });

  // Google Tasks, so the card can say what is owed as well as what is booked.
  if (url.pathname.endsWith('/users/@me/lists')) {
    return reply({ items: [{ id: 'list-a', title: 'My Tasks' }] });
  }
  if (/\/lists\/[^/]+\/tasks$/.test(url.pathname)) {
    return reply({ items: TASKS });
  }

  const listing = url.pathname.match(/\/calendars\/([^/]+)\/events$/);
  if (listing) {
    const id = decodeURIComponent(listing[1]);
    const from = Date.parse(url.searchParams.get('timeMin'));
    const to = Date.parse(url.searchParams.get('timeMax'));
    read.push({ id, from, to });
    if (id === broken) return new Response('{"error":"gone"}', { status: 404 });
    // The stub honours the window the way Google does, so nothing the code
    // failed to ask for can arrive anyway and pass the test by accident.
    const edge = (e) => (e.dateTime ? Date.parse(e.dateTime) : zonedTime(e.date, ZONE));
    const within = (events[id] || []).filter((e) => edge(e.end) > from && edge(e.start) < to);
    return reply({ items: within });
  }
  return new Response(JSON.stringify({ error: `unstubbed ${url.href}` }), { status: 500 });
};

const { internals } = await import('../src/agenda.mjs');
const store = await import('../src/store.mjs');
store.init();

const cards = () => store.list().filter((e) => e.agenda);
const latest = () => cards().sort((a, b) => a.createdAtMs - b.createdAtMs).at(-1);
const lines = (card) => card.body.split('\n').filter((l) => l.startsWith('**') && l.includes(' — '));

// --- pure pieces -------------------------------------------------------------

is('the zone comes off the link, not off this machine', internals.zone(), ZONE);

{
  const dayStart = zonedTime(TODAY, ZONE, 0);
  const dayEnd = zonedTime(TOMORROW, ZONE, 0);
  const s = (item) => internals.span(item, dayStart, dayEnd, ZONE);
  is('an hour inside the day reads as an hour',
    s({ startMs: zonedTime(TODAY, ZONE, 9), endMs: zonedTime(TODAY, ZONE, 10) }), '09:00–10:00');
  is('an all-day event says so', s({ allDay: true }), 'All day');
  is('something that started yesterday is clipped to when it ends',
    s({ startMs: zonedTime('2026-07-27', ZONE, 22), endMs: zonedTime(TODAY, ZONE, 2) }), 'until 02:00');
  is('and something running into tomorrow to when it starts',
    s({ startMs: zonedTime(TODAY, ZONE, 23), endMs: zonedTime(TOMORROW, ZONE, 1) }), 'from 23:00');
  is('one that covers the whole day is an all-day event in all but name',
    s({ startMs: zonedTime('2026-07-27', ZONE, 22), endMs: zonedTime(TOMORROW, ZONE, 3) }), 'All day');
}

is('an empty day is named on the card, not left blank', internals.titleFor([]), 'Nothing on today');
is('one event is an event', internals.titleFor([{}]), '1 event today');
is('more than one is counted', internals.titleFor([{}, {}, {}]), '3 events today');

// --- before the hour ---------------------------------------------------------

await internals.cycle();
is('nothing arrives before the hour', cards().length, 0);
is('and today is what is queued', internals.nextDue(ZONE, clock).day, TODAY);
is('for 07:00 where the account lives',
  internals.nextDue(ZONE, clock).atMs, zonedTime(TODAY, ZONE, 7));

// --- the hour ----------------------------------------------------------------

clock = zonedTime(TODAY, ZONE, 7, 0);
await internals.cycle();
is('the card lands on the hour', cards().length, 1);

{
  const card = latest();
  is('it is a notice', card.status, 'notice');
  is('it wears the calendar badge', card.agent, 'calendar');
  is('it is coloured by the service, not by a repo', card.repo.key, 'gcal');
  is('and the slot says what the card is', card.repo.name, 'Today');
  is('it knows which day it is about', card.agenda.day, TODAY);
  is('the day view is one click', card.agenda.htmlLink,
    'https://calendar.google.com/calendar/r/day/2026/7/28');
  is('the head counts the day', card.title, '6 events, 2 tasks today');
  is('the body opens with the day itself', card.body.split('\n')[0], '**Tuesday 28 July**');

  const listed = lines(card);
  is('every event is on it, once', listed.length, 6);
  is('the all-day one frames the rest', listed[0], '**All day** — Company offsite');
  is('then the day runs in order', listed.map((l) => l.split(' — ')[1].split(' · ')[0]).join(' | '),
    'Company offsite | The build that runs all night | Standup | Dentist | Design review | Call with the other coast');
  is('a meeting brings its room with it', listed[4].includes('Meeting room 2, on the third floor of the annexe, by the lif…'), true);
  is('and its call link', listed[4].includes('[Join the call](https://meet.google.com/abc-defg-hij)'), true);
  is('a meeting you are on twice is on the card once',
    listed.filter((l) => l.includes('Design review')).length, 1);
  is('nothing was cancelled onto it', card.body.includes('Called off'), false);
  is('nor anything you declined', card.body.includes('Said no to this one'), false);
  is('nor where you are working from', card.body.includes('In the office'), false);
  is('and yesterday stays yesterday', card.body.includes('Yesterday, and over'), false);
  is('nothing is missing off it', card.agenda.missing.length, 0);
}

is('the day asked for is the day where the account lives',
  read.filter((r) => r.id !== 'primary')
    .every((r) => r.from === zonedTime(TODAY, ZONE, 0) && r.to === zonedTime(TOMORROW, ZONE, 0)), true);
is('every calendar is read when none were named',
  new Set(read.map((r) => r.id).filter((id) => id !== 'primary')).size, 3);
// Tasks are only ever put on the calendar you own, and the read is for their
// hours alone — nothing off it reaches the card as an event.
is('and the one you own is read again, for the hours on the tasks',
  read.some((r) => r.id === 'primary'), true);
is('and the token was fetched once', tokenCalls, 1);

// --- the rest of the day -----------------------------------------------------

clock = zonedTime(TODAY, ZONE, 12, 0);
await internals.cycle();
is('the card is not repeated later the same day', cards().length, 1);
is('tomorrow is what is queued now', internals.nextDue(ZONE, clock).day, TOMORROW);

// --- tomorrow ----------------------------------------------------------------

events = {
  ...events,
  // Moved overnight. A card built from yesterday's read would still say 09:00.
  work: events.work.map((e) => (e.id === 'standup' ? { ...e, ...timed(TOMORROW, 10, 11) } : e)),
  personal: [{ id: 'nothing', summary: 'Not today', ...timed('2026-08-01', 9, 10) }],
  team: [],
};
clock = zonedTime(TOMORROW, ZONE, 7, 0);
await internals.cycle();
is('the next morning brings its own card', cards().length, 2);
{
  const card = latest();
  is('a meeting still running at midnight is on both days', lines(card)[0], '**until 01:00** — Call with the other coast');
  is('and the day is read at the hour, not the night before',
    lines(card).includes('**10:00–11:00** — Standup'), true);
  is('and it is about tomorrow', card.agenda.day, TOMORROW);
}

// --- what is owed, under what is booked --------------------------------------

{
  clock = zonedTime(TODAY, ZONE, 7, 0);
  const card = cards().find((c) => c.agenda?.day === TODAY);
  const body = card.body;
  const owed = body.split('**Still to do**\n')[1]?.split('\n\n')[0]?.split('\n') ?? [];

  is('the tasks owed today are on the card', owed.length, 2);
  is('and the count is on the entry', card.agenda.taskCount, 2);
  is('the one that has waited longest is first', owed[0], '経費精算 — 3 days late');
  is('and one owed today needs no note', owed[1], 'Send the invoice');
  is('a task owed tomorrow is not owed today', body.includes('Tomorrow can wait'), false);
  is('a task already ticked off stays off', body.includes('Already ticked'), false);
  is('and one nobody dated is owed on no morning', body.includes('Someday, maybe'), false);
  is('the diary still comes first', body.indexOf('Still to do') > body.indexOf('Company offsite'), true);
}

{
  // Two services on one list, and only the one that is not Google says so.
  is('a Chatwork task names where it is kept',
    internals.taskLine({ title: 'Review the deck', lateDays: 0, where: 'Chatwork' }),
    'Review the deck — Chatwork');
  is('a day late is a day, not days',
    internals.taskLine({ title: 'x', lateDays: 1, where: null }), 'x — 1 day late');
  is('and both notes sit on one line',
    internals.taskLine({ title: 'x', lateDays: 2, where: 'Chatwork' }), 'x — 2 days late · Chatwork');
}

// --- a day with nothing on it ------------------------------------------------

{
  const empty = nextDate(TOMORROW, ZONE);
  clock = zonedTime(empty, ZONE, 7, 0);
  await internals.cycle();
  const card = latest();
  is('a day with nothing booked still gets its card', card.agenda.day, empty);
  // The tasks outlive every day they were owed on, so the diary empties long
  // before the card does.
  is('an empty diary says it is the diary that is empty',
    card.body.includes('Nothing in the diary.'), true);
  is('and the head counts what is left', card.title, '3 tasks today');
  is('while nothing on at all would say so', internals.titleFor([], []), 'Nothing on today');
}

// --- one calendar goes bad ---------------------------------------------------

{
  const day = nextDate(nextDate(TOMORROW, ZONE), ZONE);
  events = { ...events, work: [{ id: 'one', summary: 'Still readable', ...timed(day, 9, 10) }] };
  broken = 'personal';
  clock = zonedTime(day, ZONE, 7, 0);
  await internals.cycle();
  const card = latest();
  is('a calendar that stops answering does not silence the others',
    card.body.includes('Still readable'), true);
  is('and the card says where the hole is', card.body.includes('Could not read Personal.'), true);
  is('by name', card.agenda.missing.join(), 'Personal');
  broken = null;
}

// --- an hour missed while the server was off ---------------------------------

{
  const day = '2026-08-03';
  events = { ...events, work: [{ id: 'afternoon', summary: 'Still ahead of you', ...timed(day, 15, 16) }] };
  clock = zonedTime(day, ZONE, 11, 0);
  await internals.cycle();
  is('an hour missed with the server down still arrives', latest().agenda.day, day);
}

{
  // A day that has turned has nothing left to be early for, and the card for it
  // is never delivered late.
  clock = zonedTime('2026-08-06', ZONE, 7, 0);
  await internals.cycle();
  is('and the days it slept through are not caught up on', latest().agenda.day, '2026-08-06');
  is('one card a day, however many were missed', cards().filter((c) => c.agenda.day === '2026-08-05').length, 0);
}

// --- restart -----------------------------------------------------------------

await internals.saveSeen();
internals.seen.clear();
internals.loadSeen();
{
  const settled = cards().length;
  await internals.cycle();
  is('what was already said survives a restart', cards().length, settled);
}

// --- naming the calendars ----------------------------------------------------

{
  const { config } = await import('../src/config.mjs');
  is('07:00 is the hour unless you move it', config.agenda.hour, 7);
  config.calendar.ids = ['personal'];
  read.length = 0;
  clock = zonedTime('2026-08-07', ZONE, 7, 0);
  await internals.cycle();
  is('naming a calendar leaves the rest unread',
    read.map((r) => r.id).filter((id) => id !== 'primary').join(), 'personal');
  config.calendar.ids = [];
}

// --- an unlinked account -----------------------------------------------------

{
  fs.rmSync(path.join(DATA, 'google-token.json'), { force: true });
  const auth = await import('../src/google-auth.mjs');
  auth.reset();
  const agenda = await import('../src/agenda.mjs');
  is('with no account linked there is nothing to say', agenda.status().linked, false);
  const before = cards().length;
  clock = zonedTime('2026-08-08', ZONE, 7, 0);
  await internals.cycle();
  is('and no card is invented', cards().length, before);
}

Date.now = realNow;
// The store writes on a timer, and a write that lands mid-delete leaves the
// directory behind it.
store.shutdown();
await fsp.rm(DATA, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
