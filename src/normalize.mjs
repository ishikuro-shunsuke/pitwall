import path from 'node:path';
import { config, softHoldSeconds } from './config.mjs';
import { buildLinks } from './deeplink.mjs';
import { newId, bucketOf, isUnanswered, list, add, update } from './store.mjs';

function clip(text, max = config.maxBodyChars) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… [truncated ${text.length - max} chars]`;
}

function repoKey(root) {
  if (!root) return 'unknown';
  return path.resolve(root).replace(/\\/g, '/');
}

function normalizeRepo(raw = {}) {
  const root = raw.root || raw.cwd || null;
  const name = raw.name || (root ? path.basename(root) : 'unknown');
  return {
    key: raw.key || repoKey(root),
    name,
    root: root || null,
    branch: raw.branch || null,
    remote: raw.remote || null,
  };
}

/**
 * The server's own environment describes the server's machine. Falling back to
 * it for a payload that came out of a container labels a container path as one
 * the editor could open, and the link silently points at nothing. Once the
 * container has told us where its workspace sits on the host, the rewritten
 * path really is on this machine, so this machine's distro is the right one.
 */
function normalizeHost(raw = {}) {
  const container = Boolean(raw.container);
  const containerRoot = (container && raw.containerRoot) || null;
  const hostRoot = (container && raw.hostRoot) || null;
  const serverDistro = process.env.WSL_DISTRO_NAME || null;
  return {
    platform: container && hostRoot ? process.platform : raw.platform || process.platform,
    wslDistro: container ? (hostRoot ? serverDistro : null) : raw.wslDistro || serverDistro,
    cwd: raw.cwd || null,
    container,
    containerRoot,
    hostRoot,
  };
}

function normalizeModel(raw = {}) {
  const params = Array.isArray(raw.params)
    ? raw.params.map((p) => ({ id: String(p.id ?? p.key ?? ''), value: String(p.value ?? '') }))
    : [];
  return {
    label: raw.label || raw.model || null,
    id: raw.id || raw.model_id || null,
    params,
    effort: raw.effort ?? null,
    permissionMode: raw.permissionMode || raw.permission_mode || null,
    agentType: raw.agentType || raw.agent_type || null,
  };
}

/**
 * Claude Code hands a Stop hook every background task the session still has
 * open, each with the sentence it was started under. All of them reach the
 * card, one line each — but a line, not a paragraph: the payload allows a
 * thousand characters per description and the card is there to be glanced at.
 */
const TASK_CHARS = 60;
const CUT = '...';

function taskLine(raw) {
  const full = String(raw?.description || '').trim();
  if (!full) return '';
  const head = full.split('\n')[0].trim();
  const line = head.length > TASK_CHARS
    ? head.slice(0, TASK_CHARS - CUT.length).trimEnd()
    : head;
  // Anything dropped — the rest of a long line, or the lines under the first —
  // is dropped where it can be seen to have been.
  return line === full ? line : line + CUT;
}

function taskLines(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(taskLine).filter(Boolean);
}

const ID_PREFIX = {
  cursor: 'cu', claude: 'cl', desktop: 'de', calendar: 'ca', todo: 'td', mail: 'ma', chatwork: 'cw',
};

/**
 * The thread a card belongs to — the run of talk it is one moment of, whether
 * that is an agent's session or a room full of people.
 *
 * Claude Code names its session, Cursor its conversation, and a payload carries
 * one or the other, so the two never have to be told apart here. Chatwork has
 * no thread of its own to name: what a message belongs to is the room it was
 * said in, which is also what answering it and clearing it both act on.
 *
 * Claude Desktop names nothing. An MCP server is handed no id for the
 * conversation calling it, so one question of its is not knowably the same
 * conversation as the last, and those cards stay one per ask.
 */
export function sessionKeyOf(entry) {
  return entry.sessionId || entry.conversationId || entry.chatwork?.roomId || null;
}

/**
 * The card something new belongs to, or null where its thread has nothing on
 * the timeline yet. The oldest is the one that grows, since that is the one the
 * feed leads with — and where a thread left several cards standing, from before
 * they were folded into one, the rest stay where they are rather than having
 * their turn moved out from under them.
 */
export function foldTarget(agent, key) {
  if (!key) return null;
  let found = null;
  for (const open of list()) {
    if (open.agent !== agent) continue;
    if (bucketOf(open) !== 'timeline') continue;
    if (sessionKeyOf(open) !== key) continue;
    const at = open.createdAtMs ?? Date.parse(open.createdAt);
    if (!found || at < (found.createdAtMs ?? Date.parse(found.createdAt))) found = open;
  }
  return found;
}

/**
 * Put a card on the timeline, or into the one its thread already has. Returns
 * the card it ended up in, which is the one to answer.
 */
export function addFolded(entry) {
  const target = foldTarget(entry.agent, sessionKeyOf(entry));
  if (!target) return add(entry);
  return update(target.id, foldTurn(target, entry)) ?? entry;
}

/** How far back a card remembers what a session said into it. */
const MAX_PRIOR_TURNS = 20;

/** Where a card keeps what the service it came from needs to act on it. */
const SERVICE_SLOTS = ['chatwork', 'chatworkTask', 'mail', 'todo', 'calendar', 'agenda'];

/**
 * The next stop of a session whose card has not been dealt with yet. It goes
 * into that card rather than a second one: the turn standing there moves down
 * into `priorTurns` and the new one takes the head, where the reply box is.
 *
 * `createdAt` is left where it was, so the card keeps its place in a feed
 * ordered by how long each has waited — a session that keeps talking does not
 * walk to the back of the queue it is at the front of. The hold is the new
 * turn's and starts now: the ceiling over a question asked an hour ago has
 * nothing to say about the one asked since.
 */
export function foldTurn(entry, next) {
  const prior = [...(entry.priorTurns ?? []), {
    at: entry.updatedAt ?? entry.createdAt,
    title: entry.title,
    body: entry.body,
    notice: entry.notice,
    notificationType: entry.notificationType,
    turnMessages: entry.turnMessages ?? [],
    images: entry.images ?? [],
  }];

  const patch = {
    priorTurns: prior.slice(-MAX_PRIOR_TURNS),
    updatedAt: next.createdAt,
    updatedAtMs: next.createdAtMs,

    title: next.title ?? entry.title,
    body: next.body,
    notice: next.notice,
    notificationType: next.notificationType,
    turnMessages: next.turnMessages,
    images: next.images,
    repo: next.repo,
    host: next.host,
    model: next.model,
    transcriptPath: next.transcriptPath,
    generationId: next.generationId,
    backgroundTaskCount: next.backgroundTaskCount,
    backgroundTasks: next.backgroundTasks,
    links: next.links,
  };

  // What the buttons act on. A card carrying a room full of messages answers
  // under the newest of them and reads the room up to it, which takes the ones
  // above it with it — so the slot has to be the newest message's, not the one
  // the card opened with.
  for (const slot of SERVICE_SLOTS) {
    if (next[slot] !== undefined) patch[slot] = next[slot];
  }

  // A stop is something to answer, so it reopens the card and starts the hold
  // over. A notice is only the session talking on its way past — it says what
  // it has to say into the card and leaves the hold, and whatever hook is
  // holding it, exactly as it found them.
  if (next.kind === 'wait') {
    patch.kind = 'wait';
    patch.status = 'waiting';
    patch.resolvedAt = null;
    patch.resolution = null;
    patch.holdUntil = next.holdUntil;
    patch.holdMaxAt = next.holdMaxAt;
  }

  return patch;
}

/**
 * Build a unified timeline entry from a hook payload.
 * `agent` is 'cursor' | 'claude' | 'desktop' | 'calendar' | 'todo' | 'mail' | 'chatwork'.
 * `kind` is 'wait' | 'notice'.
 */
export function buildEntry({
  agent,
  kind = 'wait',
  payload = {},
  body = '',
  turnMessages = [],
  images = [],
}) {
  const createdAt = new Date().toISOString();
  const createdAtMs = Date.now();
  const host = normalizeHost(payload.host);
  const repo = normalizeRepo(payload.repo ?? { root: host.cwd, cwd: host.cwd });
  const model = normalizeModel(payload.model ?? {});

  const entry = {
    id: newId(ID_PREFIX[agent] ?? 'e'),
    agent,
    kind,
    status: kind === 'notice' ? 'notice' : 'waiting',
    createdAt,
    createdAtMs,
    // When the card last had something added to it. The same as `createdAt`
    // until a session stops into it a second time.
    updatedAt: createdAt,
    updatedAtMs: createdAtMs,
    holdUntil: createdAtMs + softHoldSeconds(agent) * 1000,
    holdMaxAt: createdAtMs + config.maxHoldSeconds * 1000,
    resolvedAt: null,
    resolution: null,
    reply: null,

    title: payload.title || null,
    sessionId: payload.sessionId || payload.session_id || null,
    conversationId: payload.conversationId || payload.conversation_id || null,
    generationId: payload.generationId || payload.generation_id || null,
    transcriptPath: payload.transcriptPath || payload.transcript_path || null,

    repo,
    host,
    model,
    body: clip(body || payload.body || payload.last_assistant_message || ''),
    turnMessages: (turnMessages.length ? turnMessages : payload.turnMessages || []).map((m) =>
      typeof m === 'string' ? clip(m) : clip(m?.text || ''),
    ),
    images,
    notice: payload.notice || null,
    notificationType: payload.notificationType || payload.notification_type || null,

    backgroundTaskCount: Array.isArray(payload.background_tasks)
      ? payload.background_tasks.length
      : (payload.backgroundTaskCount ?? 0),
    backgroundTasks: taskLines(payload.background_tasks),

    /** Earlier stops of this session, oldest first. See `foldTurn`. */
    priorTurns: [],

    links: null,
  };

  entry.links = buildLinks(entry);
  return entry;
}

/**
 * Whether an answer can still reach this card's session after the hook that was
 * holding it has gone. Claude Code names its session and leaves the transcript
 * on disk, so `--resume` can pick it up again; Cursor has nothing of the kind,
 * and a card that was answered or boxed is finished with either way.
 */
export function isResumable(entry) {
  return Boolean(
    entry.agent === 'claude'
    && entry.sessionId
    && entry.status === 'expired'
    && (entry.repo?.root || entry.host?.cwd),
  );
}

export function publicEntry(entry) {
  if (!entry) return null;
  return {
    ...entry,
    bucket: bucketOf(entry),
    unanswered: isUnanswered(entry),
    resumable: isResumable(entry),
    holdRemainingMs: entry.status === 'waiting'
      ? Math.max(0, (entry.holdUntil ?? 0) - Date.now())
      : 0,
  };
}
