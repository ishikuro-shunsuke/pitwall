#!/usr/bin/env node
/**
 * Claude Code PermissionRequest hook — the "allow this?" dialog, on the timeline.
 *
 * The Notification hook does not cover this. `permission_prompt` is fired by the
 * terminal dialog component, so a session driven from an editor — which asks
 * over stdio and draws the dialog itself — never sends one. PermissionRequest is
 * fired where the decision is needed, before either dialog exists, and carries
 * `tool_name` and `tool_input` besides.
 *
 * Nothing here decides anything. The hook is raced against the dialog, and a
 * result with no decision in it loses harmlessly: the prompt opens as usual and
 * the answer is still given in the session.
 */
import { readStdin, request, detectRepo, detectHost, modelFromTranscript, sessionTitle, effortLevel, failOpen } from './lib.mjs';

const fence = (lang, text) => `\`\`\`${lang}\n${String(text).trim()}\n\`\`\``;
const line = (text) => `\`${String(text).trim()}\``;

/**
 * What the call comes down to. The card is read on a phone with the session out
 * of reach, so it carries the one field the answer turns on — a Bash call is its
 * command, an edit is the file it edits — and leaves the rest in the terminal.
 */
const DETAIL = {
  Bash: (i) => (i.command ? fence('sh', i.command) : ''),
  BashOutput: (i) => line(i.bash_id ?? ''),
  KillShell: (i) => line(i.shell_id ?? ''),
  Read: (i) => line(i.file_path ?? ''),
  Write: (i) => line(i.file_path ?? ''),
  Edit: (i) => line(i.file_path ?? ''),
  NotebookEdit: (i) => line(i.notebook_path ?? ''),
  Glob: (i) => line([i.path, i.pattern].filter(Boolean).join(' ')),
  Grep: (i) => line([i.pattern, i.path].filter(Boolean).join(' ')),
  WebFetch: (i) => line(i.url ?? ''),
  WebSearch: (i) => line(i.query ?? ''),
  Agent: (i) => String(i.prompt ?? '').trim(),
  Artifact: (i) => line(i.file_path ?? ''),
};

/**
 * An MCP tool arrives as mcp__<server>__<tool> and has no shape worth guessing
 * at, so its arguments are shown as they were sent.
 */
function renderDetail(name, input) {
  const shape = DETAIL[name];
  if (shape) return shape(input || {});
  if (!input || !Object.keys(input).length) return '';
  return fence('json', JSON.stringify(input, null, 2));
}

const payload = await readStdin();
const name = String(payload.tool_name || '').trim();
if (!name) {
  failOpen();
}

const input = payload.tool_input || {};
const description = String(input.description || '').trim();
const heading = description ? `**${name}** — ${description}` : `**${name}**`;
const body = [heading, renderDetail(name, input)].filter(Boolean).join('\n\n');

const cwd = payload.cwd || process.cwd();
const modelLabel = modelFromTranscript(payload.transcript_path);

await request('POST', '/api/hooks/notify', {
  body: {
    agent: 'claude',
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path || null,
    title: sessionTitle(payload.transcript_path),
    notificationType: 'permission_request',
    notice: 'permission_request',
    body,
    repo: detectRepo([cwd]),
    host: detectHost(cwd),
    model: {
      label: modelLabel,
      id: modelLabel,
      effort: effortLevel(payload),
      permissionMode: payload.permission_mode || null,
      agentType: payload.agent_type || null,
    },
  },
  timeoutMs: 1500,
});

failOpen();
