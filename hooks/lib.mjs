import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

function urlFromArgv() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') return argv[i + 1] || null;
    if (argv[i].startsWith('--url=')) return argv[i].slice('--url='.length) || null;
  }
  return null;
}

/**
 * The installer bakes the destination into each hook command, so `--url` wins:
 * it was written for the machine the hook runs on. Inside a container the
 * default would be 127.0.0.1, where nothing is listening.
 */
export function baseUrl() {
  const explicit = urlFromArgv() || process.env.PITWALL_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const port = process.env.PITWALL_PORT || '4477';
  const host = process.env.PITWALL_HOST || '127.0.0.1';
  return `http://${host}:${port}`;
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

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

const EXT_GROUP = 'png|jpe?g|gif|webp|avif|bmp|svg|tiff?';

const IMAGE_PATTERNS = [
  new RegExp(String.raw`!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)`, 'gi'),
  new RegExp(String.raw`<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']`, 'gi'),
  new RegExp(String.raw`file://(/[^\s"'\`)<>]+\.(?:${EXT_GROUP}))`, 'gi'),
  // The leading slash of an absolute path belongs to the ref — without it
  // /tmp/shot.png is looked up relative to the repo and comes out missing.
  new RegExp(String.raw`((?:[A-Za-z]:)?[/\\~.\w][\w.@+-]*(?:[/\\][^\s"'\`)<>|*?]+)+\.(?:${EXT_GROUP}))`, 'gi'),
];

export function extractImageRefs(text) {
  if (!text) return [];
  const found = [];
  const seen = new Set();

  for (const pattern of IMAGE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      let ref = match[1]?.trim();
      if (!ref) continue;
      ref = ref.replace(/^file:\/\//, '').replace(/[),.;]+$/, '');
      if (/^(https?|data):/i.test(ref)) continue;
      // The tail of a URL reads as an absolute path once the scheme is cut off.
      if (/^(?:[A-Za-z]+:)?\/\//.test(ref)) continue;
      if (!Object.hasOwn(IMAGE_MIME, path.extname(ref).toLowerCase())) continue;
      if (seen.has(ref)) continue;
      seen.add(ref);
      found.push(ref);
    }
  }
  return found;
}

async function imageInStore(filename) {
  try {
    const res = await fetch(`${baseUrl()}/api/hooks/images/${filename}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(1500),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function putImage(sha, ext, buffer, mime) {
  try {
    const res = await fetch(
      `${baseUrl()}/api/hooks/images?sha=${sha}&ext=${encodeURIComponent(ext)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': mime },
        body: buffer,
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Resolve image references against the agent's own filesystem and push the
 * bytes to pitwall. Reading happens here, not on the server, because a
 * container path like /workspaces/... does not exist on the host.
 */
export async function uploadImages(text, searchDirs, { max = 12, maxBytes = 32 * 1024 * 1024 } = {}) {
  const refs = extractImageRefs(text).slice(0, max);
  const dirs = searchDirs.filter(Boolean);
  const images = [];

  for (const ref of refs) {
    const expanded = ref.startsWith('~/') ? path.join(os.homedir(), ref.slice(2)) : ref;
    const candidates = path.isAbsolute(expanded)
      ? [expanded]
      : dirs.map((dir) => path.resolve(dir, expanded));

    const resolved = candidates.find((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (!resolved) {
      images.push({ ref, missing: true });
      continue;
    }

    const ext = path.extname(resolved).toLowerCase();
    const mime = IMAGE_MIME[ext];
    const name = path.basename(resolved);

    let buffer;
    try {
      if (fs.statSync(resolved).size > maxBytes) {
        images.push({ ref, sourcePath: resolved, name, missing: true, error: 'too large' });
        continue;
      }
      buffer = fs.readFileSync(resolved);
    } catch (error) {
      images.push({ ref, sourcePath: resolved, name, missing: true, error: error.message });
      continue;
    }

    const sha = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
    const filename = `${sha}${ext}`;
    const base = { ref, sourcePath: resolved, name, mime, bytes: buffer.length };

    if (await imageInStore(filename)) {
      images.push({ ...base, filename, url: `/images/${filename}` });
      continue;
    }
    const stored = await putImage(sha, ext, buffer, mime);
    if (stored?.url) images.push({ ...base, filename, url: stored.url });
    else images.push({ ...base, missing: true, error: 'upload failed' });
  }
  return images;
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
    return {
      key: root.replace(/\\/g, '/'),
      name: path.basename(root),
      root,
      branch: branch || null,
      remote: remote || null,
    };
  }
  const fallback = cwdCandidates.find(Boolean) || process.cwd();
  return {
    key: path.resolve(fallback).replace(/\\/g, '/'),
    name: path.basename(fallback) || 'unknown',
    root: path.resolve(fallback),
    branch: null,
    remote: null,
  };
}

export function inContainer() {
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
 * A container reports the paths it can see, which is not the filesystem the
 * editor opens. Only the devcontainer knows both ends of its own mount, so the
 * two roots are passed in through `remoteEnv`; without them the card has no
 * place to point and says so by carrying no link.
 */
export function detectHost(cwd) {
  const container = inContainer();
  return {
    platform: process.platform,
    wslDistro: process.env.WSL_DISTRO_NAME || null,
    cwd: cwd || process.cwd(),
    container,
    containerRoot: (container && process.env.PITWALL_CONTAINER_ROOT) || null,
    hostRoot: (container && (process.env.PITWALL_HOST_ROOT || process.env.LOCAL_WORKSPACE_FOLDER)) || null,
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

/**
 * Claude Code writes a Stop-time `ai-title` row to the transcript and
 * regenerates it as the conversation evolves, so the last one is the
 * freshest summary of what the session is about.
 */
export function sessionTitle(transcriptPath) {
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
      if (row.type === 'ai-title' && row.aiTitle) return row.aiTitle;
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
