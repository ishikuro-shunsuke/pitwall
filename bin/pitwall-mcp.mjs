#!/usr/bin/env node
// stdout carries the JSON-RPC stream and nothing else, so anything that reaches
// for it by habit is sent to stderr instead.
console.log = (...args) => process.stderr.write(`${args.join(' ')}\n`);
console.info = console.log;

const { startMcp } = await import('../hooks/mcp.mjs');
startMcp();
