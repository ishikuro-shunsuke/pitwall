#!/usr/bin/env node
/**
 * Print the Claude Desktop connector for this machine. Writes nothing.
 *
 * The same thing the Help panel shows, for when the panel cannot say it: the
 * server is in a container, or somewhere else entirely, and what has to be
 * described is the machine you are typing this on.
 */
import { baseUrl, inContainer } from '../hooks/lib.mjs';
import { configPath, connector } from '../src/mcp-config.mjs';

const url = baseUrl();
const say = (line = '') => process.stderr.write(`${line}\n`);

if (inContainer()) {
  say('This is running inside a container, and Claude Desktop cannot start a');
  say('command in here. Run this from a checkout on the machine Claude Desktop');
  say('is on; the server can stay where it is, as long as its port is reachable.');
  say();
}

say(`Put this in ${configPath()}, then quit Claude Desktop and open it again.`);
say('If the file already has an "mcpServers" object, add the "pitwall" entry to it.');
say();

process.stdout.write(`${JSON.stringify(connector(url), null, 2)}\n`);

say();
say(`It will look for pitwall at ${url}.`);
if (process.env.WSL_DISTRO_NAME) {
  say(`Start pitwall in WSL (${process.env.WSL_DISTRO_NAME}), not in a devcontainer, or it reaches nothing.`);
}
