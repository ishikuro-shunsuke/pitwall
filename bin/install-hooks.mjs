#!/usr/bin/env node
/**
 * Install the pitwall hooks into ~/.cursor and ~/.claude.
 *
 * The scripts are *copied* into each agent's own config directory rather than
 * referenced in place, and the generated commands use paths relative to that
 * directory instead of absolute paths into this repo. That is what makes the
 * same configuration work inside a DevContainer, where $HOME belongs to a
 * different user and this repo is not mounted at all.
 *
 * Usage:
 *   node bin/install-hooks.mjs
 *   node bin/install-hooks.mjs --uninstall
 *   node bin/install-hooks.mjs --devcontainer
 *   node bin/install-hooks.mjs --url http://example:4477
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_SRC = path.join(ROOT, 'hooks');
const uninstall = process.argv.includes('--uninstall');
const DEVCONTAINER_URL = 'http://host.docker.internal:4477';

const HOOK_TIMEOUT = 1920; // must exceed maxHoldSeconds (1800)
const SUBDIR = path.join('hooks', 'pitwall');

function urlFlag() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') return argv[i + 1] ?? null;
    if (argv[i].startsWith('--url=')) return argv[i].slice('--url='.length);
  }
  return null;
}

const fromUrl = urlFlag();
const fromDevcontainer = process.argv.includes('--devcontainer');
if (fromUrl && fromDevcontainer) {
  console.error('Use either --devcontainer or --url, not both.');
  process.exit(1);
}
const explicitUrl = fromUrl || (fromDevcontainer ? DEVCONTAINER_URL : null);
const urlArgs = explicitUrl ? ` --url ${JSON.stringify(explicitUrl)}` : '';
// Notification is a shell script that reads PITWALL_URL; bake it into the command.
const notifyEnv = explicitUrl ? `PITWALL_URL=${JSON.stringify(explicitUrl)} ` : '';

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const bak = `${file}.bak.${Date.now()}`;
  fs.copyFileSync(file, bak);
  return bak;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return structuredClone(fallback);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${file}: ${error.message}`);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function copyScripts(configDir, files) {
  const target = path.join(configDir, SUBDIR);
  if (uninstall) {
    fs.rmSync(target, { recursive: true, force: true });
    return { dir: target, files: [] };
  }
  fs.mkdirSync(target, { recursive: true });
  const copied = [];
  for (const name of ['lib.mjs', ...files]) {
    const from = path.join(HOOK_SRC, name);
    const to = path.join(target, name);
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o755);
    copied.push(name);
  }
  return { dir: target, files: copied };
}

const isPitwallCommand = (command) =>
  typeof command === 'string' && command.includes('hooks/pitwall/');

function installCursor() {
  const configDir = path.join(os.homedir(), '.cursor');
  const scripts = copyScripts(configDir, ['cursor-stop.mjs', 'cursor-after-response.mjs']);
  const file = path.join(configDir, 'hooks.json');
  const bak = backup(file);
  const data = readJson(file, { version: 1, hooks: {} });
  data.version = data.version || 1;
  data.hooks = data.hooks || {};

  const strip = (list) => (list || []).filter((h) => !isPitwallCommand(h.command));

  if (uninstall) {
    data.hooks.afterAgentResponse = strip(data.hooks.afterAgentResponse);
    data.hooks.stop = strip(data.hooks.stop);
    if (!data.hooks.afterAgentResponse.length) delete data.hooks.afterAgentResponse;
    if (!data.hooks.stop.length) delete data.hooks.stop;
  } else {
    // Cursor runs user hooks with ~/.cursor as the working directory, so these
    // relative commands resolve correctly on any machine or container.
    data.hooks.afterAgentResponse = [
      ...strip(data.hooks.afterAgentResponse),
      { command: `node ./hooks/pitwall/cursor-after-response.mjs${urlArgs}`, timeout: 60 },
    ];
    data.hooks.stop = [
      ...strip(data.hooks.stop),
      {
        command: `node ./hooks/pitwall/cursor-stop.mjs${urlArgs}`,
        timeout: HOOK_TIMEOUT,
        loop_limit: null,
      },
    ];
  }

  writeJson(file, data);
  report('Cursor', file, scripts, bak);
}

function installClaude() {
  const configDir = path.join(os.homedir(), '.claude');
  const scripts = copyScripts(configDir, ['claude-stop.mjs', 'claude-notification.mjs']);
  const file = path.join(configDir, 'settings.json');
  const bak = backup(file);
  const data = readJson(file, {});
  data.hooks = data.hooks || {};

  const stripGroups = (groups) =>
    (groups || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isPitwallCommand(h.command)) }))
      .filter((g) => g.hooks.length > 0);

  if (uninstall) {
    data.hooks.Stop = stripGroups(data.hooks.Stop);
    data.hooks.Notification = stripGroups(data.hooks.Notification);
    if (!data.hooks.Stop?.length) delete data.hooks.Stop;
    if (!data.hooks.Notification?.length) delete data.hooks.Notification;
    if (!Object.keys(data.hooks).length) delete data.hooks;
  } else {
    // Claude Code does not run hooks from ~/.claude, so use $HOME instead of a
    // baked-in absolute path: the shell expands it per environment.
    data.hooks.Stop = [
      ...stripGroups(data.hooks.Stop),
      {
        hooks: [{
          type: 'command',
          command: `node "$HOME/.claude/hooks/pitwall/claude-stop.mjs"${urlArgs}`,
          timeout: HOOK_TIMEOUT,
        }],
      },
    ];
    data.hooks.Notification = [
      ...stripGroups(data.hooks.Notification),
      {
        hooks: [{
          type: 'command',
          command: `${notifyEnv}node "$HOME/.claude/hooks/pitwall/claude-notification.mjs"`,
          timeout: 10,
        }],
      },
    ];
  }

  writeJson(file, data);
  report('Claude Code', file, scripts, bak);
}

// The report is what the user learns from, so print the paths actually written
// rather than documenting them somewhere that can fall out of step.
function report(label, file, scripts, bak) {
  const verb = uninstall ? 'removed' : 'installed';
  console.log(`${verb} ${label} hooks`);
  console.log(`  config:  ${file}${bak ? `  (backup: ${bak})` : ''}`);
  console.log(
    `  scripts: ${scripts.dir}${scripts.files.length ? `  → ${scripts.files.join(', ')}` : '  (deleted)'}`,
  );
}

try {
  installCursor();
  installClaude();
  if (!uninstall) {
    console.log('\nNext:');
    console.log('  1. Start pitwall:  npm start   (http://127.0.0.1:4477/)');
    console.log('  2. Restart Cursor / open a new Claude Code session so hooks reload.');
    if (fromDevcontainer) {
      console.log(`\nDevContainer mode: hooks bake in --url ${DEVCONTAINER_URL}`);
      console.log('Mount ~/.cursor and ~/.claude into the container.');
      console.log('Also add extra_hosts: ["host.docker.internal:host-gateway"] if needed.');
      console.log('Host-local agents will also use that URL (Docker Desktop usually resolves it).');
    } else if (!explicitUrl) {
      console.log('\nFor DevContainer use: npm run install-hooks:devcontainer');
    }
  }
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
