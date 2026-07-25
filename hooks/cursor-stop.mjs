#!/usr/bin/env node
/**
 * Cursor stop hook — register a waiting entry and long-poll for a reply.
 *
 * Returns:
 *   {}                              — let the agent stop normally
 *   { followup_message: "..." }     — inject the next user message
 *
 * Fail open on any network / protocol error so Cursor keeps working without
 * pitwall.
 */
import { readStdin, request, detectRepo, detectHost, out, failOpen } from './lib.mjs';

const payload = await readStdin();

if (payload.status === 'aborted') {
  failOpen();
}

const roots = payload.workspace_roots || payload.workspaceRoots || [];
const cwd = roots[0] || process.cwd();
const repo = detectRepo([cwd, ...roots]);
const host = detectHost(cwd);

const modelParams = Array.isArray(payload.model_params) ? payload.model_params : [];
const effortParam = modelParams.find((p) => p.id === 'effort');

const waitBody = {
  agent: 'cursor',
  status: payload.status || 'completed',
  conversationId: payload.conversation_id || payload.conversationId,
  generationId: payload.generation_id || payload.generationId,
  transcriptPath: payload.transcript_path || payload.transcriptPath || null,
  workspace_roots: roots,
  loop_count: payload.loop_count ?? 0,
  repo,
  host,
  model: {
    label: payload.model || null,
    id: payload.model_id || null,
    params: modelParams,
    effort: effortParam?.value || null,
  },
};

const created = await request('POST', '/api/hooks/wait', {
  body: waitBody,
  timeoutMs: 2000,
});

if (!created?.ok || !created.id) {
  failOpen();
}

if (created.kind === 'notice' || created.skipped) {
  failOpen();
}

// Hybrid hold can last up to maxHoldSeconds (default 1800). Stay under the
// hooks.json timeout (1920) but long enough for the server to release us.
const resolution = await request('GET', `/api/hooks/wait/${created.id}/resolve`, {
  timeoutMs: 1_900_000,
});

if (!resolution) {
  failOpen();
}

if (resolution.action === 'reply' && resolution.message) {
  out({ followup_message: resolution.message });
  process.exit(0);
}

// dismiss / release / anything else → stop normally
failOpen();
