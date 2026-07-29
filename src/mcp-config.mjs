/**
 * The Claude Desktop connector, worked out for the machine this runs on.
 *
 * Read by two callers that know different things: `npm run mcp-config`, run on
 * the machine the connector will be spawned from, and the Help panel, which can
 * only ever describe the machine the server is on. They share the working out so
 * the two cannot come to disagree about what to paste.
 */
import path from 'node:path';
import { ROOT } from './config.mjs';
import { inContainer } from '../hooks/lib.mjs';

const SCRIPT = path.join(ROOT, 'bin', 'pitwall-mcp.mjs');

const CONFIG_PATH = {
  darwin: '~/Library/Application Support/Claude/claude_desktop_config.json',
  win32: '%APPDATA%\\Claude\\claude_desktop_config.json',
  linux: '~/.config/Claude/claude_desktop_config.json',
};

/** Under WSL the app is on the Windows side, whatever this process reports. */
export function configPath() {
  if (process.env.WSL_DISTRO_NAME) return CONFIG_PATH.win32;
  return CONFIG_PATH[process.platform] || CONFIG_PATH.linux;
}

export function connector(url) {
  const distro = process.env.WSL_DISTRO_NAME || null;
  const command = distro
    // `-e` and a full path on purpose. Going through a login shell puts whatever
    // your profile prints into the middle of the JSON-RPC stream, and the
    // connector fails with nothing useful said about why.
    ? { command: 'wsl.exe', args: ['-d', distro, '-e', process.execPath, SCRIPT, '--url', url] }
    : { command: process.execPath, args: [SCRIPT, '--url', url] };
  return { mcpServers: { pitwall: command } };
}

/**
 * What the Help panel can say. A server inside a container knows only container
 * paths, and Claude Desktop cannot start a command in there, so there is nothing
 * to hand over — only where to go and work it out instead.
 */
export function connectorState(url) {
  const container = inContainer();
  return {
    container,
    distro: process.env.WSL_DISTRO_NAME || null,
    configPath: container ? null : configPath(),
    connector: container ? null : connector(url),
  };
}
