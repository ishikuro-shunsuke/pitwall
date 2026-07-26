# pitwall

One timeline for every coding agent that is waiting on you.

Cursor and Claude Code stop and wait for your input in windows you are not looking at. pitwall collects those moments into a single timeline in your browser, and delivers your reply back into the same chat or session. Everything runs on your machine, with no dependencies beyond Node.js.

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

### Somewhere else on the network

```bash
npm run install-hooks -- --url http://192.168.1.10:4477
```

## Replying

**Cursor** stops the agent and waits for your reply. If nobody opens the composer it gives up after 5 minutes and the agent stops as usual; with the composer open it waits up to 30 minutes.

**Claude Code** holds nothing. The session stops the way it always does, so you can keep typing locally, and a reply sent from the card within 30 minutes wakes it up and continues from there. Once the same session stops again, the older card expires. What you typed does not show up in the Claude Code UI — Claude quotes it once at the start of its reply.

A question Claude asks mid-session arrives as a card too, with its options. That one is answered in the terminal; the card is there so you know what is being asked.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PITWALL_HOST` | `127.0.0.1` | `npm start` sets `0.0.0.0` |
| `PITWALL_PORT` | `4477` | |
| `PITWALL_DATA` | `./data` | timeline, uploaded images, replies |
| `PITWALL_HOLD_SECONDS` | `300` | how long Cursor waits with nobody looking |
| `PITWALL_MAX_HOLD_SECONDS` | `1800` | how long a card stays answerable |
| `PITWALL_RETENTION_DAYS` | `30` | older entries are dropped at boot |

## What it puts on your machine

| Path | |
| --- | --- |
| `~/.cursor/hooks/pitwall/`, `~/.claude/hooks/pitwall/` | copies of the hook scripts |
| `~/.cursor/hooks.json` | `stop` and `afterAgentResponse` entries |
| `~/.claude/settings.json` | `Stop`, `Notification` and `PreToolUse` entries |
| `<config>.bak.<timestamp>` | a backup of each file before it is edited |
| `./data` | the timeline itself |

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
npm test       # end-to-end smoke test and installer test
```
