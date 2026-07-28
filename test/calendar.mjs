#!/usr/bin/env node
/**
 * Google Calendar → timeline entries, against a stubbed Google.
 * Never touches the network, and never reads a real token.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DATA = await fsp.mkdtemp(path.join(os.tmpdir(), 'pitwall-cal-'));
process.env.PITWALL_DATA = DATA;
process.env.PITWALL_GOOGLE_CLIENT_ID = 'test-client';
process.env.PITWALL_GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.PITWALL_CALENDAR_STALE_MINUTES = '20';
fs.writeFileSync(
  path.join(DATA, 'google-token.json'),
  JSON.stringify({ refresh_token: 'test-refresh', account: 'me@example.com' }),
);

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

const MIN = 60_000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const CALENDARS = [
  {
    id: 'work@example.com',
    summary: 'Work',
    // Deliberately not the primary zone: cards are read in one clock.
    timeZone: 'America/New_York',
    selected: true,
    accessRole: 'owner',
    defaultReminders: [{ method: 'popup', minutes: 10 }],
  },
  {
    id: 'muted@example.com',
    summary: 'Muted',
    timeZone: 'Asia/Tokyo',
    selected: false,
    defaultReminders: [{ method: 'popup', minutes: 10 }],
  },
  {
    id: 'me@example.com',
    summary: 'me@example.com',
    primary: true,
    timeZone: 'Asia/Tokyo',
    selected: true,
    defaultReminders: [{ method: 'popup', minutes: 7 * 24 * 60 }],
  },
];

let events = [
  {
    id: 'due',
    status: 'confirmed',
    summary: 'Sprint review',
    location: 'Room A',
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    htmlLink: 'https://calendar.google.com/event?eid=due',
    description: '<p>Bring the <b>deck</b></p>',
    start: { dateTime: iso(now + 10 * MIN) },
    end: { dateTime: iso(now + 70 * MIN) },
    reminders: { useDefault: true },
    attendees: [
      { email: 'me@example.com', self: true, responseStatus: 'accepted' },
      { email: 'ren@example.com', displayName: 'Ren', responseStatus: 'accepted' },
      { email: 'kai@example.com', responseStatus: 'needsAction' },
    ],
  },
  {
    id: 'later',
    status: 'confirmed',
    summary: 'Retro',
    start: { dateTime: iso(now + 120 * MIN) },
    end: { dateTime: iso(now + 180 * MIN) },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
  },
  {
    id: 'silenced',
    status: 'confirmed',
    summary: 'Focus block',
    start: { dateTime: iso(now + 5 * MIN) },
    end: { dateTime: iso(now + 65 * MIN) },
    reminders: { useDefault: false, overrides: [] },
  },
  {
    id: 'declined',
    status: 'confirmed',
    summary: 'Optional sync',
    start: { dateTime: iso(now + 10 * MIN) },
    end: { dateTime: iso(now + 40 * MIN) },
    reminders: { useDefault: true },
    attendees: [{ email: 'me@example.com', self: true, responseStatus: 'declined' }],
  },
  {
    id: 'stale',
    status: 'confirmed',
    summary: 'Long-notice offsite',
    start: { dateTime: iso(now + 30 * MIN) },
    end: { dateTime: iso(now + 90 * MIN) },
    // An hour's notice on something half an hour out: the moment to say so
    // passed thirty minutes ago.
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
  },
  {
    id: 'desk',
    status: 'confirmed',
    eventType: 'workingLocation',
    summary: 'Office',
    start: { dateTime: iso(now + 10 * MIN) },
    end: { dateTime: iso(now + 20 * MIN) },
    reminders: { useDefault: true },
  },
];

let tokenCalls = 0;
let broken = null;
const read = [];

let grants = [];
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.toString());
  const reply = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  // The consent callback is a loopback request this test makes itself.
  if (url.hostname === '127.0.0.1') return realFetch(input, init);

  if (url.href === 'https://oauth2.googleapis.com/token') {
    const form = new URLSearchParams(init.body);
    grants.push(Object.fromEntries(form));
    if (form.get('grant_type') === 'authorization_code') {
      return reply({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 });
    }
    tokenCalls += 1;
    if (form.get('grant_type') !== 'refresh_token') return new Response('{}', { status: 400 });
    return reply({ access_token: 'test-access', expires_in: 3600 });
  }
  if (url.pathname.endsWith('/calendars/primary')) {
    return reply({ id: 'me@example.com' });
  }
  if (url.pathname.endsWith('/users/me/calendarList')) {
    return reply({ items: CALENDARS });
  }
  const listing = url.pathname.match(/\/calendars\/([^/]+)\/events$/);
  if (listing) {
    const id = decodeURIComponent(listing[1]);
    read.push({ id, timeMax: Date.parse(url.searchParams.get('timeMax')) });
    if (id === broken) return new Response('{"error":"gone"}', { status: 404 });
    return reply({ items: id === 'work@example.com' ? events : [] });
  }
  return new Response(JSON.stringify({ error: `unstubbed ${url.href}` }), { status: 500 });
};

const { internals } = await import('../src/calendar.mjs');
const store = await import('../src/store.mjs');
store.init();

const cards = () => store.list().filter((e) => e.agent === 'calendar');

// --- pure pieces -----------------------------------------------------------

is(
  'midnight in Tokyo is 15:00 UTC the day before',
  new Date(internals.zonedMidnight('2026-07-28', 'Asia/Tokyo')).toISOString(),
  '2026-07-27T15:00:00.000Z',
);
is(
  'midnight in New York follows daylight saving',
  new Date(internals.zonedMidnight('2026-07-28', 'America/New_York')).toISOString(),
  '2026-07-28T04:00:00.000Z',
);
is(
  'midnight in New York in winter follows it back',
  new Date(internals.zonedMidnight('2026-01-28', 'America/New_York')).toISOString(),
  '2026-01-28T05:00:00.000Z',
);

{
  const start = Date.parse('2026-07-28T06:00:00Z'); // 15:00 in Tokyo
  const line = internals.whenLine(start, start + 60 * MIN, false, 'Asia/Tokyo');
  is('a timed event reads as one range', line, 'Tue 28 Jul 15:00–16:00');
}
{
  const start = internals.zonedMidnight('2026-07-28', 'Asia/Tokyo');
  const line = internals.whenLine(start, start + 86_400_000, true, 'Asia/Tokyo');
  is('a one-day all-day event names the day once', line, 'Tue 28 Jul · all day');
}
{
  const start = internals.zonedMidnight('2026-07-28', 'Asia/Tokyo');
  const line = internals.whenLine(start, start + 3 * 86_400_000, true, 'Asia/Tokyo');
  is('a run of all-day dates ends on the last one', line, 'Tue 28 Jul – Thu 30 Jul · all day');
}

is('an empty override list means silence', internals.reminderMinutes(
  { reminders: { useDefault: false, overrides: [] } },
  { defaultReminders: [{ method: 'popup', minutes: 10 }] },
).length, 0);
is('popup and email at the same minute are one card', internals.reminderMinutes(
  { reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }, { method: 'email', minutes: 10 }] } },
  { defaultReminders: [] },
).length, 1);
is('useDefault takes the calendar\'s minutes', internals.reminderMinutes(
  { reminders: { useDefault: true } },
  { defaultReminders: [{ method: 'popup', minutes: 30 }] },
)[0], 30);

is('description html comes out as text', internals.plainText('<p>Bring the <b>deck</b></p>'), 'Bring the deck');

// --- one poll --------------------------------------------------------------

await internals.poll();
internals.fireDue();

is('one card, for the one reminder that was due', cards().length, 1);

const card = cards()[0];
if (card) {
  is('it is a notice', card.status, 'notice');
  is('it says which event', card.title, 'Sprint review');
  is('it takes the calendar\'s name', card.repo.name, 'Work');
  is('it is coloured by the service, not by a repo', card.repo.key, 'gcal');
  is('it carries no editor link', card.links.openWorkspace, null);
  is('the card knows when the event starts', card.calendar.startMs, now + 10 * MIN);
  is('and how much notice it was asked for', card.calendar.leadMinutes, 10);
  const has = (needle) => card.body.includes(needle);
  const tokyoClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(now + 10 * MIN));
  is('a card off a New York calendar still reads in the primary zone', has(`${tokyoClock}–`), true);
  is('the body leads with time and place', has('· Room A'), true);
  is('the call is one click', has('[Join the call](https://meet.google.com/abc-defg-hij)'), true);
  is('the people are named', has('With Ren, kai'), true);
  is('the description is unwrapped', has('Bring the deck'), true);
  is('the event is reachable in Google', card.calendar.htmlLink, 'https://calendar.google.com/event?eid=due');
  is('and the body does not repeat the link', has('calendar.google.com'), false);
}

is('the reminder still ahead is held, not fired', internals.pendingKeys().some((k) => k.includes('|later|')), true);
is('an event that switched its reminders off stays quiet', internals.pendingKeys().some((k) => k.includes('|silenced|')), false);
is('a declined invitation stays quiet', internals.pendingKeys().some((k) => k.includes('|declined|')), false);
is('a working-location marker stays quiet', internals.pendingKeys().some((k) => k.includes('|desk|')), false);
is('a reminder whose moment has passed is swallowed', [...internals.seen.keys()].some((k) => k.includes('|stale|')), true);

// --- polling again ---------------------------------------------------------

await internals.poll();
internals.fireDue();
is('a second poll does not repeat the card', cards().length, 1);
is('and the token was fetched once', tokenCalls, 1);
is('a calendar unticked in Google is never read', read.some((r) => r.id === 'muted@example.com'), false);
is(
  'a week of notice loads a week of events, or the moment passes unseen',
  read.every((r) => r.timeMax >= now + 7 * 24 * 60 * MIN),
  true,
);

// --- the event moves -------------------------------------------------------

events = events.map((e) => (e.id === 'later'
  ? { ...e, start: { dateTime: iso(now + 10 * MIN) }, end: { dateTime: iso(now + 40 * MIN) } }
  : e));
await internals.poll();
internals.fireDue();
is('an event moved into range announces itself at its new time', cards().length, 2);

// --- one calendar goes bad -------------------------------------------------

{
  broken = 'me@example.com';
  events = [...events, {
    id: 'after',
    status: 'confirmed',
    summary: 'Standup',
    start: { dateTime: iso(now + 3 * MIN) },
    end: { dateTime: iso(now + 18 * MIN) },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 3 }] },
  }];
  await internals.poll();
  internals.fireDue();
  is('a calendar that stops answering does not silence the others', cards().length, 3);
  broken = null;
}

// --- restart ---------------------------------------------------------------

await internals.saveSeen();
internals.seen.clear();
internals.loadSeen();
await internals.poll();
internals.fireDue();
is('what was already said survives a restart', cards().length, 3);

// --- linking ---------------------------------------------------------------

{
  const auth = await import('../src/google-auth.mjs');
  is('a saved refresh token counts as linked', auth.isLinked(), true);

  grants = [];
  let seenUrl = null;
  const result = await auth.authorize({
    onUrl: async (raw) => {
      seenUrl = new URL(raw);
      // Somebody else's redirect must not be able to plant a token here.
      const wrong = new URL(seenUrl.searchParams.get('redirect_uri'));
      wrong.search = new URLSearchParams({ code: 'stolen', state: 'not-the-state' }).toString();
      const rejected = await fetch(wrong);
      is('a callback with the wrong state is turned away', rejected.status, 400);

      const back = new URL(seenUrl.searchParams.get('redirect_uri'));
      back.search = new URLSearchParams({
        code: 'test-code',
        state: seenUrl.searchParams.get('state'),
      }).toString();
      await fetch(back);
    },
  });

  is('consent asks for what the pollers read, read only', seenUrl.searchParams.get('scope'), auth.SCOPE);
  is('and asks offline, or the link lasts an hour', seenUrl.searchParams.get('access_type'), 'offline');
  is('the code is bound with PKCE', seenUrl.searchParams.get('code_challenge_method'), 'S256');
  is('the callback is loopback', new URL(seenUrl.searchParams.get('redirect_uri')).hostname, '127.0.0.1');
  is('the exchange sends the verifier back', Boolean(grants[0]?.code_verifier), true);
  is('and it names the account it linked', result.account, 'me@example.com');

  const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'google-token.json'), 'utf8'));
  is('the refresh token is what got written', saved.refresh_token, 'fresh-refresh');
  is('the access token is not', saved.access_token, undefined);
  is('the token file is readable by nobody else', fs.statSync(path.join(DATA, 'google-token.json')).mode & 0o077, 0);
}

await fsp.rm(DATA, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
