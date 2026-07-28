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
// The OAuth pair lives in the file the panel writes, and nowhere else.
fs.writeFileSync(
  path.join(DATA, 'google-client.json'),
  JSON.stringify({ installed: { client_id: 'test-client', client_secret: 'test-secret' } }),
);
process.env.PITWALL_MAIL_MAX_PER_POLL = '2';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/gmail.modify',
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
    { name: 'Message-ID', value: `<${id}@example.com>` },
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
const sent = [];
const modified = [];

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
  if (url.pathname.endsWith('/users/me/messages/send') && init.method === 'POST') {
    const body = JSON.parse(init.body);
    sent.push({ ...body, mime: Buffer.from(body.raw, 'base64url').toString('utf8') });
    return reply({ id: 'sent-1', threadId: body.threadId });
  }
  const mod = url.pathname.match(/\/users\/me\/messages\/([^/]+)\/modify$/);
  if (mod && init.method === 'POST') {
    const id = decodeURIComponent(mod[1]);
    modified.push({ id, ...JSON.parse(init.body) });
    // Gmail stops matching `in:inbox` once the label is off, and so does the
    // stub, or nothing here proves the archive reached it.
    mailbox = mailbox.filter((m) => m.id !== id);
    return reply({ id });
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
    is('the thread is reachable in Gmail', card.mail.webUrl, 'https://mail.google.com/mail/u/0/#all/t-m6');
    is('and the body no longer repeats the link', has('mail.google.com'), false);
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

// --- writing a reply ---------------------------------------------------------

is('a subject already answered is not answered twice',
  internals.replySubject('Re: brakes'), 'Re: brakes');
is('and one that was not, is', internals.replySubject('brakes'), 'Re: brakes');
is('an ascii header is left alone', internals.encodeWord('Re: brakes'), 'Re: brakes');
{
  const subject = 'セクタータイムの件について、確認したいことがいくつかあります';
  const enc = internals.encodeWord(subject);
  const back = enc.split(/\r\n /)
    .map((w) => Buffer.from(w.replace(/^=\?UTF-8\?B\?|\?=$/g, ''), 'base64').toString('utf8'))
    .join('');
  is('a header in Japanese survives the encoding', back, subject);
  is('and no encoded word runs past the 75 RFC 2047 allows',
    enc.split(/\r\n /).every((w) => w.length <= 75), true);
}

{
  const mail = await import('../src/mail.mjs');
  const card = byTitle('Pit window');

  await mail.replyAndArchive(card.mail, '了解です。\nラップ32で。');

  is('the reply is sent once', sent.length, 1);
  const mime = sent[0]?.mime || '';
  const has = (needle) => mime.includes(needle);
  is('it goes to whoever wrote', has('To: ren@example.com'), true);
  is('it is sent as the linked account', has('From: me@example.com'), true);
  is('it answers the subject, unencoded where it can be', has('Subject: Re: Pit window'), true);
  is('it lands under the message it answers', has('In-Reply-To: <m6@example.com>'), true);
  is('and stays in the same thread', sent[0]?.threadId, 't-m6');
  is('the body is utf-8', has('charset="UTF-8"'), true);
  {
    const body = mime.split('\r\n\r\n')[1] || '';
    is('and says what was typed',
      Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), '了解です。\nラップ32で。');
  }

  is('answering also takes it out of the inbox', modified.length, 1);
  is('by dropping the one label', JSON.stringify(modified[0]?.removeLabelIds), '["INBOX"]');
  is('and nothing is deleted', modified[0]?.addLabelIds, undefined);
}

// --- archiving without a reply -----------------------------------------------

{
  const mail = await import('../src/mail.mjs');
  mailbox = [
    message({ id: 'm7', from: 'Kai <kai@example.com>', subject: 'Brakes', text: 'Ready.', when: 9000 }),
    ...mailbox,
  ];
  await internals.poll();
  const card = byTitle('Brakes');
  if (!card) fail('the mail to archive is on the timeline', 'no card');

  const wrote = sent.length;
  await mail.archive(card.mail);
  is('archiving writes no mail', sent.length, wrote);
  is('but does take it out of the inbox', modified.at(-1)?.id, 'm7');

  const before = cards().length;
  await internals.poll();
  is('and an archived message does not come round again', cards().length, before);
}

// --- an API nobody switched on ----------------------------------------------

{
  const auth = await import('../src/google-auth.mjs');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.href === 'https://oauth2.googleapis.com/token') return realFetch(input, init);
    return new Response(JSON.stringify({
      error: {
        code: 403,
        message: 'Gmail API has not been used in project 916877411210 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=916877411210 then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.',
        status: 'PERMISSION_DENIED',
        details: [{
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'SERVICE_DISABLED',
          domain: 'googleapis.com',
          metadata: {
            service: 'gmail.googleapis.com',
            consumer: 'projects/916877411210',
            activationUrl: 'https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=916877411210',
          },
        }],
      },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  };

  let said = null;
  try {
    await auth.apiGet('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  } catch (error) {
    said = error.message;
  }
  is('an API left switched off says which one',
    said, 'gmail.googleapis.com is not enabled on your Google Cloud project — turn it on at https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=916877411210');
  is('and not a page of json cut off mid-sentence', said.includes('{'), false);

  globalThis.fetch = realFetch;
}

// --- a link made before Gmail was asked for ----------------------------------

{
  const auth = await import('../src/google-auth.mjs');
  is('consent asks to read and move mail', auth.SCOPE.includes('/auth/gmail.modify'), true);
  is('and never asks for the one that can delete outright', auth.SCOPE.includes('https://mail.google.com/'), false);
  is('a grant that covers gmail is recognised',
    auth.hasScope('https://www.googleapis.com/auth/gmail.modify'), true);

  writeToken({ scope: 'https://www.googleapis.com/auth/calendar.readonly' });
  const mail = await import('../src/mail.mjs');
  is('an older grant leaves the mailbox unlinked', mail.status().linked, false);
  writeToken();
}

// The store writes on a timer, and a write that lands mid-delete leaves the
// directory behind it.
store.shutdown();
await fsp.rm(DATA, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
