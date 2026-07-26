import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  host: process.env.PITWALL_HOST || '127.0.0.1',
  port: num(process.env.PITWALL_PORT, 4477),
  dataDir: process.env.PITWALL_DATA
    ? path.resolve(process.env.PITWALL_DATA)
    : path.join(ROOT, 'data'),

  /**
   * Hybrid hold: idle wait window for an agent that is being held. If nobody
   * opens the composer, it is released after this many seconds and the entry
   * becomes `expired`.
   */
  holdSeconds: num(process.env.PITWALL_HOLD_SECONDS, 300),

  /**
   * Maximum total hold from entry creation, even with heartbeats.
   * Hook runner timeout must be larger than this (see install-hooks).
   */
  maxHoldSeconds: num(process.env.PITWALL_MAX_HOLD_SECONDS, 1800),

  /** Entries older than this are pruned from disk on boot. */
  retentionDays: num(process.env.PITWALL_RETENTION_DAYS, 30),

  maxBodyChars: num(process.env.PITWALL_MAX_BODY_CHARS, 40_000),
  maxImagesPerEntry: num(process.env.PITWALL_MAX_IMAGES, 12),
  maxImageBytes: num(process.env.PITWALL_MAX_IMAGE_BYTES, 32 * 1024 * 1024),
};

/**
 * Cursor's stop hook holds the agent for as long as it waits, so an entry
 * nobody is looking at has to let go early. Claude's hook waits in the
 * background with the session already stopped, where nothing is being held —
 * so it stays answerable for the whole window.
 */
export function softHoldSeconds(agent) {
  return agent === 'claude' ? config.maxHoldSeconds : config.holdSeconds;
}

export const paths = {
  entries: path.join(config.dataDir, 'entries.json'),
  images: path.join(config.dataDir, 'images'),
  responses: path.join(config.dataDir, 'responses'),
  public: path.join(ROOT, 'public'),
  deeplink: path.join(ROOT, 'src', 'deeplink.mjs'),
};
