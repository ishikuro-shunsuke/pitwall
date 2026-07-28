/**
 * Gmail, on the timeline.
 *
 * Nothing in a mailbox says "this one matters" the way a reminder or a due
 * date does, so the signal is a Gmail search: whatever `PITWALL_MAIL_QUERY`
 * matches becomes a card once, the first time it is seen. Which is also why
 * the first poll after linking stays quiet — an inbox that has been filling up
 * since before pitwall existed is a backlog, not news.
 *
 * Reading only. A card carries no reply box, and Box takes it off the feed
 * without touching the mailbox.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { config, paths } from './config.mjs';
import * as store from './store.mjs';
import { buildEntry } from './normalize.mjs';
import { apiGet, isLinked, hasScope, linkedAccount, NeedsLinkError } from './google-auth.mjs';
import { plainText } from './html-text.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SEEN_TTL_MS = 30 * 86_400_000;

/** Message ids already turned into a card. */
const seen = new Map();

let seenDirty = false;
/** False until one poll has run against this mailbox. See the file comment. */
let primed = false;
let timer = null;
let running = false;
let complained = null;

function loadSeen() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.mailSeen, 'utf8'));
    primed = Boolean(raw.primed);
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [id, at] of Object.entries(raw.seen ?? {})) {
      if (at > cutoff) seen.set(id, at);
    }
  } catch {
    /* first run: nothing seen, and nothing primed */
  }
}

function snapshot() {
  const cutoff = Date.now() - SEEN_TTL_MS;
  const out = {};
  for (const [id, at] of seen) {
    if (at > cutoff) out[id] = at;
    else seen.delete(id);
  }
  return JSON.stringify({ version: 1, primed, seen: out });
}

async function saveSeen() {
  if (!seenDirty) return;
  seenDirty = false;
  try {
    await fsp.writeFile(paths.mailSeen, snapshot(), 'utf8');
  } catch (error) {
    console.error('[pitwall] could not persist mail state:', error.message);
  }
}

function markSeen(id) {
  seen.set(id, Date.now());
  seenDirty = true;
}

function header(message, name) {
  const wanted = name.toLowerCase();
  for (const h of message.payload?.headers || []) {
    if (String(h.name).toLowerCase() === wanted) return h.value || '';
  }
  return '';
}

/** `Ren Tanaka <ren@example.com>` in both directions. */
function address(raw) {
  const value = String(raw || '').trim();
  const angled = value.match(/^(.*)<([^>]+)>\s*$/);
  if (angled) {
    const name = angled[1].trim().replace(/^"(.*)"$/, '$1').trim();
    const email = angled[2].trim();
    return { name: name || email.split('@')[0], email };
  }
  return { name: value.split('@')[0] || value, email: value };
}

function decode(data) {
  return Buffer.from(String(data || ''), 'base64url').toString('utf8');
}

/**
 * The first part of a type that is actually the message. An attachment can
 * carry the same mime type as the body, and `filename` is what tells them
 * apart — a text/plain part with a name on it is a file, not the letter.
 */
function findPart(payload, wanted) {
  if (!payload) return null;
  if (payload.mimeType === wanted && payload.body?.data && !payload.filename) {
    return decode(payload.body.data);
  }
  for (const part of payload.parts || []) {
    const hit = findPart(part, wanted);
    if (hit) return hit;
  }
  return null;
}

/**
 * What is left once the thread underneath is taken off. A reply quotes the
 * whole conversation back, and on a card that is every earlier message shown
 * again below the one that just arrived.
 */
function withoutQuote(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*(On .+ wrote:|-{2,}\s*Original Message\s*-{2,}|_{5,})\s*$/i.test(line)) break;
    if (/^\s*(From|差出人):\s*.+<.+>/.test(line) && out.length) break;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function messageText(message) {
  const plain = findPart(message.payload, 'text/plain');
  const text = plain ?? plainText(findPart(message.payload, 'text/html') || '');
  const trimmed = withoutQuote(text);
  // A message that is nothing but a quote leaves nothing behind; Gmail's own
  // snippet is a better card than an empty one.
  return trimmed || plainText(message.snippet || '');
}

function recipientLine(message, self) {
  const others = `${header(message, 'To')},${header(message, 'Cc')}`
    .split(',')
    .map((raw) => address(raw))
    .filter((a) => a.email && a.email.toLowerCase() !== String(self || '').toLowerCase())
    .map((a) => a.name);
  if (!others.length) return null;
  const shown = others.slice(0, 3).join(', ');
  const rest = others.length - 3;
  return rest > 0 ? `Also to ${shown} and ${rest} more` : `Also to ${shown}`;
}

function bodyFor(message, from, receivedMs, self) {
  const when = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(receivedMs));
  const blocks = [`**${from.name} <${from.email}>** · ${when}`];

  const also = recipientLine(message, self);
  if (also) blocks.push(also);

  const text = messageText(message);
  if (text) blocks.push(text.length > 1200 ? `${text.slice(0, 1200)}…` : text);

  blocks.push(`[Open in Gmail](https://mail.google.com/mail/u/0/#all/${message.threadId || message.id})`);
  return blocks.join('\n\n');
}

async function fetchMatches() {
  const ids = [];
  let pageToken = null;
  do {
    const url = new URL(`${API}/users/me/messages`);
    url.searchParams.set('q', config.mail.query);
    url.searchParams.set('maxResults', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await apiGet(url);
    ids.push(...(data.messages || []).map((m) => m.id));
    pageToken = data.nextPageToken || null;
    // An inbox can run to thousands. Everything past this is older than what
    // is already here, and on a primed mailbox it has been seen already.
  } while (pageToken && ids.length < 500);
  return ids;
}

function fetchMessage(id) {
  const url = new URL(`${API}/users/me/messages/${encodeURIComponent(id)}`);
  url.searchParams.set('format', 'full');
  return apiGet(url);
}

function entryFor(message, self) {
  const from = address(header(message, 'From'));
  const receivedMs = Number(message.internalDate) || Date.now();
  const entry = buildEntry({
    agent: 'mail',
    kind: 'notice',
    payload: {
      title: header(message, 'Subject').trim() || '(no subject)',
      notice: 'mail-arrived',
      // The repo slot names the thing a card belongs to, and gives it its
      // colour. For these that is whoever wrote, so one correspondent keeps
      // one colour down the feed.
      repo: { key: `gmail:${from.email.toLowerCase()}`, name: from.name },
    },
    body: bodyFor(message, from, receivedMs, self),
  });
  entry.mail = {
    messageId: message.id,
    threadId: message.threadId || null,
    from: from.email,
    subject: header(message, 'Subject').trim() || null,
    receivedMs,
  };
  return entry;
}

async function poll() {
  const ids = await fetchMatches();
  const fresh = ids.filter((id) => !seen.has(id));

  if (!primed) {
    // First look at this mailbox. Everything matching now is the backlog.
    for (const id of ids) markSeen(id);
    primed = true;
    seenDirty = true;
    console.log(`[pitwall] mail: ${ids.length} already matching \`${config.mail.query}\` — left where they are`);
    return;
  }

  if (!fresh.length) return;

  // Gmail hands these back newest first. Keep the newest when there are more
  // than the cap, and card them oldest first so a batch arriving at once reads
  // the way it stacked up.
  const dropped = fresh.slice(config.mail.maxPerPoll);
  const take = fresh.slice(0, config.mail.maxPerPoll).reverse();
  if (dropped.length) {
    console.log(`[pitwall] mail: ${dropped.length} older than the newest ${take.length} went uncarded — raise PITWALL_MAIL_MAX_PER_POLL`);
    for (const id of dropped) markSeen(id);
  }

  const self = linkedAccount();
  for (const id of take) {
    let message;
    try {
      message = await fetchMessage(id);
    } catch (error) {
      // Leave it unseen: a message that could not be read this time is still
      // news next time. A grant that has gone stops the whole poll instead.
      if (error instanceof NeedsLinkError) throw error;
      complain(error.message);
      continue;
    }
    markSeen(id);
    store.add(entryFor(message, self));
  }
}

/** Once each, however long Google stays unreachable. */
function complain(message) {
  if (complained === message) return;
  complained = message;
  console.error(`[pitwall] mail: ${message}`);
}

async function cycle() {
  timer = null;
  try {
    if (!isLinked()) {
      complain('no Google account linked — run `npm run link-google`');
    } else if (!hasScope(SCOPE)) {
      complain('the Google link predates Gmail — run `npm run link-google -- --force`');
    } else {
      await poll();
      if (complained) {
        console.log('[pitwall] mail: connected');
        complained = null;
      }
    }
    await saveSeen();
  } catch (error) {
    if (error instanceof NeedsLinkError) complain(`${error.message} — run \`npm run link-google\``);
    else complain(error.message);
  }
  if (!running) return;
  timer = setTimeout(cycle, config.mail.pollSeconds * 1000);
  timer.unref?.();
}

export function start() {
  if (running) return false;
  running = true;
  loadSeen();
  cycle();
  return true;
}

export function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  seenDirty = false;
  try {
    fs.writeFileSync(paths.mailSeen, snapshot(), 'utf8');
  } catch (error) {
    console.error('[pitwall] could not persist mail state:', error.message);
  }
}

export function status() {
  return {
    running,
    linked: isLinked() && hasScope(SCOPE),
    primed,
    query: config.mail.query,
  };
}

/** The pieces the tests drive directly, without the timer wrapped around them. */
export const internals = {
  address,
  header,
  withoutQuote,
  messageText,
  bodyFor,
  poll,
  loadSeen,
  saveSeen,
  seen,
  isPrimed: () => primed,
};
