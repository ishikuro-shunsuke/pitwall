#!/usr/bin/env node
/**
 * Gmail → timeline entries, against a stubbed Google.
 * Never touches the network, and never reads a real token.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DATA = await fsp.mkdtemp(path.join(os.tmpdir(), 'pitwall-mail-'));
process.env.PITWALL_DATA = DATA;
process.env.PITWALL_GOOGLE_CLIENT_ID = 'test-client';
process.env.PITWALL_GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.PITWALL_MAIL_MAX_PER_POLL = '2';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');
const TOKEN = path.join(DATA, 'google-token.json');
const writeToken = (extra) => fs.writeFileSync(TOKEN, JSON.stringify({
  refresh_token: 'test-refresh',
  account: 'me@example.com',
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

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

const message = ({ id, from, subject, to = 'me@example.com', cc, text, html, parts, snippet, when }) => {
  const headers = [
    { name: 'From', value: from },
    { name: 'Subject', value: subject },
    { name: 'To', value: to },
  ];
  if (cc) headers.push({ name: 'Cc', value: cc });
  let payload;
  if (parts) payload = { mimeType: 'multipart/mixed', headers, parts };
  else if (html) payload = { mimeType: 'text/html', headers, body: { data: b64(html) } };
  else payload = { mimeType: 'text/plain', headers, body: { data: b64(text || '') } };
  return { id, threadId: `t-${id}`, snippet: snippet || '', internalDate: String(when ?? Date.parse('2026-07-28T09:00:00Z')), payload };
};

// Newest first, the way Gmail hands them back.
let mailbox = [
  message({
    id: 'm5',
    from: 'Ren Tanaka <ren@example.com>',
    subject: 'Sector times',
    cc: 'kai@example.com, me@example.com',
    text: 'The parser is off by one at the sector boundary.\n\nOn Mon 27 Jul, Kai wrote:\n> the old numbers looked fine\n> so it must be new',
  }),
  message({ id: 'm4', from: 'noreply@example.com', subject: 'Your receipt', text: 'Thanks.' }),
  message({ id: 'm3', from: '"Kai" <kai@example.com>', subject: 'Re: brakes', text: 'Ack.' }),
  message({ id: 'm2', from: 'Ren Tanaka <ren@example.com>', subject: 'Old one', text: 'Older.' }),
  message({ id: 'm1', from: 'ren@example.com', subject: 'Oldest', text: 'Oldest.' }),
];

let tokenCalls = 0;
const queries = [];
const fetched = [];

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
  if (url.pathname.endsWith('/users/me/messages')) {
    queries.push(url.searchParams.get('q'));
    return reply({ messages: mailbox.map((m) => ({ id: m.id, threadId: m.threadId })) });
  }
  const one = url.pathname.match(/\/users\/me\/messages\/([^/]+)$/);
  if (one) {
    const id = decodeURIComponent(one[1]);
    fetched.push(id);
    const found = mailbox.find((m) => m.id === id);
    return found ? reply(found) : new Response('{"error":"gone"}', { status: 404 });
  }
  return new Response(JSON.stringify({ error: `unstubbed ${url.href}` }), { status: 500 });
};

const { internals } = await import('../src/mail.mjs');
const store = await import('../src/store.mjs');
store.init();

const cards = () => store.list().filter((e) => e.agent === 'mail');
const byTitle = (t) => cards().find((c) => c.title === t);

// --- pure pieces -------------------------------------------------------------

{
  const a = internals.address('Ren Tanaka <ren@example.com>');
  is('a name and an address come apart', `${a.name}|${a.email}`, 'Ren Tanaka|ren@example.com');
  const quoted = internals.address('"Tanaka, Ren" <ren@example.com>');
  is('a quoted name loses its quotes', quoted.name, 'Tanaka, Ren');
  const bare = internals.address('ren@example.com');
  is('a bare address still gets a name to show', `${bare.name}|${bare.email}`, 'ren|ren@example.com');
}

is('a quoted reply is cut off at the quote',
  internals.withoutQuote('Yes, that works.\n\nOn Mon 27 Jul, Kai wrote:\n> the old numbers'), 'Yes, that works.');
is('so is one quoted with angle brackets alone',
  internals.withoutQuote('Ack.\n> earlier'), 'Ack.');
is('a message that is only a quote comes back empty',
  internals.withoutQuote('> nothing of my own'), '');

is('html mail is unwrapped',
  internals.messageText(message({ id: 'x', from: 'a@b.c', subject: 's', html: '<p>Hello <b>there</b></p>' })),
  'Hello there');
is('an attachment is not mistaken for the body',
  internals.messageText(message({
    id: 'y',
    from: 'a@b.c',
    subject: 's',
    parts: [
      { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64('THE ATTACHMENT') } },
      { mimeType: 'text/plain', body: { data: b64('the letter') } },
    ],
  })),
  'the letter');
is('a message with nothing but a quote falls back to the snippet',
  internals.messageText(message({ id: 'z', from: 'a@b.c', subject: 's', text: '> all quote', snippet: 'all quote' })),
  'all quote');

// --- the first poll ----------------------------------------------------------

await internals.poll();

is('the query is the one from config', queries[0], 'in:inbox is:unread');
is('a mailbox seen for the first time is not carded', cards().length, 0);
is('nor is anything in it even read', fetched.length, 0);
is('but all of it is remembered', internals.seen.size, 5);
is('and the mailbox counts as primed', internals.isPrimed(), true);

// --- mail arrives ------------------------------------------------------------

mailbox = [
  message({
    id: 'm6',
    from: 'Ren Tanaka <ren@example.com>',
    subject: 'Pit window',
    cc: 'kai@example.com',
    text: 'Lap 32 at the earliest.',
    when: Date.parse('2026-07-28T10:00:00Z'),
  }),
  ...mailbox,
];
await internals.poll();

is('a message that was not there before is a card', cards().length, 1);
{
  const card = byTitle('Pit window');
  if (!card) fail('the new mail is on the timeline', 'no card');
  else {
    is('it is a notice', card.status, 'notice');
    is('every message shares one colour', card.repo.key, 'gmail');
    is('while the head still names who wrote', card.repo.name, 'Ren Tanaka');
    is('it carries no editor link', card.links.openWorkspace, null);
    is('the card knows the thread', card.mail.threadId, 't-m6');
    const has = (needle) => card.body.includes(needle);
    is('the body leads with the sender', has('**Ren Tanaka <ren@example.com>**'), true);
    is('the others on it are named', has('Also to kai'), true);
    is('and you are not named among them', has('me@example.com'), false);
    is('the message is there', has('Lap 32 at the earliest.'), true);
    is('and the thread is reachable in Gmail', has('(https://mail.google.com/mail/u/0/#all/t-m6)'), true);
  }
}

// --- polling again -----------------------------------------------------------

await internals.poll();
is('a second poll does not repeat the card', cards().length, 1);
is('and the token was fetched once', tokenCalls, 1);

// --- more than the cap allows ------------------------------------------------

mailbox = [
  message({ id: 'n3', from: 'c@example.com', subject: 'Newest', text: 'c', when: 3000 }),
  message({ id: 'n2', from: 'b@example.com', subject: 'Middle', text: 'b', when: 2000 }),
  message({ id: 'n1', from: 'a@example.com', subject: 'Oldest of the three', text: 'a', when: 1000 }),
  ...mailbox,
];
await internals.poll();

is('the cap holds', cards().length, 3);
is('and it keeps the newest', Boolean(byTitle('Newest') && byTitle('Middle')), true);
is('rather than the oldest', Boolean(byTitle('Oldest of the three')), false);
is('what it dropped is not read again next poll', internals.seen.has('n1'), true);
{
  // The store keeps what it was given in the order it was given it, so adding
  // the older one first is what puts it below the newer one on the feed.
  const order = cards().map((c) => c.title);
  is('a batch is added oldest first', order.indexOf('Middle') < order.indexOf('Newest'), true);
}

// --- restart -----------------------------------------------------------------

await internals.saveSeen();
internals.seen.clear();
internals.loadSeen();
const settled = cards().length;
await internals.poll();
is('what was already said survives a restart', cards().length, settled);
is('and a restart does not re-prime the mailbox', internals.isPrimed(), true);

// --- a link made before Gmail was asked for ----------------------------------

{
  const auth = await import('../src/google-auth.mjs');
  is('consent asks for gmail, read only', auth.SCOPE.includes('/auth/gmail.readonly'), true);
  is('and never asks to send', auth.SCOPE.includes('/auth/gmail.send'), false);
  is('a grant that covers gmail is recognised',
    auth.hasScope('https://www.googleapis.com/auth/gmail.readonly'), true);

  writeToken({ scope: 'https://www.googleapis.com/auth/calendar.readonly' });
  const mail = await import('../src/mail.mjs');
  is('an older grant leaves the mailbox unlinked', mail.status().linked, false);
  writeToken();
}

await fsp.rm(DATA, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
