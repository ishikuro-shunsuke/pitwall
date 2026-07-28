#!/usr/bin/env node
/**
 * Print the Claude Desktop connector for this machine. Writes nothing.
 *
 * Claude Desktop is usually not on the filesystem this runs on — on Windows it
 * reads a config in %APPDATA% while pitwall sits in WSL — so the file is left
 * for you to edit, and the only hard part, which command actually reaches
 * pitwall from where Claude Desktop is, is what gets worked out here.
 */
import path from 'node:path';
import { ROOT, baseUrl, inContainer } from '../hooks/lib.mjs';

const script = path.join(ROOT, 'bin', 'pitwall-mcp.mjs');
const url = baseUrl();
const distro = process.env.WSL_DISTRO_NAME || null;

const say = (line = '') => process.stderr.write(`${line}\n`);

const CONFIG_PATH = {
  darwin: '~/Library/Application Support/Claude/claude_desktop_config.json',
  win32: '%APPDATA%\\Claude\\claude_desktop_config.json',
  linux: '~/.config/Claude/claude_desktop_config.json',
};

// Under WSL the app is on the Windows side of the boundary, whatever this
// process reports about itself.
const configPath = distro ? CONFIG_PATH.win32 : CONFIG_PATH[process.platform] || CONFIG_PATH.linux;

const command = distro
  // `-e` and a full path on purpose. Going through a login shell puts whatever
  // your profile prints into the middle of the JSON-RPC stream, and the
  // connector fails with nothing useful said about why.
  ? { command: 'wsl.exe', args: ['-d', distro, '-e', process.execPath, script, '--url', url] }
  : { command: process.execPath, args: [script, '--url', url] };

if (inContainer()) {
  say('This is running inside a container, and Claude Desktop cannot start a');
  say('command in here. Run this from a checkout on the machine Claude Desktop');
  say('is on; the server can stay where it is, as long as its port is reachable.');
  say();
}

say(`Put this in ${configPath}, then quit Claude Desktop and open it again.`);
say('If the file already has an "mcpServers" object, add the "pitwall" entry to it.');
say();

process.stdout.write(`${JSON.stringify({ mcpServers: { pitwall: command } }, null, 2)}\n`);

say();
say(`It will look for pitwall at ${url}.`);
if (distro) say(`Start pitwall in WSL (${distro}), not in a devcontainer, or it reaches nothing.`);
