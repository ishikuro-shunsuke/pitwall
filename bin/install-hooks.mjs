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
import { inContainer } from '../hooks/lib.mjs';

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

// Colour only when a terminal is reading; piped output has to stay parseable.
const colour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (text) => (colour ? `[${code}m${text}[0m` : String(text));
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const red = paint('31');
const cyan = paint('36');
const yellow = paint('33');

const tilde = (target) =>
  target.startsWith(os.homedir()) ? target.replace(os.homedir(), '~') : target;

/** The command plus its remaining options, for both config shapes. */
function hookFields(value) {
  const inner = Array.isArray(value.hooks) ? value.hooks[0] : value;
  const { command, type, ...rest } = inner;
  // The matcher sits on the group, not the hook, and it is half of what a
  // PreToolUse entry does.
  if (value.matcher) rest.matcher = value.matcher;
  const meta = Object.entries(rest)
    .map(([key, val]) => `${key} ${val === null ? 'null' : val}`)
    .join(', ');
  return { command, meta };
}

/**
 * `Open in Cursor` hands the editor a path, and every path this container can
 * see is one the editor cannot. The mount is described in devcontainer.json and
 * nowhere else, so the two roots have to be read out of there.
 */
function checkWorkspaceMapping() {
  if (!inContainer()) return;
  if (process.env.PITWALL_HOST_ROOT || process.env.LOCAL_WORKSPACE_FOLDER) return;
  console.log(`\n${yellow('!')} カードの ${bold('Open in Cursor')} はまだ出ない。devcontainer.json に足して作り直す:`);
  console.log(`    ${cyan('"remoteEnv": {')}`);
  console.log(`    ${cyan('  "PITWALL_HOST_ROOT": "${localWorkspaceFolder}",')}`);
  console.log(`    ${cyan('  "PITWALL_CONTAINER_ROOT": "${containerWorkspaceFolder}"')}`);
  console.log(`    ${cyan('}')}`);
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
    console.log(
      `\n${yellow('!')} ${bold(hostname)} をこのコンテナから解決できない。足してコンテナを作り直す:`,
    );
    console.log(dim('  devcontainer.json が dockerComposeFile を指しているなら、その compose の該当サービスに'));
    console.log(`    ${cyan(`extra_hosts: ["${hostname}:host-gateway"]`)}`);
    console.log(dim('  image / dockerFile を直接書いているなら、devcontainer.json に'));
    console.log(`    ${cyan(`"runArgs": ["--add-host=${hostname}:host-gateway"]`)}`);
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
  // The directory is pitwall's own, and a script an earlier version copied here
  // is referenced by nothing once the config is rewritten.
  for (const name of fs.readdirSync(target)) {
    if (!copied.includes(name)) fs.rmSync(path.join(target, name), { recursive: true, force: true });
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
  const scripts = copyScripts(configDir, [
    'claude-stop.mjs',
    'claude-notification.mjs',
    'claude-dialog.mjs',
    'claude-permission.mjs',
  ]);
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
    data.hooks.PreToolUse = stripGroups(data.hooks.PreToolUse);
    data.hooks.PermissionRequest = stripGroups(data.hooks.PermissionRequest);
    if (!data.hooks.Stop?.length) delete data.hooks.Stop;
    if (!data.hooks.Notification?.length) delete data.hooks.Notification;
    if (!data.hooks.PreToolUse?.length) delete data.hooks.PreToolUse;
    if (!data.hooks.PermissionRequest?.length) delete data.hooks.PermissionRequest;
    if (!Object.keys(data.hooks).length) delete data.hooks;
  } else {
    // Claude Code does not run hooks from ~/.claude, so use $HOME instead of a
    // baked-in absolute path: the shell expands it per environment.
    // asyncRewake lets the session stop while the hook keeps waiting, and wakes
    // it again when the hook exits 2. Without it the session would be held for
    // as long as the entry sits unanswered in the browser.
    const stop = {
      hooks: [{
        type: 'command',
        command: `node "$HOME/.claude/hooks/pitwall/claude-stop.mjs"${urlArgs}`,
        timeout: HOOK_TIMEOUT,
        asyncRewake: true,
        rewakeMessage: 'pitwall:',
        rewakeSummary: 'pitwall への返信',
      }],
    };
    const notification = {
      hooks: [{
        type: 'command',
        command: `${notifyEnv}node "$HOME/.claude/hooks/pitwall/claude-notification.mjs"`,
        timeout: 10,
      }],
    };
    // A question and a plan are both put to you mid-turn, so Stop never runs for
    // either. This one fires before the dialog opens and only copies it onto the
    // timeline: it decides nothing, holds nothing, and the answer is still given
    // in the terminal.
    const dialog = {
      matcher: 'AskUserQuestion|ExitPlanMode',
      hooks: [{
        type: 'command',
        command: `node "$HOME/.claude/hooks/pitwall/claude-dialog.mjs"${urlArgs}`,
        timeout: 10,
      }],
    };
    // `permission_prompt` only reaches a Notification hook from the terminal
    // dialog, so a session run from an editor never sends one. This fires
    // wherever the decision is made, and loses the race to the dialog it is
    // reporting rather than deciding anything itself.
    const permission = {
      hooks: [{
        type: 'command',
        command: `node "$HOME/.claude/hooks/pitwall/claude-permission.mjs"${urlArgs}`,
        timeout: 10,
      }],
    };
    data.hooks.Stop = [...stripGroups(data.hooks.Stop), stop];
    data.hooks.Notification = [...stripGroups(data.hooks.Notification), notification];
    data.hooks.PreToolUse = [...stripGroups(data.hooks.PreToolUse), dialog];
    data.hooks.PermissionRequest = [...stripGroups(data.hooks.PermissionRequest), permission];
    added.push(
      { at: 'hooks.Stop[]', value: stop },
      { at: 'hooks.Notification[]', value: notification },
      { at: 'hooks.PreToolUse[]', value: dialog },
      { at: 'hooks.PermissionRequest[]', value: permission },
    );
  }

  writeJson(file, data);
  report('Claude Code', file, scripts, bak, added);
}

/**
 * These are the user's own files, so show the change as a diff under the path it
 * happened in: the entry alone does not say where it landed.
 */
function report(label, file, scripts, bak, added = []) {
  const mark = uninstall ? red('-') : green('+');
  console.log(
    `\n${uninstall ? red('-') : green('✓')} ${bold(label)}  ${dim(uninstall ? 'フックを削除' : 'フックを登録')}`,
  );

  console.log(`  ${tilde(file)}${bak ? `  ${dim(`backup: ${path.basename(bak)}`)}` : ''}`);
  if (uninstall) {
    console.log(`    ${mark} ${dim('pitwall のエントリ')}`);
  } else {
    const rows = added.map((entry) => ({ at: entry.at, ...hookFields(entry.value) }));
    const width = Math.max(0, ...rows.map((row) => row.at.length));
    for (const row of rows) {
      console.log(`    ${mark} ${row.at.padEnd(width)}  ${dim(row.meta)}`);
      console.log(`        ${cyan(row.command)}`);
    }
  }

  console.log(`  ${tilde(scripts.dir)}/`);
  console.log(
    scripts.files.length
      ? `    ${mark} ${dim(scripts.files.join(', '))}`
      : `    ${mark} ${dim('ディレクトリごと削除')}`,
  );
}

try {
  installCursor();
  installClaude();
  if (!uninstall) {
    // A container is a client: it has no repo to start a server from, and the
    // timeline it posts to lives on the host.
    console.log(`\n${bold('次にやること')}`);
    if (inContainer()) {
      console.log(`  1. ホスト側で pitwall を起動しておく${dim('（このコンテナでは起動しない）')}`);
      console.log(`     ${dim('このコンテナのフックの送信先:')} ${cyan(explicitUrl || 'http://127.0.0.1:4477')}`);
    } else if (explicitUrl) {
      console.log(`  1. ${cyan('npm start')} で起動する  ${dim(`フックの送信先: ${explicitUrl}`)}`);
    } else {
      console.log(`  1. ${cyan('npm start')} で起動する  ${dim('→ http://127.0.0.1:4477/')}`);
    }
    console.log('  2. Cursor は再起動、Claude Code は新しいセッションを開くとフックが読み込まれる');
    if (!explicitUrl && !inContainer()) {
      console.log(`\n${dim('コンテナや別のマシンから送るなら:')} ${cyan('npm run install-hooks -- --url <サーバのURL>')}`);
      console.log(`${dim('Docker Desktop のコンテナからホストへは:')} ${cyan('npm run install-hooks:devcontainer')}`);
    }
    await checkHookUrl();
    checkWorkspaceMapping();
  }
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
