/**
 * Chatwork messages, on the timeline.
 *
 * A chat has no inbox and no search across it, so what is worth a card has to
 * be found room by room — which is why the poll starts at `/rooms`, the one
 * call that says how many mentions and how much unread every chat is holding,
 * and then only opens the ones that answer. A room that has not moved since the
 * last look is not opened at all.
 *
 * Messages are always asked for in full rather than as "what is new since you
 * last asked", because the API's own cursor is a thing this could move by
 * accident. What has already been carded is remembered here instead, so nothing
 * pitwall reads changes what Chatwork shows you as unread. Only the buttons on
 * a card do that.
 *
 * Addressed to you is the whole test: a `[To:]` mention, a reply to something
 * you wrote, or anything at all in a one-to-one chat. `[toall]` names everyone,
 * which is nobody in particular, and does not make a card.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { config, paths } from './config.mjs';
import * as store from './store.mjs';
import { buildEntry } from './normalize.mjs';
import * as api from './chatwork-api.mjs';
import { NeedsTokenError, hasToken } from './chatwork-api.mjs';
import { chatworkText, withoutOpeningAddress } from './chatwork-text.mjs';

const SEEN_TTL_MS = 30 * 86_400_000;

/**
 * A quiet ceiling on how much of a busy account one poll will open. Rooms are
 * taken newest-first, so what falls off the end is what has been sitting there
 * longest — and the log says it fell off.
 */
const MAX_ROOMS_PER_POLL = 20;

/** `room|message` for everything already turned into a card. */
const seen = new Map();

/** room id → the `last_update_time` its messages were last read at. */
const opened = new Map();

let seenDirty = false;
/** False until one poll has run against this account. See `poll`. */
let primed = false;
let timer = null;
let running = false;
let nextPollAt = 0;
let complained = null;

function loadSeen() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.chatworkSeen, 'utf8'));
    primed = Boolean(raw.primed);
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [key, at] of Object.entries(raw.seen ?? {})) {
      if (at > cutoff) seen.set(key, at);
    }
  } catch {
    /* first run: nothing seen, and nothing primed */
  }
}

function snapshot() {
  const cutoff = Date.now() - SEEN_TTL_MS;
  const out = {};
  for (const [key, at] of seen) {
    if (at > cutoff) out[key] = at;
    else seen.delete(key);
  }
  return JSON.stringify({ version: 1, primed, seen: out });
}

async function saveSeen() {
  if (!seenDirty) return;
  seenDirty = false;
  try {
    await fsp.writeFile(paths.chatworkSeen, snapshot(), 'utf8');
  } catch (error) {
    console.error('[pitwall] could not persist chatwork state:', error.message);
  }
}

function markSeen(key) {
  seen.set(key, Date.now());
  seenDirty = true;
}

const keyOf = (roomId, messageId) => `${roomId}|${messageId}`;

/** Where the message lives, in the web client. */
export function messageUrl(roomId, messageId) {
  return `https://www.chatwork.com/#!rid${roomId}-${messageId}`;
}

/**
 * Whether a message says your name. Chatwork writes both of these itself — the
 * picker puts `[To:]` in, and the reply button puts `[rp aid=]` in — so nothing
 * here depends on how anyone types.
 */
function addressesMe(body, accountId) {
  const text = String(body || '');
  const id = String(accountId);
  return new RegExp(`\\[To:${id}\\]`).test(text)
    || new RegExp(`\\[rp\\s+aid=${id}[\\s\\]]`).test(text);
}

/** A chat where every message is addressed to you by being sent at all. */
const isDirect = (room) => room.type === 'direct';

/**
 * Taking a message back does not remove it: Chatwork leaves it in the room with
 * its body replaced by this. In a one-to-one chat, where being sent at all is
 * what makes a card, that would otherwise arrive as a card saying nothing.
 */
const DELETED = '[deleted]';

const isDeleted = (body) => String(body || '').trim() === DELETED;

function bodyFor(message, sendMs) {
  const when = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(sendMs));
  const blocks = [`**${message.account?.name || 'someone'}** · ${when}`];

  const text = chatworkText(withoutOpeningAddress(message.body));
  if (text) blocks.push(text.length > 1200 ? `${text.slice(0, 1200)}…` : text);

  // The way to the room is a button on the card, not a line under the message.
  return blocks.join('\n\n');
}

function entryFor(room, message) {
  const sendMs = (Number(message.send_time) || 0) * 1000 || Date.now();
  const messageId = String(message.message_id);
  const entry = buildEntry({
    agent: 'chatwork',
    kind: 'notice',
    payload: {
      notice: 'chat-message',
      // The repo slot names the thing a card belongs to, and gives it its
      // colour. Every Chatwork card shares one colour, and the slot's name is
      // left to say which room it was said in — which in a one-to-one chat is
      // the name of the person who said it.
      repo: { key: 'chatwork', name: room.name || `room ${room.room_id}` },
    },
    body: bodyFor(message, sendMs),
  });
  entry.chatwork = {
    roomId: String(room.room_id),
    roomName: room.name || null,
    messageId,
    // Who to answer, and what to answer under.
    accountId: String(message.account?.account_id ?? ''),
    accountName: message.account?.name || null,
    webUrl: messageUrl(room.room_id, messageId),
    sendMs,
  };
  return entry;
}

async function fetchRooms() {
  const rooms = (await api.get('/rooms')) || [];
  const wanted = config.chatwork.roomIds;
  if (!wanted.length) return rooms;
  return rooms.filter((room) => wanted.includes(String(room.room_id)));
}

/**
 * The whole of a room's recent messages, up to the hundred the API will give.
 * `force` is what says "all of them" rather than "the ones I have not collected
 * yet"; the second sort moves a cursor on Chatwork's side, and this does not.
 */
async function fetchMessages(room) {
  return (await api.get(`/rooms/${encodeURIComponent(room.room_id)}/messages`, { force: 1 })) || [];
}

/** Once each, however long Chatwork stays unreachable. */
function complain(message) {
  if (complained === message) return;
  complained = message;
  console.error(`[pitwall] chatwork: ${message}`);
}

async function poll() {
  const self = await api.me();
  const rooms = await fetchRooms();

  // Anything with an unanswered mention in it, or an unread word in a chat that
  // is only the two of you. Everything else stays shut, which is what keeps a
  // poll down to a call or two however many chats the account is in.
  let loud = rooms.filter((room) => {
    const moved = (Number(room.last_update_time) || 0) > (opened.get(String(room.room_id)) || 0);
    if (!moved) return false;
    return Number(room.mention_num) > 0 || (isDirect(room) && Number(room.unread_num) > 0);
  });
  loud.sort((a, b) => (Number(b.last_update_time) || 0) - (Number(a.last_update_time) || 0));
  if (loud.length > MAX_ROOMS_PER_POLL) {
    console.log(`[pitwall] chatwork: ${loud.length - MAX_ROOMS_PER_POLL} of ${loud.length} rooms went unopened this poll — the quietest of them wait for the next`);
    loud = loud.slice(0, MAX_ROOMS_PER_POLL);
  }

  const fresh = [];
  for (const room of loud) {
    let messages;
    try {
      messages = await fetchMessages(room);
    } catch (error) {
      // One room you can no longer read must not take the others down with it,
      // and it is left unopened so the next poll tries again.
      if (error instanceof NeedsTokenError) throw error;
      complain(`${room.name || room.room_id}: ${error.message}`);
      continue;
    }
    opened.set(String(room.room_id), Number(room.last_update_time) || 0);

    for (const message of messages) {
      if (String(message.account?.account_id ?? '') === self.accountId) continue;
      if (isDeleted(message.body)) continue;
      if (!isDirect(room) && !addressesMe(message.body, self.accountId)) continue;
      const key = keyOf(room.room_id, message.message_id);
      if (seen.has(key)) continue;
      fresh.push({ room, message, key, sendTime: Number(message.send_time) || 0 });
    }
  }

  if (!primed) {
    // First look at this account. Everything unanswered now is a backlog rather
    // than news, the same way a mailbox that filled up before pitwall existed is.
    for (const item of fresh) markSeen(item.key);
    primed = true;
    seenDirty = true;
    console.log(`[pitwall] chatwork: ${fresh.length} already waiting on you — left where they are`);
    return;
  }

  if (!fresh.length) return;

  // Oldest first, so a batch arriving at once reads the way it stacked up. Past
  // the cap it is the newest that are kept, and the rest are recorded as spoken
  // for rather than left to arrive one poll later.
  fresh.sort((a, b) => a.sendTime - b.sendTime);
  const dropped = fresh.slice(0, Math.max(0, fresh.length - config.chatwork.maxPerPoll));
  const take = fresh.slice(dropped.length);
  if (dropped.length) {
    console.log(`[pitwall] chatwork: ${dropped.length} older than the newest ${take.length} went uncarded — raise PITWALL_CHATWORK_MAX_PER_POLL`);
    for (const item of dropped) markSeen(item.key);
  }

  for (const item of take) {
    markSeen(item.key);
    store.add(entryFor(item.room, item.message));
  }
}

/**
 * Read up to this message, which is what the badge in Chatwork counts down.
 *
 * Two refusals are not failures. Chatwork answers 400 when there is nothing
 * left to mark, which is the state the card was asking for; and 404 once the
 * message has been taken back, which leaves the card pointing at nothing. A
 * card that cannot be boxed sits on the timeline for good, and neither of those
 * is worth that.
 */
const NOTHING_TO_READ = new Set([400, 404]);

export async function markRead({ roomId, messageId }) {
  try {
    await api.put(`/rooms/${encodeURIComponent(roomId)}/messages/read`, { message_id: String(messageId) });
  } catch (error) {
    if (!NOTHING_TO_READ.has(error.status)) throw error;
  }
  markSeen(keyOf(roomId, messageId));
  await saveSeen();
}

/**
 * Answer in the room, then read up to the message answered.
 *
 * The reply tag is the one Chatwork's own reply button writes, so the answer
 * lands under the question rather than beside it, and the person who wrote it
 * is told. Reading up to it is what takes the message off the badge; a send
 * that landed and a read that failed would leave the card to come round again
 * with the answer already sent, which is why the failure is reported.
 */
export async function replyAndRead(chat, text) {
  const body = String(text || '').trim();
  if (!body) throw new Error('nothing to send');
  const to = `[rp aid=${chat.accountId} to=${chat.roomId}-${chat.messageId}]`;
  const named = chat.accountName ? `${to} ${chat.accountName}` : to;
  await api.post(`/rooms/${encodeURIComponent(chat.roomId)}/messages`, {
    body: `${named}\n${body}`,
  });
  await markRead(chat);
}

async function cycle() {
  timer = null;
  try {
    if (!hasToken()) {
      complain('no Chatwork token — set PITWALL_CHATWORK_TOKEN');
    } else {
      await poll();
      if (complained) {
        console.log('[pitwall] chatwork: connected');
        complained = null;
      }
    }
    await saveSeen();
  } catch (error) {
    if (error instanceof NeedsTokenError) complain(`${error.message} — set PITWALL_CHATWORK_TOKEN`);
    else complain(error.message);
  }
  if (!running) return;
  timer = setTimeout(cycle, config.chatwork.pollSeconds * 1000);
  nextPollAt = Date.now() + config.chatwork.pollSeconds * 1000;
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
    fs.writeFileSync(paths.chatworkSeen, snapshot(), 'utf8');
  } catch (error) {
    console.error('[pitwall] could not persist chatwork state:', error.message);
  }
}

export function status() {
  return {
    running,
    linked: hasToken(),
    primed,
    nextPollAt: running ? nextPollAt : null,
  };
}

/** The pieces the tests drive directly, without the timer wrapped around them. */
export const internals = {
  addressesMe,
  bodyFor,
  poll,
  loadSeen,
  saveSeen,
  seen,
  opened,
  isPrimed: () => primed,
};
