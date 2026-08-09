#!/usr/bin/env node
/**
 * Claude Code Stop hook — register a waiting entry and long-poll for a reply.
 *
 * Installed with `asyncRewake`, so this runs in the background: the session
 * stops as usual and stays yours to type into while the entry sits in the
 * browser. Exiting 2 wakes it back up with whatever went to stderr.
 *
 * Exit 2 with the reply on stderr is also the plain blocking protocol, so where
 * asyncRewake is not understood the same exit holds the stop open instead. The
 * reply lands either way; only the waiting differs.
 *
 * Fail open on any error.
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
  failOpen,
} from './lib.mjs';

const payload = await readStdin();

// Cursor runs this hook too, from its own agent. cursor-stop already holds that
// turn, and what arrives here has no message, no workspace root, and a cwd of
// ~/.claude — a second card with nothing in it.
if (/[\\/]\.cursor[\\/]/.test(payload.transcript_path || '')) {
  failOpen();
}

const cwd = payload.cwd || process.cwd();
const repo = detectRepo([cwd]);
const host = detectHost(cwd);
const modelLabel = modelFromTranscript(payload.transcript_path);
const title = sessionTitle(payload.transcript_path);
const lastMessage = payload.last_assistant_message || '';
const images = await uploadImages(lastMessage, [repo.worktree || repo.root, cwd]);

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
  // stderr, not stdout: this is the text Claude wakes up holding.
  process.stderr.write(
    'ユーザーから返信が届きました。まずこの返信をそのまま一度引用してから、'
      + `内容に応じて続けてください:\n\n"${resolution.message}"\n`,
  );
  process.exit(2);
}

failOpen();
