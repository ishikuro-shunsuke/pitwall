import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Like `num`, but midnight is a real answer and 24 is not. */
function hourOfDay(value, fallback) {
  const parsed = Math.trunc(Number(value));
  return value !== '' && Number.isFinite(parsed) && parsed >= 0 && parsed <= 23 ? parsed : fallback;
}

export const config = {
  host: process.env.PITWALL_HOST || '127.0.0.1',
  port: num(process.env.PITWALL_PORT, 4477),
  dataDir: process.env.PITWALL_DATA
    ? path.resolve(process.env.PITWALL_DATA)
    : path.join(ROOT, 'data'),

  /**
   * Hybrid hold: idle wait window for an agent that is being held. If nobody
   * opens the composer, it is released after this many seconds and the entry
   * becomes `expired`.
   */
  holdSeconds: num(process.env.PITWALL_HOLD_SECONDS, 300),

  /**
   * Maximum total hold from entry creation, even with heartbeats.
   * Hook runner timeout must be larger than this (see install-hooks).
   */
  maxHoldSeconds: num(process.env.PITWALL_MAX_HOLD_SECONDS, 1800),

  /** Entries older than this are pruned from disk on boot. */
  retentionDays: num(process.env.PITWALL_RETENTION_DAYS, 30),

  maxBodyChars: num(process.env.PITWALL_MAX_BODY_CHARS, 40_000),
  maxImagesPerEntry: num(process.env.PITWALL_MAX_IMAGES, 12),
  maxImageBytes: num(process.env.PITWALL_MAX_IMAGE_BYTES, 32 * 1024 * 1024),

  google: {
    /**
     * Google accepts any loopback port for a desktop client, so consent takes
     * whatever is free — unless the browser is on the other side of a container
     * boundary and the port has to be one that was forwarded.
     */
    oauthPort: Number(process.env.PITWALL_OAUTH_PORT) || 0,
  },

  calendar: {
    /** Empty means every calendar ticked in Google Calendar's own sidebar. */
    ids: (process.env.PITWALL_CALENDAR_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    pollSeconds: num(process.env.PITWALL_CALENDAR_POLL_SECONDS, 120),
    /** How far ahead to keep events loaded. Reminders can sit a day out. */
    lookaheadMinutes: num(process.env.PITWALL_CALENDAR_LOOKAHEAD_MINUTES, 2880),
    /**
     * A reminder whose moment passed while the server was down has nothing left
     * to warn about, so it is marked seen instead of landing on the feed. Long
     * enough to survive a laptop lid, short enough that nothing arrives stale.
     */
    staleMinutes: num(process.env.PITWALL_CALENDAR_STALE_MINUTES, 20),
  },

  /**
   * The day ahead, as one card each morning. Which calendars it reads is
   * `calendar.ids` above: a calendar worth a reminder is worth a line here.
   */
  agenda: {
    /**
     * The hour the card lands on. A day has no moment of its own to inherit —
     * it is the whole of what the card is about — so this is the whole of it.
     */
    hour: hourOfDay(process.env.PITWALL_AGENDA_HOUR ?? '', 7),
    /** Overrides the zone recorded when the account was linked. */
    timeZone: process.env.PITWALL_AGENDA_TIMEZONE || '',
  },

  /** Google Tasks. Called todo here, so a card's badge is not the word the
   * chips under it already use for an agent's own background work. */
  todo: {
    /** Empty means every list in Google Tasks. */
    listIds: (process.env.PITWALL_TODO_LISTS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    pollSeconds: num(process.env.PITWALL_TODO_POLL_SECONDS, 300),
    /**
     * The hour a card lands on. Tasks carries no time of day — the API drops
     * it — so there is no moment to inherit and this is the whole of it.
     */
    dueHour: hourOfDay(process.env.PITWALL_TODO_DUE_HOUR ?? '', 9),
    /** Overrides the zone recorded when the account was linked. */
    timeZone: process.env.PITWALL_TODO_TIMEZONE || '',
  },

  mail: {
    /** Gmail search syntax. Whatever this matches becomes a card, once. */
    query: process.env.PITWALL_MAIL_QUERY || 'in:inbox is:unread',
    /**
     * Shorter than the other two, because here it is the whole of the wait. A
     * reminder and a due task have a moment of their own to fire at, and the
     * poll only has to have found them by then; mail lands on the feed when
     * the poll finds it and not before.
     */
    pollSeconds: num(process.env.PITWALL_MAIL_POLL_SECONDS, 60),
    /** A quiet hour that ends in a hundred cards is worse than a missed one. */
    maxPerPoll: num(process.env.PITWALL_MAIL_MAX_PER_POLL, 20),
  },

  chatwork: {
    /** Empty means every chat the account is in. */
    roomIds: (process.env.PITWALL_CHATWORK_ROOMS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** As with mail, this is the whole of the wait before a message lands. */
    pollSeconds: num(process.env.PITWALL_CHATWORK_POLL_SECONDS, 60),
    maxPerPoll: num(process.env.PITWALL_CHATWORK_MAX_PER_POLL, 20),
    /** Tasks are asked for far less often: a deadline is a day, not a minute. */
    taskPollSeconds: num(process.env.PITWALL_CHATWORK_TASK_POLL_SECONDS, 300),
    taskDueHour: hourOfDay(process.env.PITWALL_CHATWORK_TASK_DUE_HOUR ?? '', 9),
    /**
     * A task's deadline is an instant, and which day it falls on depends on
     * where you are. Chatwork's API does not say where the account is, so this
     * is the only thing that can — the server's own zone otherwise.
     */
    timeZone: process.env.PITWALL_CHATWORK_TIMEZONE || '',
  },
};

/**
 * Cursor's stop hook holds the agent for as long as it waits, so an entry
 * nobody is looking at has to let go early. Claude Desktop is the same: a tool
 * call is open the whole time it waits. Claude Code's hook is the exception —
 * it waits in the background with the session already stopped, where nothing is
 * being held, so it stays answerable for the whole window.
 */
export function softHoldSeconds(agent) {
  return agent === 'claude' ? config.maxHoldSeconds : config.holdSeconds;
}

export const paths = {
  entries: path.join(config.dataDir, 'entries.json'),
  images: path.join(config.dataDir, 'images'),
  responses: path.join(config.dataDir, 'responses'),
  settings: path.join(config.dataDir, 'settings.json'),
  googleClient: path.join(config.dataDir, 'google-client.json'),
  googleToken: path.join(config.dataDir, 'google-token.json'),
  calendarSeen: path.join(config.dataDir, 'calendar-seen.json'),
  agendaSeen: path.join(config.dataDir, 'agenda-seen.json'),
  todoSeen: path.join(config.dataDir, 'todo-seen.json'),
  mailSeen: path.join(config.dataDir, 'mail-seen.json'),
  chatworkSeen: path.join(config.dataDir, 'chatwork-seen.json'),
  chatworkTaskSeen: path.join(config.dataDir, 'chatwork-task-seen.json'),
  public: path.join(ROOT, 'public'),
  deeplink: path.join(ROOT, 'src', 'deeplink.mjs'),
};
