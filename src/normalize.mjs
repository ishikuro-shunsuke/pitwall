import path from 'node:path';
import { config, softHoldSeconds } from './config.mjs';
import { buildLinks } from './deeplink.mjs';
import { newId, bucketOf } from './store.mjs';

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
    dirty: Boolean(raw.dirty),
  };
}

function normalizeHost(raw = {}) {
  return {
    platform: raw.platform || process.platform,
    wslDistro: raw.wslDistro || process.env.WSL_DISTRO_NAME || null,
    cwd: raw.cwd || null,
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
 * Build a unified timeline entry from a hook payload.
 * `agent` is 'cursor' | 'claude'.
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
    id: newId(agent === 'claude' ? 'cl' : 'cu'),
    agent,
    kind,
    status: kind === 'notice' ? 'notice' : 'waiting',
    createdAt,
    createdAtMs,
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

    links: null,
  };

  entry.links = buildLinks(entry);
  return entry;
}

export function publicEntry(entry) {
  if (!entry) return null;
  return {
    ...entry,
    bucket: bucketOf(entry),
    holdRemainingMs: entry.status === 'waiting'
      ? Math.max(0, (entry.holdUntil ?? 0) - Date.now())
      : 0,
  };
}
