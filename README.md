# pitwall

One timeline for every coding agent that is waiting on you.

Cursor and Claude Code stop and wait for your input in windows you are not looking at. pitwall collects those moments into a single timeline in your browser, and delivers your reply back into the same chat or session. Link a Google account and your calendar reminders, due tasks and new mail arrive on the same timeline; hand over a Chatwork token and so do the messages and tasks with your name on them. Everything runs on your machine, with no dependencies beyond Node.js.

https://github.com/user-attachments/assets/942aed4a-8fb7-4f03-b8a2-f58dd02ed616

## Requirements

- Node.js 20.6+
- Cursor, Claude Code or Claude Desktop — any of them, or all three

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

Run this in the container, with the address the server answers on. Put it in `postCreateCommand` to get the hooks back on every rebuild:

```bash
curl -fsSL https://raw.githubusercontent.com/ishikuro-shunsuke/pitwall/main/install.sh \
  | sh -s -- --url https://pitwall.example.com
```

Where the address does not resolve in the container, the installer prints the setting to add.

On Docker Desktop, `--devcontainer` stands in for `--url http://host.docker.internal:4477`.

### Somewhere else on the network

```bash
npm run install-hooks -- --url http://192.168.1.10:4477
```

## Replying

**Cursor** stops the agent and waits for your reply. If nobody opens the composer it gives up after 5 minutes and the agent stops as usual; with the composer open it waits up to 30 minutes.

**Claude Code** holds nothing. The session stops the way it always does, so you can keep typing locally, and a reply sent from the card within 30 minutes wakes it up and continues from there. What you typed does not show up in the Claude Code UI — Claude quotes it once at the start of its reply.

A session gets one card, however many times it stops. Everything it says lands on that card in the order it said it, oldest at the top, and you answer the newest at the bottom — the questions it asks mid-session among them. The card keeps the place in the timeline it earned by waiting. Reply to it or box it and it is finished; what the session says next starts a new one.

A question Claude asks mid-session arrives as a card too, with its options, and so does a plan waiting to be accepted. Those are answered back in the session; the card is there so you know what is being asked.

Past the 30 minutes the reply box goes and the card stays on the timeline, unanswered. **Copy resume cmd** on a Claude Code card gives you the `claude --resume` line for that session, to run where it ran.

## Calls

A card that turns up while you are in another window rings the desktop; nothing is shown while pitwall is the window you are in. The browser asks the first time you click the page, and asks once — refused, turn notifications back on for this site in the browser's own settings. **Call me when a card arrives**, under the gear, switches them off again and says whether the browser is showing them. It is set per browser.

Notifications reach the desktop from a page on `localhost` or one served over `https`. Opened by the machine's address over plain `http`, the browser is not allowed to show them at all.

## Claude Desktop

Claude Desktop can ask through pitwall instead of stopping to ask in the chat, and your answer goes back into the same conversation. **Help**, in the top right, has the connector to copy and says which file it goes in — `claude_desktop_config.json`, under `~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows and `~/.config/Claude/` on Linux. Quit Claude Desktop and open it again once it is in.

Where the server is in a container, Help cannot say — every path it knows is a path inside that container, and Claude Desktop cannot start anything in there. Run this on the machine Claude Desktop is on instead, from a checkout there:

```bash
npm run mcp-config
```

The server can stay where it is, as long as its port is reachable from there.

Claude asks only when it decides to, so tell it to. Under **Settings → Profile**, in your personal preferences:

> When you need something from me — a decision between options, a detail you're missing, or the go-ahead before something you can't undo — call pitwall's `ask_user` tool instead of asking in the chat. If it comes back saying I haven't answered, call `wait_for_reply` with the id it gives you and keep waiting. If pitwall isn't reachable, just ask me here.

A card waits 5 minutes with nobody looking at it, and up to 30 with the composer open. Leaving one is not a failure: Claude is told nobody answered and carries on, saying what it assumed instead. **Box** tells it that sooner.

### On Windows, with pitwall in WSL

Run the server in WSL and the connector comes out in its `wsl.exe` form, naming your node binary by its full path. Leave it that way: going through a login shell breaks the connector, because whatever your shell profile prints lands in the middle of what Claude Desktop is reading.

## Google Calendar, Tasks and Gmail

A reminder set on an event arrives as a card at the minute the event asked for, carrying the time, the place, the call link and who else is coming. There is nothing to reply to; **Box** clears it.

One card each morning lists the whole day — every event on every calendar being watched, with its hours, its room and its call link, and under them everything still owed: tasks due today or already past, from Google Tasks and Chatwork alike. It lands at 07:00 in the account's own time zone rather than the server's, and `PITWALL_AGENDA_HOUR` moves that. A morning that passed with the server down arrives when it comes back up, until the day turns.

A task arrives on the morning it is due, and again every morning after that — or at the hour itself, where you gave it one in Google and it sits on the calendar grid. **Chequered** ticks it off in Google — the one button on the feed that changes anything outside pitwall. **Box** files the card away and leaves the task open, so it comes round again tomorrow.

Mail arrives as a card you can answer. **Radio in** sends the reply through Gmail, in the same thread, and archives the message; **Box** archives it without answering. Both only take it out of the inbox — nothing is deleted, and nothing is marked read.

First, in [Google Cloud Console](https://console.cloud.google.com/): enable the Google Calendar API, the Google Tasks API and the Gmail API, create an OAuth client of type **Desktop app**, and add your own address under **Audience → Test users**.

Then open the gear in the top right, paste the client id and secret it gives you, and press **Link a Google account**. Approving in the tab that opens is the whole of it — the panel says who you linked as once it has gone through. `npm run link-google` does the same from a terminal, and `npm run link-google -- --unlink` is still the way back out.

The pair is saved to `data/google-client.json` and the refresh token to `data/google-token.json`, both readable only by you; what has already been delivered is tracked in `data/calendar-seen.json`, `data/agenda-seen.json`, `data/todo-seen.json` and `data/mail-seen.json`. Unlinking deletes five of those six; revoking pitwall at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) is a separate step. The server picks a new link up on its next poll, without a restart.

A link made before pitwall asked for a service does not cover it, and the log says which one until `npm run link-google -- --force` replaces the grant.

**The link goes stale about weekly**, because a client left at publishing status **Testing** is issued refresh tokens that last seven days. Link again when the log asks. Moving the client to **In production** ends that, but Gmail's read scope is one Google classes as restricted, so publishing with it means verification and a security assessment first.

Consent comes back to a loopback port on the machine the server runs on, so link from a browser on that machine. Where the server is in a devcontainer, set `PITWALL_OAUTH_PORT` to a port you have forwarded.

Every calendar ticked in Google Calendar's own sidebar is watched, and the reminder is the one on the event, so anything you have silenced there stays silent here.

Every task list is watched, and consent asks to edit them as well as read them — ticking one off is a write, and Google has no narrower grant for it. The Tasks API drops the time of day, but a task given one is also a block on the calendar you own, and that is where pitwall reads it — so those cards land at their own hour and the rest at 09:00, which `PITWALL_TODO_DUE_HOUR` moves. The block itself stays off the diary and off the morning card's event list: the task is already there, with the button that ticks it off. Everything already overdue arrives on the first morning after you link, and a morning that passed with the server down arrives when it comes back up.

`PITWALL_MAIL_QUERY` decides which mail is worth a card, in Gmail's own search syntax — `in:inbox is:unread` by default, or something like `in:inbox is:unread -category:promotions` where the tabs are in use. Consent covers reading, sending and moving, but not deleting. The first poll after linking cards nothing; only mail that arrives afterwards reaches the feed.

## Chatwork

A message with your name on it arrives as a card you can answer — a mention, a reply to something you wrote, or anything at all in a one-to-one chat. A message to everyone does not. A room gets one card, and everything it says lands on it in the order it was said. **Radio in** posts your reply into the room, under the last message on the card; **Box** answers nothing. Both then read that room up to that message, which is what takes it off Chatwork's own badge, and reads everything older in the room with it.

A task assigned to you arrives on the morning it is due, and again every morning it stays open. **Chequered** ticks it off in Chatwork; **Box** files the card away and leaves the task open.

Issue a token from your own account — your name, top right in Chatwork, then **Service Integration → API Token** — and paste it into the gear in the top right of pitwall. It is checked against Chatwork before it is saved, so a token that will not work says so there and then, and cards start arriving on the next poll.

On a business plan, an administrator has to approve API use for the organisation before any token will work.

Nothing pitwall reads moves the unread badge; only the buttons on a card do. The first poll after the token arrives cards nothing, and what has been delivered since is tracked in `data/chatwork-seen.json` and `data/chatwork-task-seen.json`.

A deadline is a moment, and which day it falls on depends on where you are. Chatwork's API does not say where the account is, so it is read in this machine's zone unless `PITWALL_CHATWORK_TIMEZONE` says otherwise.

## Passing a card to later

**Blue flag** hands a card to an hour you name. It asks for two lines first, and will not send without both.

**First move** is what you open and what you type into it — `models/staging/loads.sql を開いて retention の行を書く`, not "look at the retention thing". **Out lap** is how far to go before the shape of the real job shows itself, which is a smaller thing than finishing. Both are at the top of the card when it comes back, above anything the card itself says, along with how many times you have now sent it on.

The card leaves the timeline meanwhile and waits in **Past entries**. A card due at seven with the server off until nine arrives at nine.

A Google task is the one this reaches outside pitwall for. The task is Google's, so **Chequered** goes through there and a new one takes its place on the day you picked, carrying both lines in its notes. The hours on offer are days for those cards: the Tasks API keeps the date and drops the rest.

## Projects

Every card says what it belongs to, in that project's colour, with the repository or list it came out of underneath.

A repository, a Google Tasks list, and a booking whose title starts `[acme-portal]` each make their project the first time they are seen — there are few of them and you made them on purpose. The prefix does not reach the card; the title under `acme-portal` is just `週次`.

A sender and a Chatwork room do not. They arrive by the hundred, so those cards say **No Project** and keep their service's colour until you say otherwise.

Press the name to move it. Pick one, write a new name and press enter, or take it out of every project with **どこにも入れない**. What moves is the repository, room or sender behind the card, so every other card it ever sent moves too, including the ones already filed away. Taking it out stays taken out — the next card from there does not quietly make the project again.

Spelling is the whole of the match: `acme-portal` and `Acme-Portal` are two projects. One left holding no cards at all is gone.

## Stints

Tick **Run the stint clock** under the gear and a bar runs across the top of the page for 25 minutes. When it empties the timeline goes out of sight and the page calls you in — two notes, and a desktop notification if you let the browser show them. Only the 25 run themselves: the five-minute stop starts when you press **Pit in**, the feed comes back on **Rejoin**, and while either of those is waiting the clock counts up to say how long it has been.

The clock asks for notifications the first time you tick the box. Where the browser will not show them (see **Calls**) the notes play alone. A tab in the background can be up to a minute late calling you.

The clock is kept in the browser you set it in, so a reload picks it up where it left off.

## Configuration

How the server runs. Which accounts it watches is set in the gear instead, and nothing is set in both places.

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
| `PITWALL_AGENDA_HOUR` | `7` | the hour the day's card lands on |
| `PITWALL_AGENDA_TIMEZONE` | your calendar's | which zone that hour is in |
| `PITWALL_TODO_LISTS` | every list | comma-separated task list ids |
| `PITWALL_TODO_POLL_SECONDS` | `300` | how often Google is asked what changed |
| `PITWALL_TODO_DUE_HOUR` | `9` | the hour a due task lands on |
| `PITWALL_TODO_TIMEZONE` | your calendar's | which zone that hour is in |
| `PITWALL_MAIL_QUERY` | `in:inbox is:unread` | Gmail search syntax; what becomes a card |
| `PITWALL_MAIL_POLL_SECONDS` | `60` | how often Gmail is asked what is new, which is also how long a new message waits |
| `PITWALL_MAIL_MAX_PER_POLL` | `20` | most cards one poll may add |
| `PITWALL_OAUTH_PORT` | any free port | where consent comes back |
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
| `./data/projects.json` | your projects, and what is filed under each |
| `./data/google-client.json`, `./data/google-token.json` | the OAuth client and its refresh token, readable only by you |

## Uninstall

```bash
npm run uninstall-hooks
```

This removes the copied scripts and the pitwall entries, and leaves the backups and `./data` alone. The `pitwall` entry in `claude_desktop_config.json` is yours to delete, since nothing here put it there. In a container with no checkout to run it from:

```bash
curl -fsSL https://raw.githubusercontent.com/ishikuro-shunsuke/pitwall/main/cleanup.sh | sh
```

## Development

```bash
npm run dev    # --watch
npm test       # end-to-end smoke test, installer test, the Claude Desktop connector, and calendar, tasks, mail and Chatwork against stubbed services
```
