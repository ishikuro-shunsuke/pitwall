# What Claude Code tells a hook, and when

Read out of `@anthropic-ai/claude-code` 2.x (`bin/claude.exe`, a compiled bundle
— every name below is minified and will not survive an upgrade). Written down
because the answer to "why did nothing show up?" is not in the docs.

## Nothing reaches a Stop hook mid-turn

A tool call is not the end of a turn, so `Stop` does not run for one. Anything a
tool does that leaves you staring at the terminal — a permission prompt, a
question, a plan approval — is invisible to a Stop hook by construction. That is
the whole reason [`hooks/claude-dialog.mjs`](../hooks/claude-dialog.mjs)
is a `PreToolUse` hook and not something cleverer.

## The dialog host is what fires Notification

Every blocking dialog goes through one host component, keyed by a dialog `kind`:

| kind | what it is |
| --- | --- |
| `permission_prompt` | the ordinary tool permission request |
| `permission_ask_user_question` | **AskUserQuestion** — payload carries `questions` |
| `permission_bash`, `permission_browser`, `permission_powershell` | per-tool variants |
| `plan_mode`, plan approval | plan mode entry and its approval |

The host looks the kind up in a table of titles (most of them the same string,
`"Claude needs your permission"`) and hands it to `TLr(message, kind)`, which
fires the notification. Two things happen there that matter:

- **It waits six seconds.** `Date.now() - lastUserActivity >= 6000` — the timer
  restarts on every keystroke. Answer a dialog promptly and no notification is
  ever sent.
- **The type is flattened to `permission_prompt`.** The dialog host passes that
  literal for every kind it hosts, AskUserQuestion included. A hook matching on
  `notification_type` cannot tell a question from a `chmod` it wants to run.

`idle_prompt` comes from somewhere else entirely: a timer on the main input,
message `"Claude is waiting for your input"`, gated on
`messageIdleNotifThresholdMs`. `agent_needs_input` and `agent_completed` are
background-agent (FleetView) band changes — `<label> needs your input` — and
never fire for the session you are sitting in.

## The Notification payload is three fields

```json
{ "hook_event_name": "Notification", "message": "...", "title": "...", "notification_type": "..." }
```

Plus the usual `session_id` / `transcript_path` / `cwd`. There is no tool name,
no tool input, no questions, no options. A Notification hook cannot show you
what you are being asked — only that you are being asked something.

The dispatcher runs the hook *before* it picks a terminal channel, so hooks fire
even with `preferredNotifChannel: notifications_disabled`.

The full set of `notification_type` values, from the settings-schema metadata:

```
permission_prompt  idle_prompt  auth_success  elicitation_dialog
elicitation_complete  elicitation_response  agent_needs_input  agent_completed
```

`worker_permission_prompt`, `workflow_permission_prompt`, `push_notification`,
`computer_use_enter` and `computer_use_exit` are emitted too, though the schema
does not list them.

## So AskUserQuestion produced nothing

Everything above compounds: the question is mid-turn (no `Stop`), the
notification only fires if you sit still for six seconds, and if it does fire it
says `permission_prompt` with no question text attached. Across 294 recorded
entries, pitwall had never stored a single notice.

`PreToolUse` has the payload the notification lacks: `tool_name`, `tool_input`
(the `questions` array, each with `header`, `multiSelect`, and `options` of
`label` / `description`), `tool_use_id`. It is the only event that sees a
question before the terminal does.

## And the plan is in there too

`ExitPlanMode` — *"Would you like to proceed?"* — takes no plan as an argument
any more: the plan is written to a file first (`~/.claude/plans/<slug>.md`,
unless `plansDirectory` moves it) and the tool reads it back. So the schema says
the input is empty, and `tool_input` still arrives holding the plan.

Every tool call is normalized as the assistant message is parsed, before any of
it is dispatched, and the `ExitPlanMode` branch of that pass injects two fields
from disk: `plan`, the whole markdown, and `planFilePath`, where it came from.
That happens ahead of `PreToolUse`, so the hook is handed the plan the dialog is
about to draw. If it ever is not, the path is, and the file is on the machine
the hook runs on.

## Why the hook only looks

`PreToolUse` can deny a call with a reason, and the model reads that reason —
enough to answer a question from the browser. It was not taken, because denying
means the dialog never opens in the terminal, which takes away the answer path
that already works, and holding the hook open pins the turn for as long as the
card goes unanswered. The hook posts a notice and exits 0.
