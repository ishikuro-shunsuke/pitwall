#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for AskUserQuestion — put the question itself on
 * the timeline as a notice.
 *
 * A question is asked in the middle of a turn, so no Stop hook ever runs and
 * nothing else reaches pitwall: the dialog carries the questions and options,
 * while the Notification that follows it six seconds later carries only the
 * words "Claude needs your permission".
 *
 * Nothing here decides anything. The hook posts and exits 0, the dialog opens
 * in the terminal as usual, and the card is a copy of what it says.
 */
import { readStdin, request, detectRepo, detectHost, modelFromTranscript, sessionTitle, failOpen } from './lib.mjs';

const payload = await readStdin();

// The matcher already narrows this, but the endpoint is shared and a payload
// from anywhere else has no questions to show.
if (payload.tool_name !== 'AskUserQuestion') {
  failOpen();
}

/** The dialog, as markdown: each question a heading, each option a bullet. */
function render(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const blocks = [];

  for (const question of questions) {
    const text = String(question?.question || question?.header || '').trim();
    if (!text) continue;
    const multi = question?.multiSelect ? ' _(multiple)_' : '';
    const lines = [`### ${text}${multi}`];
    for (const option of Array.isArray(question?.options) ? question.options : []) {
      const label = String(option?.label || '').trim();
      if (!label) continue;
      const description = String(option?.description || '').trim();
      lines.push(description ? `- **${label}** — ${description}` : `- **${label}**`);
    }
    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}

const body = render(payload.tool_input);
if (!body) {
  failOpen();
}

const cwd = payload.cwd || process.cwd();
const modelLabel = modelFromTranscript(payload.transcript_path);

await request('POST', '/api/hooks/notify', {
  body: {
    agent: 'claude',
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path || null,
    title: sessionTitle(payload.transcript_path),
    notificationType: 'ask_user_question',
    notice: 'ask_user_question',
    body,
    repo: detectRepo([cwd]),
    host: detectHost(cwd),
    model: {
      label: modelLabel,
      id: modelLabel,
      permissionMode: payload.permission_mode || null,
      agentType: payload.agent_type || null,
    },
  },
  timeoutMs: 1500,
});

failOpen();
