# pitwall

One timeline for every coding agent that is waiting on you.

Cursor and Claude Code stop and wait for your input in windows you are not looking at. pitwall collects those moments into a single timeline in your browser, and delivers your reply back into the same chat or session. Link a Google account and your calendar reminders, due tasks and new mail arrive on the same timeline. Everything runs on your machine, with no dependencies beyond Node.js.

https://github.com/user-attachments/assets/942aed4a-8fb7-4f03-b8a2-f58dd02ed616

## Requirements

- Node.js 20.6+
- Cursor, Claude Code, or both

## Getting started

Start the server and leave it running:

```bash
npm start   # http://127.0.0.1:4477/
```

Then install the hooks once in every place an agent runs:

```bash
npm run install-hooks
```

Cursor loads them after a restart, Claude Code from the next session.

### Inside a devcontainer

Run this in the container. Put it in `postCreateCommand` to get the hooks back on every rebuild:

```bash
curl -fsSL https://raw.githubusercontent.com/ishikuro-shunsuke/pitwall/main/install.sh \
  | sh -s -- --devcontainer
```

The container reaches the host through `host.docker.internal`. Where that does not resolve, the installer prints the setting to add.

`/workspaces/…` means nothing to an editor running outside the container, so **Open in Cursor** stays off a card until `devcontainer.json` names both ends of the mount:

```json
"remoteEnv": {
  "PITWALL_HOST_ROOT": "${localWorkspaceFolder}",
  "PITWALL_CONTAINER_ROOT": "${containerWorkspaceFolder}"
}
```

### Somewhere else on the network

```bash
npm run install-hooks -- --url http://192.168.1.10:4477
```

## Replying

**Cursor** stops the agent and waits for your reply. If nobody opens the composer it gives up after 5 minutes and the agent stops as usual; with the composer open it waits up to 30 minutes.

**Claude Code** holds nothing. The session stops the way it always does, so you can keep typing locally, and a reply sent from the card within 30 minutes wakes it up and continues from there. Once the same session stops again, the older card expires. What you typed does not show up in the Claude Code UI — Claude quotes it once at the start of its reply.

A question Claude asks mid-session arrives as a card too, with its options, and so does a plan waiting to be accepted. Those are answered back in the session; the card is there so you know what is being asked.

## Google Calendar, Tasks and Gmail

A reminder set on an event arrives as a card at the minute the event asked for, carrying the time, the place, the call link and who else is coming. There is nothing to reply to; **Box** clears it.

A task arrives on the morning it is due, and again every morning after that. **Chequered** ticks it off in Google — the one button on the feed that changes anything outside pitwall. **Box** files the card away and leaves the task open, so it comes round again tomorrow.

Mail is read only: a card for each new message, **Box** to clear it. Nothing sent, nothing marked read, nothing moved.

First, in [Google Cloud Console](https://console.cloud.google.com/): enable the Google Calendar API, the Google Tasks API and the Gmail API, create an OAuth client of type **Desktop app**, and add your own address under **Audience → Test users**. Save the JSON it offers you as `data/google-client.json`, or pass the same pair as `PITWALL_GOOGLE_CLIENT_ID` and `PITWALL_GOOGLE_CLIENT_SECRET`.

Then link the account once:

```bash
npm run link-google
```

Approving in the browser writes a refresh token to `data/google-token.json`, and what has already been delivered is tracked in `data/calendar-seen.json`, `data/todo-seen.json` and `data/mail-seen.json`. `npm run link-google -- --unlink` deletes all four; revoking pitwall at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) is a separate step. The server picks the link up on its next poll, without a restart.

A link made before pitwall asked for a service does not cover it, and the log says which one until `npm run link-google -- --force` replaces the grant.

**The link goes stale about weekly.** An OAuth client whose publishing status is **Testing** is issued refresh tokens that expire after seven days, so roughly once a week the log asks you to link again. Moving the client to **In production** removes that, but Gmail's read scope is one Google classes as restricted, and publishing with it means going through verification and a security assessment first.

Consent comes back to a loopback port, which a browser outside the container cannot reach — running the server in a devcontainer, set `PITWALL_OAUTH_PORT` to a port you have forwarded.

Every calendar ticked in Google Calendar's own sidebar is watched, and the reminder is the one on the event, so anything you have silenced there stays silent here. A reminder whose moment passed while the server was down is dropped rather than delivered late.

Every task list is watched, and consent asks to edit them as well as read them — ticking one off is a write, and Google has no narrower grant for it. A time of day set on a task is not readable through Google's API, so cards land at 09:00 instead — `PITWALL_TODO_DUE_HOUR` moves that. Everything already overdue arrives on the first morning after you link, and a morning that passed with the server down arrives when it comes back up.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PITWALL_HOST` | `127.0.0.1` | `npm start` sets `0.0.0.0` |
| `PITWALL_PORT` | `4477` | |
| `PITWALL_DATA` | `./data` | timeline, uploaded images, replies |
| `PITWALL_HOLD_SECONDS` | `300` | how long Cursor waits with nobody looking |
| `PITWALL_MAX_HOLD_SECONDS` | `1800` | how long a card stays answerable |
| `PITWALL_RETENTION_DAYS` | `30` | older entries are dropped at boot |
| `PITWALL_CALENDAR_IDS` | every ticked calendar | comma-separated ids, or `primary` |
| `PITWALL_CALENDAR_POLL_SECONDS` | `120` | how often Google is asked what changed |
| `PITWALL_CALENDAR_STALE_MINUTES` | `20` | how late a missed reminder may still arrive |
| `PITWALL_TODO_LISTS` | every list | comma-separated task list ids |
| `PITWALL_TODO_POLL_SECONDS` | `300` | how often Google is asked what changed |
| `PITWALL_TODO_DUE_HOUR` | `9` | the hour a due task lands on |
| `PITWALL_TODO_TIMEZONE` | your calendar's | which zone that hour is in |
| `PITWALL_MAIL_QUERY` | `in:inbox is:unread` | Gmail search syntax; what becomes a card |
| `PITWALL_MAIL_POLL_SECONDS` | `120` | how often Gmail is asked what is new |
| `PITWALL_MAIL_MAX_PER_POLL` | `20` | most cards one poll may add |
| `PITWALL_OAUTH_PORT` | any free port | where consent comes back |

## What it puts on your machine

| Path | |
| --- | --- |
| `~/.cursor/hooks/pitwall/`, `~/.claude/hooks/pitwall/` | copies of the hook scripts |
| `~/.cursor/hooks.json` | `stop` and `afterAgentResponse` entries |
| `~/.claude/settings.json` | `Stop`, `Notification` and `PreToolUse` entries |
| `<config>.bak.<timestamp>` | a backup of each file before it is edited |
| `./data` | the timeline itself |
| `./data/google-token.json` | the Google refresh token, readable only by you |

## Uninstall

```bash
npm run uninstall-hooks
```

This removes the copied scripts and the pitwall entries, and leaves the backups and `./data` alone. In a container with no checkout to run it from:

```bash
curl -fsSL https://raw.githubusercontent.com/ishikuro-shunsuke/pitwall/main/cleanup.sh | sh
```

## Development

```bash
npm run dev    # --watch
npm test       # end-to-end smoke test, installer test, and calendar, tasks and mail against a stubbed Google
```
