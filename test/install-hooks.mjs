#!/usr/bin/env node
/**
 * Installer tests against a throwaway $HOME.
 *
 * The generated commands must point at files that exist: shipping a config that
 * names a script the installer never copied is how the Claude notification hook
 * stayed broken. Every case here starts from a config that already holds
 * someone else's hooks, since that is what a real home directory looks like.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(ROOT, 'bin', 'install-hooks.mjs');

let passed = 0;
let failed = 0;

function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}
function fail(name, detail) {
  failed += 1;
  console.error(`  FAIL ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}
function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(name);
  else fail(name, { actual, expected });
}

const FOREIGN_CURSOR = { command: 'node ./my-own-hook.mjs', timeout: 30 };
const FOREIGN_CLAUDE = { hooks: [{ type: 'command', command: 'echo mine' }] };

async function makeHome() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'pitwall-install-'));
  await fsp.mkdir(path.join(home, '.cursor'), { recursive: true });
  await fsp.mkdir(path.join(home, '.claude'), { recursive: true });
  await fsp.writeFile(
    path.join(home, '.cursor', 'hooks.json'),
    JSON.stringify({ version: 1, hooks: { stop: [FOREIGN_CURSOR] } }, null, 2),
  );
  await fsp.writeFile(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ model: 'opus', hooks: { Stop: [FOREIGN_CLAUDE] } }, null, 2),
  );
  return home;
}

function run(home, args = [], env = {}) {
  const result = spawnSync(process.execPath, [INSTALLER, ...args], {
    env: { ...process.env, HOME: home, ...env },
    encoding: 'utf8',
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const cursorConfig = (home) => readJson(path.join(home, '.cursor', 'hooks.json'));
const claudeConfig = (home) => readJson(path.join(home, '.claude', 'settings.json'));
const isPitwall = (hook) => JSON.stringify(hook).includes('hooks/pitwall/');

/** Every .mjs a generated command names, resolved the way the runner will. */
function referencedScripts(home) {
  const found = [];
  const collect = (command, configDir) => {
    const match = /([\w./$-]*hooks\/pitwall\/[\w.-]+\.mjs)/.exec(command);
    if (!match) return;
    const raw = match[1].replace('$HOME', home);
    found.push(path.isAbsolute(raw) ? raw : path.resolve(configDir, raw));
  };

  const cursorDir = path.join(home, '.cursor');
  const cursor = cursorConfig(home).hooks || {};
  for (const list of Object.values(cursor)) {
    for (const hook of list || []) collect(hook.command || '', cursorDir);
  }
  const claudeDir = path.join(home, '.claude');
  const claude = claudeConfig(home).hooks || {};
  for (const groups of Object.values(claude)) {
    for (const group of groups || []) {
      for (const hook of group.hooks || []) collect(hook.command || '', claudeDir);
    }
  }
  return found;
}

async function main() {
  const homes = [];
  try {
    await cases(homes);
  } catch (error) {
    fail('unexpected', error.stack || error);
  } finally {
    await Promise.all(homes.map((home) => fsp.rm(home, { recursive: true, force: true })));
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function cases(homes) {

  // fresh install over an existing config
  {
    const home = await makeHome();
    homes.push(home);
    const first = run(home);
    if (first.code === 0) ok('install exits 0');
    else fail('install exits 0', first);

    const cursor = cursorConfig(home);
    const claude = claudeConfig(home);

    eq('cursor: foreign stop hook kept', cursor.hooks.stop[0], FOREIGN_CURSOR);
    eq('claude: foreign Stop hook kept', claude.hooks.Stop[0], FOREIGN_CLAUDE);
    eq('claude: unrelated settings kept', claude.model, 'opus');

    const events = [
      ['cursor.afterAgentResponse', cursor.hooks.afterAgentResponse],
      ['cursor.stop', cursor.hooks.stop],
      ['claude.Stop', claude.hooks.Stop],
      ['claude.Notification', claude.hooks.Notification],
    ];
    for (const [name, list] of events) {
      const count = (list || []).filter(isPitwall).length;
      if (count === 1) ok(`${name}: one pitwall entry`);
      else fail(`${name}: one pitwall entry`, { count, list });
    }

    // The regression that started this: a command naming a file nobody copied.
    const referenced = referencedScripts(home);
    if (referenced.length !== 4) {
      fail('every hook command was parsed', referenced);
    } else if (referenced.every((file) => fs.existsSync(file))) {
      ok('every referenced script exists on disk');
    } else {
      fail('every referenced script exists on disk', referenced.filter((f) => !fs.existsSync(f)));
    }

    // stdout is the only place the written paths are documented, so it has to
    // agree with what landed in the file.
    const printed = [...first.stdout.matchAll(/^\s+(?:added:)?\s+hooks\.\S+\s+(\{.*\})$/gm)]
      .map((m) => m[1]);
    if (printed.length !== 4) {
      fail('installer prints four added entries', printed);
    } else {
      const cursorRaw = fs.readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8');
      const claudeRaw = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
      const inFile = (json) => {
        const compact = JSON.stringify(JSON.parse(json));
        return [cursorRaw, claudeRaw].some(
          (raw) => JSON.stringify(JSON.parse(raw)).includes(compact.slice(1, -1)),
        );
      };
      if (printed.every(inFile)) ok('printed entries match the files');
      else fail('printed entries match the files', printed.filter((j) => !inFile(j)));
    }
  }

  // second run must not stack duplicates
  {
    const home = await makeHome();
    homes.push(home);
    run(home);
    run(home);
    const cursor = cursorConfig(home);
    const claude = claudeConfig(home);
    const counts = [
      cursor.hooks.stop.filter(isPitwall).length,
      cursor.hooks.afterAgentResponse.filter(isPitwall).length,
      claude.hooks.Stop.filter(isPitwall).length,
      claude.hooks.Notification.filter(isPitwall).length,
    ];
    eq('installing twice leaves one entry each', counts, [1, 1, 1, 1]);
    eq('cursor: foreign hook survives reinstall', cursor.hooks.stop[0], FOREIGN_CURSOR);
  }

  // uninstall
  {
    const home = await makeHome();
    homes.push(home);
    run(home);
    const out = run(home, ['--uninstall']);
    if (out.code === 0) ok('uninstall exits 0');
    else fail('uninstall exits 0', out);

    const cursor = cursorConfig(home);
    const claude = claudeConfig(home);
    eq('cursor: only the foreign hook remains', cursor.hooks.stop, [FOREIGN_CURSOR]);
    eq('claude: only the foreign hook remains', claude.hooks.Stop, [FOREIGN_CLAUDE]);
    eq('claude: unrelated settings survive uninstall', claude.model, 'opus');
    if (!cursor.hooks.afterAgentResponse) ok('cursor: emptied event removed');
    else fail('cursor: emptied event removed', cursor.hooks.afterAgentResponse);

    const dirs = [
      path.join(home, '.cursor', 'hooks', 'pitwall'),
      path.join(home, '.claude', 'hooks', 'pitwall'),
    ];
    if (dirs.every((dir) => !fs.existsSync(dir))) ok('script directories deleted');
    else fail('script directories deleted', dirs.filter((d) => fs.existsSync(d)));
  }

  // --devcontainer bakes the URL into every command
  {
    const home = await makeHome();
    homes.push(home);
    run(home, ['--devcontainer']);
    const commands = [
      ...Object.values(cursorConfig(home).hooks).flat().map((h) => h.command),
      ...Object.values(claudeConfig(home).hooks)
        .flat()
        .flatMap((g) => (g.hooks || []).map((h) => h.command)),
    ].filter((command) => command.includes('hooks/pitwall/'));
    const baked = commands.filter((c) => c.includes('http://host.docker.internal:4477'));
    eq('devcontainer: url baked into all four commands', baked.length, 4);
    const notify = commands.find((c) => c.includes('claude-notification.mjs'));
    if (notify?.startsWith('PITWALL_URL=')) ok('devcontainer: notification gets the url via env');
    else fail('devcontainer: notification gets the url via env', notify);
  }

  // A container runs hooks only; telling it to start a server is wrong, and
  // install.sh leaves no repo there to start one from.
  {
    const home = await makeHome();
    homes.push(home);
    const inside = run(home, ['--devcontainer'], { DEVCONTAINER: '1' });
    if (!/npm start/.test(inside.stdout)) ok('container: does not tell you to npm start');
    else fail('container: does not tell you to npm start', inside.stdout);
    if (inside.stdout.includes('ホスト側で pitwall を起動')) {
      ok('container: points at the host for the server');
    } else {
      fail('container: points at the host for the server', inside.stdout);
    }
    if (inside.stdout.includes('http://host.docker.internal:4477')) {
      ok('container: states where its hooks post');
    } else {
      fail('container: states where its hooks post', inside.stdout);
    }

    const outside = run(home, [], { DEVCONTAINER: '', REMOTE_CONTAINERS: '', CODESPACES: '' });
    if (fs.existsSync('/.dockerenv')) {
      ok('host case skipped (running inside a container)');
    } else if (/npm start/.test(outside.stdout)) {
      ok('host: tells you to npm start');
    } else {
      fail('host: tells you to npm start', outside.stdout);
    }
  }

  // --url and --devcontainer together is a usage error
  {
    const home = await makeHome();
    homes.push(home);
    const out = run(home, ['--devcontainer', '--url', 'http://x:1']);
    if (out.code === 1) ok('rejects --devcontainer with --url');
    else fail('rejects --devcontainer with --url', out);
  }

  // the hostname check: only inside a container, only when it does not resolve
  {
    const home = await makeHome();
    homes.push(home);
    const unresolvable = run(home, ['--url', 'http://pitwall-host.invalid:4477'], {
      DEVCONTAINER: '1',
    });
    if (unresolvable.stdout.includes('pitwall-host.invalid はこのコンテナから解決できない')) {
      ok('container + unresolvable host: prints the fix');
    } else {
      fail('container + unresolvable host: prints the fix', unresolvable.stdout);
    }
    if (unresolvable.stdout.includes('extra_hosts: ["pitwall-host.invalid:host-gateway"]')) {
      ok('the fix names the host that actually failed');
    } else {
      fail('the fix names the host that actually failed', unresolvable.stdout);
    }

    const resolvable = run(home, ['--url', 'http://localhost:4477'], { DEVCONTAINER: '1' });
    if (!resolvable.stdout.includes('解決できない')) ok('container + resolvable host: silent');
    else fail('container + resolvable host: silent', resolvable.stdout);

    // Outside a container the compose/runArgs advice would be wrong, so the
    // check has to stay quiet even though the name may not resolve.
    const onHost = run(home, ['--url', 'http://pitwall-host.invalid:4477'], {
      DEVCONTAINER: '',
      REMOTE_CONTAINERS: '',
      CODESPACES: '',
    });
    if (fs.existsSync('/.dockerenv')) {
      ok('host case skipped (running inside a container)');
    } else if (!onHost.stdout.includes('解決できない')) {
      ok('outside a container: no advice');
    } else {
      fail('outside a container: no advice', onHost.stdout);
    }
  }

}

main();
