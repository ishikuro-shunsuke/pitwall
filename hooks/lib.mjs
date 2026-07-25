import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

export function baseUrl() {
  const port = process.env.PITWALL_PORT || '4477';
  const host = process.env.PITWALL_HOST || '127.0.0.1';
  return process.env.PITWALL_URL || `http://${host}:${port}`;
}

/** Read entire stdin as UTF-8 (hooks receive JSON on stdin). */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function out(obj) {
  process.stdout.write(JSON.stringify(obj ?? {}));
}

export function failOpen() {
  out({});
  process.exit(0);
}

/**
 * Soft HTTP helper. Never throws to the agent: connection failures return null
 * so the hook can fail open and let the agent stop normally.
 */
export async function request(method, pathname, { body, timeoutMs = 1500 } = {}) {
  const url = `${baseUrl()}${pathname}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function git(cwd, args) {
  try {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    if (r.status !== 0) return null;
    return (r.stdout || '').trim();
  } catch {
    return null;
  }
}

export function detectRepo(cwdCandidates = []) {
  for (const cwd of cwdCandidates.filter(Boolean)) {
    const root = git(cwd, ['rev-parse', '--show-toplevel']);
    if (!root) continue;
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const remote = git(root, ['config', '--get', 'remote.origin.url']);
    const status = git(root, ['status', '--porcelain']);
    return {
      key: root.replace(/\\/g, '/'),
      name: path.basename(root),
      root,
      branch: branch || null,
      remote: remote || null,
      dirty: Boolean(status),
    };
  }
  const fallback = cwdCandidates.find(Boolean) || process.cwd();
  return {
    key: path.resolve(fallback).replace(/\\/g, '/'),
    name: path.basename(fallback) || 'unknown',
    root: path.resolve(fallback),
    branch: null,
    remote: null,
    dirty: false,
  };
}

export function detectHost(cwd) {
  return {
    platform: process.platform,
    wslDistro: process.env.WSL_DISTRO_NAME || null,
    cwd: cwd || process.cwd(),
  };
}

/**
 * Claude Code Stop payloads do not include the model id. Scan the transcript
 * JSONL from the end for the last assistant message.model.
 */
export function modelFromTranscript(transcriptPath) {
  if (!transcriptPath) return null;
  let expanded = transcriptPath;
  if (expanded.startsWith('~/')) expanded = path.join(os.homedir(), expanded.slice(2));
  let text;
  try {
    text = fs.readFileSync(expanded, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      const msg = row.message || row;
      if (msg?.role === 'assistant' && msg.model) return msg.model;
      if (row.type === 'assistant' && row.message?.model) return row.message.model;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

export function effortLevel(payload) {
  if (payload?.effort?.level) return payload.effort.level;
  if (typeof payload?.effort === 'string') return payload.effort;
  if (process.env.CLAUDE_EFFORT) return process.env.CLAUDE_EFFORT;
  return null;
}

export { ROOT };
