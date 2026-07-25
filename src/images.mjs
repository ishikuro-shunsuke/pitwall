import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.mjs';
import { storeImage } from './store.mjs';

const MIME_BY_EXT = {
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

const PATTERNS = [
  // ![alt](path "title")
  new RegExp(String.raw`!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)`, 'gi'),
  // <img src="path">
  new RegExp(String.raw`<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']`, 'gi'),
  // file:///abs/path.png
  new RegExp(String.raw`file://(/[^\s"'\`)<>]+\.(?:${EXT_GROUP}))`, 'gi'),
  // bare paths that contain a separator, in prose or backticks
  new RegExp(String.raw`((?:[A-Za-z]:)?[~.\w][\w.@+-]*(?:[/\\][^\s"'\`)<>|*?]+)+\.(?:${EXT_GROUP}))`, 'gi'),
];

function isImagePath(candidate) {
  return Object.hasOwn(MIME_BY_EXT, path.extname(candidate).toLowerCase());
}

/** Pulls every plausible image reference out of the message text, in order. */
export function extractImageRefs(text) {
  if (!text) return [];
  const found = [];
  const seen = new Set();

  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      let ref = match[1]?.trim();
      if (!ref) continue;
      ref = ref.replace(/^file:\/\//, '').replace(/[),.;]+$/, '');
      if (/^(https?|data):/i.test(ref)) continue;
      if (!isImagePath(ref)) continue;
      if (seen.has(ref)) continue;
      seen.add(ref);
      found.push(ref);
    }
  }
  return found;
}

function candidatePaths(ref, searchDirs) {
  const expanded = ref.startsWith('~/') ? path.join(os.homedir(), ref.slice(2)) : ref;
  if (path.isAbsolute(expanded)) return [expanded];
  return searchDirs.filter(Boolean).map((dir) => path.resolve(dir, expanded));
}

/**
 * Copies referenced images into pitwall's own store so the timeline keeps
 * showing what the agent saw, even after the pipeline overwrites the file.
 */
export async function collectImages(text, searchDirs) {
  const refs = extractImageRefs(text).slice(0, config.maxImagesPerEntry);
  const images = [];

  for (const ref of refs) {
    const resolved = candidatePaths(ref, searchDirs).find((candidate) => {
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
    try {
      const stored = await storeImage(resolved, { mime: MIME_BY_EXT[ext], ext });
      images.push({ ref, sourcePath: resolved, name: path.basename(resolved), ...stored });
    } catch (error) {
      images.push({ ref, sourcePath: resolved, missing: true, error: error.message });
    }
  }
  return images;
}

export function mimeForFile(filename) {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

export function mimeForExt(ext) {
  return MIME_BY_EXT[String(ext || '').toLowerCase()] ?? null;
}
