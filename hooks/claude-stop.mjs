#!/usr/bin/env node
/**
 * Claude Code Stop hook — register a waiting entry and long-poll for a reply.
 *
 * Returns:
 *   {}                                              — allow stop
 *   { decision: "block", reason: "..." }            — continue with reason as feedback
 *
 * Fail open on any error. Claude force-stops after 8 consecutive blocks; the
 * UI surfaces the count so you can resume the session in-terminal before that.
 */
import {
  readStdin,
  request,
  detectRepo,
  detectHost,
  modelFromTranscript,
  sessionTitle,
  effortLevel,
  uploadImages,
  out,
  failOpen,
} from './lib.mjs';

const payload = await readStdin();
const cwd = payload.cwd || process.cwd();
const repo = detectRepo([cwd]);
const host = detectHost(cwd);
const modelLabel = modelFromTranscript(payload.transcript_path);
const title = sessionTitle(payload.transcript_path);
const lastMessage = payload.last_assistant_message || '';
const images = await uploadImages(lastMessage, [repo.root, cwd]);

const waitBody = {
  agent: 'claude',
  sessionId: payload.session_id,
  title,
  transcriptPath: payload.transcript_path || null,
  stop_hook_active: Boolean(payload.stop_hook_active),
  last_assistant_message: lastMessage,
  images,
  background_tasks: payload.background_tasks || [],
  session_crons: payload.session_crons || [],
  agent_type: payload.agent_type || null,
  permission_mode: payload.permission_mode || null,
  repo,
  host,
  model: {
    label: modelLabel,
    id: modelLabel,
    effort: effortLevel(payload),
    permissionMode: payload.permission_mode || null,
    agentType: payload.agent_type || null,
  },
};

const created = await request('POST', '/api/hooks/wait', {
  body: waitBody,
  timeoutMs: 2000,
});

if (!created?.ok || !created.id) {
  failOpen();
}

const resolution = await request('GET', `/api/hooks/wait/${created.id}/resolve`, {
  timeoutMs: 1_900_000,
});

if (!resolution) {
  failOpen();
}

if (resolution.action === 'reply' && resolution.message) {
  out({
    decision: 'block',
    reason: `pitwall 経由でユーザーから返信が届きました。まずこの返信をそのまま一度引用してから、内容に応じて続けてください:\n\n"${resolution.message}"`,
  });
  process.exit(0);
}

failOpen();
