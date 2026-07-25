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
import dns from 'node:dns/promises';
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
// The notification hook takes no --url flag, so pass the URL through the env.
const notifyEnv = explicitUrl ? `PITWALL_URL=${JSON.stringify(explicitUrl)} ` : '';

function inContainer() {
  if (process.env.REMOTE_CONTAINERS || process.env.DEVCONTAINER || process.env.CODESPACES) {
    return true;
  }
  if (fs.existsSync('/.dockerenv')) return true;
  try {
    return /docker|containerd|kubepods/.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Only the machine running this knows whether it is in a container and whether
 * the hostname resolves, so decide it here instead of asking the reader to work
 * out which case they are in.
 */
async function checkHookUrl() {
  if (!explicitUrl || !inContainer()) return;
  const { hostname } = new URL(explicitUrl);
  try {
    await dns.lookup(hostname);
  } catch {
    console.log(`\n${hostname} はこのコンテナから解決できない。足してコンテナを作り直す:`);
    console.log('  devcontainer.json が dockerComposeFile を指しているなら、その compose の該当サービスに');
    console.log(`    extra_hosts: ["${hostname}:host-gateway"]`);
    console.log('  image / dockerFile を直接書いているなら、devcontainer.json に');
    console.log(`    "runArgs": ["--add-host=${hostname}:host-gateway"]`);
  }
}

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
  const added = [];

  if (uninstall) {
    data.hooks.afterAgentResponse = strip(data.hooks.afterAgentResponse);
    data.hooks.stop = strip(data.hooks.stop);
    if (!data.hooks.afterAgentResponse.length) delete data.hooks.afterAgentResponse;
    if (!data.hooks.stop.length) delete data.hooks.stop;
  } else {
    // Cursor runs user hooks with ~/.cursor as the working directory, so these
    // relative commands resolve correctly on any machine or container.
    const afterResponse = {
      command: `node ./hooks/pitwall/cursor-after-response.mjs${urlArgs}`,
      timeout: 60,
    };
    const stop = {
      command: `node ./hooks/pitwall/cursor-stop.mjs${urlArgs}`,
      timeout: HOOK_TIMEOUT,
      loop_limit: null,
    };
    data.hooks.afterAgentResponse = [...strip(data.hooks.afterAgentResponse), afterResponse];
    data.hooks.stop = [...strip(data.hooks.stop), stop];
    added.push(
      { at: 'hooks.afterAgentResponse[]', value: afterResponse },
      { at: 'hooks.stop[]', value: stop },
    );
  }

  writeJson(file, data);
  report('Cursor', file, scripts, bak, added);
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

  const added = [];

  if (uninstall) {
    data.hooks.Stop = stripGroups(data.hooks.Stop);
    data.hooks.Notification = stripGroups(data.hooks.Notification);
    if (!data.hooks.Stop?.length) delete data.hooks.Stop;
    if (!data.hooks.Notification?.length) delete data.hooks.Notification;
    if (!Object.keys(data.hooks).length) delete data.hooks;
  } else {
    // Claude Code does not run hooks from ~/.claude, so use $HOME instead of a
    // baked-in absolute path: the shell expands it per environment.
    const stop = {
      hooks: [{
        type: 'command',
        command: `node "$HOME/.claude/hooks/pitwall/claude-stop.mjs"${urlArgs}`,
        timeout: HOOK_TIMEOUT,
      }],
    };
    const notification = {
      hooks: [{
        type: 'command',
        command: `${notifyEnv}node "$HOME/.claude/hooks/pitwall/claude-notification.mjs"`,
        timeout: 10,
      }],
    };
    data.hooks.Stop = [...stripGroups(data.hooks.Stop), stop];
    data.hooks.Notification = [...stripGroups(data.hooks.Notification), notification];
    added.push(
      { at: 'hooks.Stop[]', value: stop },
      { at: 'hooks.Notification[]', value: notification },
    );
  }

  writeJson(file, data);
  report('Claude Code', file, scripts, bak, added);
}

/**
 * The config files belong to the user and already have their own hooks in them,
 * so show the entries appended rather than describing the edit elsewhere.
 */
function report(label, file, scripts, bak, added = []) {
  const verb = uninstall ? 'removed' : 'installed';
  console.log(`${verb} ${label} hooks`);
  console.log(`  config:  ${file}${bak ? `  (backup: ${bak})` : ''}`);
  console.log(
    `  scripts: ${scripts.dir}${scripts.files.length ? `  → ${scripts.files.join(', ')}` : '  (deleted)'}`,
  );
  const width = Math.max(0, ...added.map((entry) => entry.at.length));
  added.forEach((entry, i) => {
    const gutter = i === 0 ? '  added:  ' : '          ';
    console.log(`${gutter} ${entry.at.padEnd(width)}  ${JSON.stringify(entry.value)}`);
  });
}

try {
  installCursor();
  installClaude();
  if (!uninstall) {
    console.log('\nNext:');
    console.log('  1. Start pitwall:  npm start   (http://127.0.0.1:4477/)');
    console.log('  2. Restart Cursor / open a new Claude Code session so hooks reload.');
    if (explicitUrl) {
      console.log(`\nEvery agent using these hooks posts to ${explicitUrl}`);
    } else {
      console.log('\nFor DevContainer use: npm run install-hooks:devcontainer');
    }
    await checkHookUrl();
  }
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
