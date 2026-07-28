# pitwall

One timeline for every coding agent that is waiting on you.

Cursor and Claude Code stop and wait for your input in windows you are not looking at. pitwall collects those moments into a single timeline in your browser, and delivers your reply back into the same chat or session. Link a Google account and your calendar reminders, due tasks and new mail arrive on the same timeline; hand over a Chatwork token and so do the messages and tasks with your name on them. Everything runs on your machine, with no dependencies beyond Node.js.

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

Mail arrives as a card you can answer. **Radio in** sends the reply through Gmail, in the same thread, and archives the message; **Box** archives it without answering. Both only take it out of the inbox — nothing is deleted, and nothing is marked read.

First, in [Google Cloud Console](https://console.cloud.google.com/): enable the Google Calendar API, the Google Tasks API and the Gmail API, create an OAuth client of type **Desktop app**, and add your own address under **Audience → Test users**.

Then open the gear in the top right, paste the client id and secret it gives you, and press **Link a Google account**. Approving in the tab that opens is the whole of it — the panel says who you linked as once it has gone through. `npm run link-google` does the same from a terminal, and `npm run link-google -- --unlink` is still the way back out.

The pair is saved to `data/google-client.json` and the refresh token to `data/google-token.json`, both readable only by you; what has already been delivered is tracked in `data/calendar-seen.json`, `data/todo-seen.json` and `data/mail-seen.json`. Unlinking deletes four of those five; revoking pitwall at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) is a separate step. The server picks a new link up on its next poll, without a restart.

A link made before pitwall asked for a service does not cover it, and the log says which one until `npm run link-google -- --force` replaces the grant.

**The link goes stale about weekly.** An OAuth client whose publishing status is **Testing** is issued refresh tokens that expire after seven days, so roughly once a week the log asks you to link again. Moving the client to **In production** removes that, but Gmail's read scope is one Google classes as restricted, and publishing with it means going through verification and a security assessment first.

Consent comes back to a loopback port on the machine the server runs on, so link from a browser on that machine. Where the server is in a devcontainer, set `PITWALL_OAUTH_PORT` to a port you have forwarded.

Every calendar ticked in Google Calendar's own sidebar is watched, and the reminder is the one on the event, so anything you have silenced there stays silent here. A reminder whose moment passed while the server was down is dropped rather than delivered late.

Every task list is watched, and consent asks to edit them as well as read them — ticking one off is a write, and Google has no narrower grant for it. A time of day set on a task is not readable through Google's API, so cards land at 09:00 instead — `PITWALL_TODO_DUE_HOUR` moves that. Everything already overdue arrives on the first morning after you link, and a morning that passed with the server down arrives when it comes back up.

`PITWALL_MAIL_QUERY` decides which mail is worth a card, in Gmail's own search syntax — `in:inbox is:unread` by default, or something like `in:inbox is:unread -category:promotions` where the tabs are in use. Consent covers reading, sending and moving, but not deleting. The first poll after linking cards nothing: an inbox that filled up before pitwall existed is a backlog rather than news, so only what arrives afterwards reaches the feed.

## Chatwork

A message with your name on it arrives as a card you can answer — a mention, a reply to something you wrote, or anything at all in a one-to-one chat. A message to everyone does not. **Radio in** posts your reply into the room, under the message it answers; **Box** answers nothing. Both then read that room up to that message, which is what takes it off Chatwork's own badge, and reads everything older in the room with it.

A task assigned to you arrives on the morning it is due, and again every morning it stays open. **Chequered** ticks it off in Chatwork; **Box** files the card away and leaves the task open.

Issue a token from your own account — your name, top right in Chatwork, then **Service Integration → API Token** — and paste it into the gear in the top right of pitwall. It is checked against Chatwork before it is saved, so a token that will not work says so there and then, and cards start arriving on the next poll. `PITWALL_CHATWORK_TOKEN` does the same from the command line.

On a business plan, an administrator has to approve API use for the organisation before any token will work.

Nothing pitwall reads moves the unread badge; only the buttons on a card do. The first poll after the token arrives cards nothing — whatever is already waiting is a backlog rather than news — and what has been delivered since is tracked in `data/chatwork-seen.json` and `data/chatwork-task-seen.json`.

A deadline is a moment, and which day it falls on depends on where you are. Chatwork's API does not say where the account is, so it is read in this machine's zone unless `PITWALL_CHATWORK_TIMEZONE` says otherwise.

## Configuration

Anything set here wins over the same thing set in the gear, which then says where the value came from instead of offering to change it.

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
| `PITWALL_MAIL_POLL_SECONDS` | `60` | how often Gmail is asked what is new, which is also how long a new message waits |
| `PITWALL_MAIL_MAX_PER_POLL` | `20` | most cards one poll may add |
| `PITWALL_OAUTH_PORT` | any free port | where consent comes back |
| `PITWALL_CHATWORK_TOKEN` | none | the gear takes the same token |
| `PITWALL_CHATWORK_ROOMS` | every chat | comma-separated room ids |
| `PITWALL_CHATWORK_POLL_SECONDS` | `60` | how often Chatwork is asked what is new, which is also how long a message waits |
| `PITWALL_CHATWORK_MAX_PER_POLL` | `20` | most cards one poll may add |
| `PITWALL_CHATWORK_TASK_POLL_SECONDS` | `300` | how often tasks are asked for |
| `PITWALL_CHATWORK_TASK_DUE_HOUR` | `9` | the hour a due task lands on |
| `PITWALL_CHATWORK_TIMEZONE` | this machine's | which zone a deadline's day is read in |

## What it puts on your machine

| Path | |
| --- | --- |
| `~/.cursor/hooks/pitwall/`, `~/.claude/hooks/pitwall/` | copies of the hook scripts |
| `~/.cursor/hooks.json` | `stop` and `afterAgentResponse` entries |
| `~/.claude/settings.json` | `Stop`, `Notification`, `PreToolUse` and `PermissionRequest` entries |
| `<config>.bak.<timestamp>` | a backup of each file before it is edited |
| `./data` | the timeline itself |
| `./data/settings.json` | what the gear was given, readable only by you |
| `./data/google-client.json`, `./data/google-token.json` | the OAuth client and its refresh token, readable only by you |

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
npm test       # end-to-end smoke test, installer test, and calendar, tasks, mail and Chatwork against stubbed services
```
