#!/usr/bin/env node
/**
 * Claude Code Notification hook — surface idle / permission prompts as
 * non-blocking timeline notices. Never holds the agent.
 */
import { readStdin, request, detectRepo, detectHost, failOpen } from './lib.mjs';

const payload = await readStdin();
const type = payload.notification_type || '';

// Only forward types that mean "you should look at this session".
const interesting = new Set([
  'permission_prompt',
  'idle_prompt',
  'agent_needs_input',
  'elicitation_dialog',
]);

if (!interesting.has(type)) {
  failOpen();
}

const cwd = payload.cwd || process.cwd();
const repo = detectRepo([cwd]);
const host = detectHost(cwd);

await request('POST', '/api/hooks/notify', {
  body: {
    agent: 'claude',
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path || null,
    notificationType: type,
    notice: type,
    title: payload.title || null,
    body: payload.message || payload.title || type,
    repo,
    host,
  },
  timeoutMs: 1500,
});

failOpen();
