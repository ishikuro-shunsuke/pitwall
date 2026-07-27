#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for the tools that open a dialog and wait —
 * AskUserQuestion and ExitPlanMode — putting what the dialog says on the
 * timeline as a notice.
 *
 * Both are asked in the middle of a turn, so no Stop hook ever runs and nothing
 * else reaches pitwall: the dialog carries the question or the plan, while the
 * Notification that follows it six seconds later carries only the words "Claude
 * needs your permission".
 *
 * Nothing here decides anything. The hook posts and exits 0, the dialog opens
 * in the terminal as usual, and the card is a copy of what it says.
 */
import fs from 'node:fs';
import { readStdin, request, detectRepo, detectHost, modelFromTranscript, sessionTitle, failOpen } from './lib.mjs';

/**
 * The dialog, as markdown. The question is the card's own sentence, not a
 * heading over one: the card already carries a title, and a second bolder line
 * under it reads as a section of something longer.
 */
function renderQuestions(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const blocks = [];

  for (const question of questions) {
    const text = String(question?.question || question?.header || '').trim();
    if (!text) continue;
    const multi = question?.multiSelect ? ' _(multiple)_' : '';
    const lines = [`**${text}**${multi}`, ''];
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

/**
 * The plan, as it was written. ExitPlanMode is called with no plan of its own —
 * it is written to a file first — but Claude Code reads that file back into the
 * call before dispatching it, so `plan` is usually already here. When it is
 * not, `planFilePath` is, and the file is on the machine this hook runs on.
 */
function renderPlan(input) {
  const plan = String(input?.plan || '').trim();
  if (plan) return plan;
  const file = String(input?.planFilePath || '').trim();
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

const DIALOGS = {
  AskUserQuestion: { notice: 'ask_user_question', render: renderQuestions },
  ExitPlanMode: { notice: 'exit_plan_mode', render: renderPlan },
};

const payload = await readStdin();

// The matcher already narrows this, but the endpoint is shared and a payload
// from anywhere else has no dialog to show.
const dialog = DIALOGS[payload.tool_name];
if (!dialog) {
  failOpen();
}

const body = dialog.render(payload.tool_input);
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
    notificationType: dialog.notice,
    notice: dialog.notice,
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
