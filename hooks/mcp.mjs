/**
 * MCP server for Claude Desktop, over stdio.
 *
 * Claude Desktop spawns this as a "Local command" connector. When Claude needs
 * something from you it calls `ask_user`, which puts a card on the timeline and
 * waits; your reply comes back as the result of that call, in the conversation
 * you were already having.
 *
 * A tool call cannot be held for as long as a card can. Claude Desktop cuts one
 * off after about a minute, and a card stays answerable for half an hour, so
 * `ask_user` hands the turn back with `pending` and Claude calls `wait_for_reply`
 * until one of them has an answer. `?hold=` on the resolve endpoint is what makes
 * that safe: the card does not notice the gap between polls.
 *
 * Nothing but JSON-RPC may reach stdout. Logging goes to stderr.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ROOT, baseUrl, request } from './lib.mjs';

const LATEST = '2025-11-25';
const SUPPORTED = new Set([LATEST, '2025-06-18', '2025-03-26', '2024-11-05']);

/**
 * How long one poll waits before handing the turn back. Under Claude Desktop's
 * own limit by enough to survive a slow round trip; being wrong about that limit
 * costs a failed tool call and nothing else, since the card and its hold are
 * untouched and the next `wait_for_reply` picks up where this left off.
 */
const POLL_SECONDS = pollSeconds();

function pollSeconds() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--poll-seconds') return Number(argv[i + 1]) || 45;
    if (argv[i].startsWith('--poll-seconds=')) return Number(argv[i].slice(15)) || 45;
  }
  return 45;
}

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const INSTRUCTIONS = [
  'pitwall is where this user reads the things they need to act on.',
  'When you need something from them, call ask_user rather than ending your turn',
  'with a question — they may not be looking at this chat. If ask_user says nobody',
  'has answered yet, call wait_for_reply with the id it gave you, and keep going',
  'until you have an answer or are told nobody answered.',
].join(' ');

const TOOLS = [
  {
    name: 'ask_user',
    title: 'Ask the user (pitwall)',
    description:
      'Ask the user a question and wait for their answer. Use this whenever you need '
      + 'something only they can give you — a decision between options, a detail you are '
      + 'missing, or the go-ahead before something you cannot undo — instead of ending '
      + 'your turn with a question in the chat. The question appears as a card on their '
      + 'pitwall timeline, wherever they happen to be looking, and their reply comes back '
      + 'as the result of this call. If the result says nobody has answered yet, call '
      + 'wait_for_reply with the id it gives you.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'The question, in one or two sentences. Write it so it makes sense to '
            + 'someone who has not been reading the conversation.',
        },
        context: {
          type: 'string',
          description: 'Optional. What you were doing and why the answer matters. Markdown.',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional. The choices you would accept. The user is free to type something else.',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_reply',
    title: 'Keep waiting for the user (pitwall)',
    description:
      'Keep waiting for an answer to a question you already asked with ask_user. Call '
      + 'this with the id from a result that said the user has not answered yet, and keep '
      + 'calling it until you get an answer or are told nobody answered. Do not ask the '
      + 'same question again with ask_user — that puts a second card on their timeline.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The id from the previous ask_user or wait_for_reply result.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'notify_user',
    title: 'Tell the user (pitwall)',
    description:
      'Put a note on the user\'s pitwall timeline without waiting for a reply. Use it '
      + 'when you have finished something they have been waiting on, or when you are '
      + 'about to spend a long time on one step. Returns immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to tell them. Markdown.' },
        title: { type: 'string', description: 'Optional one-line heading.' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
];

/* ---------------------------------------------------------------- pitwall -- */

/** How long a card has left, in the words a sentence about it wants. */
const holds = new Map();

function minutesLeft(id) {
  const until = holds.get(id);
  if (!until) return null;
  const minutes = Math.round((until - Date.now()) / 60_000);
  return minutes > 0 ? minutes : null;
}

/**
 * One poll. Unlike `request`, this has to tell a pitwall that is not running
 * apart from an id it has never heard of — the first is worth saying out loud,
 * the second means asking again.
 */
async function pollOnce(id) {
  const url = `${baseUrl()}/api/hooks/wait/${id}/resolve?hold=${POLL_SECONDS}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout((POLL_SECONDS + 15) * 1000) });
    if (res.status === 404) return { gone: true };
    if (!res.ok) return { unreachable: true };
    // The server writes a space every 30s so the socket stays warm; JSON.parse
    // skips it.
    return { resolution: JSON.parse(await res.text()) };
  } catch {
    return { unreachable: true };
  }
}

function text(body, isError = false) {
  return { content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) };
}

const CARRY_ON = 'Carry on with your best judgement, and say plainly what you assumed.';

function resultFor(id, resolution) {
  const action = resolution?.action;

  if (action === 'reply') {
    holds.delete(id);
    return text(`The user replied:\n\n${resolution.message}`);
  }
  if (action === 'dismiss') {
    holds.delete(id);
    return text(
      `The user saw the question and chose not to answer it. ${CARRY_ON} `
      + 'Do not ask again unless something new comes up.',
    );
  }
  if (action === 'pending') {
    const left = minutesLeft(id);
    return text(
      `Nobody has answered yet${left ? `, and the card has about ${left} minutes left` : ''}. `
      + `Call wait_for_reply with id "${id}" to keep waiting. `
      + 'Do not repeat the question in the chat.',
    );
  }
  // 'release', under any reason, and anything unrecognised: the card is gone
  // and no answer is coming.
  holds.delete(id);
  return text(`Nobody answered. ${CARRY_ON}`);
}

const UNREACHABLE = () =>
  text(
    `Could not reach pitwall at ${baseUrl()}. It may not be running. `
    + 'Ask the user in the chat instead.',
    true,
  );

/** The question, as the card says it. */
function renderAsk({ question, context, options }) {
  const blocks = [];
  const preamble = String(context || '').trim();
  if (preamble) blocks.push(preamble);

  const lines = [`**${String(question).trim()}**`];
  const choices = (Array.isArray(options) ? options : [])
    .map((o) => String(o ?? '').trim())
    .filter(Boolean);
  if (choices.length) {
    lines.push('');
    for (const choice of choices) lines.push(`- ${choice}`);
  }
  blocks.push(lines.join('\n'));
  return blocks.join('\n\n');
}

const TITLE_CHARS = 60;

function titleFor(question) {
  const head = String(question).trim().split('\n')[0].trim();
  return head.length > TITLE_CHARS ? `${head.slice(0, TITLE_CHARS - 1).trimEnd()}…` : head;
}

const DESKTOP_REPO = { key: 'claude-desktop', name: 'Claude Desktop', root: null };

async function askUser(args) {
  const question = String(args?.question ?? '').trim();
  if (!question) return text('`question` is required.', true);

  const created = await request('POST', '/api/hooks/wait', {
    body: {
      agent: 'desktop',
      title: titleFor(question),
      body: renderAsk({ ...args, question }),
      repo: DESKTOP_REPO,
    },
    timeoutMs: 5000,
  });
  if (!created?.ok || !created.id) return UNREACHABLE();

  if (created.holdMaxAt) holds.set(created.id, created.holdMaxAt);
  const polled = await pollOnce(created.id);
  if (polled.unreachable || polled.gone) return UNREACHABLE();
  return resultFor(created.id, polled.resolution);
}

async function waitForReply(args) {
  const id = String(args?.id ?? '').trim();
  if (!id) return text('`id` is required. It comes from a previous ask_user result.', true);

  const polled = await pollOnce(id);
  if (polled.gone) {
    holds.delete(id);
    return text(`No question with id "${id}" is waiting. Ask again with ask_user.`, true);
  }
  if (polled.unreachable) return UNREACHABLE();
  return resultFor(id, polled.resolution);
}

async function notifyUser(args) {
  const message = String(args?.message ?? '').trim();
  if (!message) return text('`message` is required.', true);

  const posted = await request('POST', '/api/hooks/notify', {
    body: {
      agent: 'desktop',
      title: String(args?.title ?? '').trim() || null,
      body: message,
      notice: 'desktop-note',
      repo: DESKTOP_REPO,
    },
    timeoutMs: 5000,
  });
  if (!posted?.ok) return UNREACHABLE();
  return text('Put on their timeline.');
}

const CALLS = { ask_user: askUser, wait_for_reply: waitForReply, notify_user: notifyUser };

/* ------------------------------------------------------------- protocol --- */

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function dispatch(method, params) {
  if (method === 'initialize') {
    const asked = params?.protocolVersion;
    return {
      protocolVersion: SUPPORTED.has(asked) ? asked : LATEST,
      capabilities: { tools: {} },
      serverInfo: { name: 'pitwall', title: 'pitwall', version: version() },
      instructions: INSTRUCTIONS,
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    const call = CALLS[params?.name];
    if (!call) throw new RpcError(-32602, `Unknown tool: ${params?.name}`);
    return call(params?.arguments ?? {});
  }
  throw new RpcError(-32601, `Method not found: ${method}`);
}

export function startMcp() {
  const cancelled = new Set();
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    if (!line.trim()) return;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    // A notification has no id and is never answered. `notifications/cancelled`
    // is noted rather than acted on: dropping the HTTP poll would close the
    // socket, and the server reads that as the card having been abandoned.
    if (message.id === undefined || message.id === null) {
      if (message.method === 'notifications/cancelled' && message.params?.requestId !== undefined) {
        cancelled.add(message.params.requestId);
      }
      return;
    }

    // Deliberately not awaited: a call that is holding for a reply must not
    // stop the next one from being answered.
    Promise.resolve()
      .then(() => dispatch(message.method, message.params))
      .then(
        (result) => {
          if (cancelled.delete(message.id)) return;
          send({ jsonrpc: '2.0', id: message.id, result });
        },
        (error) => {
          if (cancelled.delete(message.id)) return;
          send({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: error instanceof RpcError ? error.code : -32603,
              message: error?.message || 'Internal error',
            },
          });
        },
      );
  });

  rl.on('close', () => process.exit(0));
}
