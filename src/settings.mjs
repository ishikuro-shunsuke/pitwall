/**
 * Whose accounts these are.
 *
 * Which Chatwork account, which Google account: that is yours to say, and it
 * is said in one place — the panel, writing here. The environment says how the
 * server runs, which is a different question with a different answer, and
 * nothing is settable in both. A value with two homes needs a rule about which
 * one wins, and then the rule needs explaining every time somebody reads it
 * back and finds the other one.
 *
 * Secrets go through here in one direction. What is saved is read back by the
 * pollers and never by a browser: the panel is told that a token is set and
 * never told what it is, because the page it is on is served to whatever can
 * reach the port.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { config, paths } from './config.mjs';

/** Read once and kept, so a poll does not go to disk for its token. */
let cached = null;

function all() {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(paths.settings, 'utf8'));
  } catch {
    cached = {};
  }
  return cached;
}

/**
 * Written for this account and no other. `mode` only applies to a file being
 * created, so one that was once written wide open would stay that way.
 */
async function write(next) {
  await fsp.mkdir(config.dataDir, { recursive: true });
  await fsp.writeFile(paths.settings, JSON.stringify({ version: 1, ...next }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await fsp.chmod(paths.settings, 0o600);
  } catch {
    /* a filesystem without modes has nothing to tighten */
  }
  cached = { version: 1, ...next };
}

export function chatworkToken() {
  return all().chatwork?.token || '';
}

/** An empty token is the way to take one off again. */
export async function saveChatworkToken(token) {
  const value = String(token || '').trim();
  const next = { ...all() };
  if (value) next.chatwork = { ...next.chatwork, token: value };
  else delete next.chatwork;
  await write(next);
}

/**
 * The OAuth pair, in the file the link already reads. Saved in the shape the
 * Cloud Console's own download uses, so a panel-written file and a downloaded
 * one are the same file.
 */
export async function saveGoogleClient({ clientId, clientSecret }) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!id || !secret) throw new Error('both the client id and the secret are needed');
  await fsp.mkdir(config.dataDir, { recursive: true });
  await fsp.writeFile(
    paths.googleClient,
    JSON.stringify({ installed: { client_id: id, client_secret: secret } }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
  try {
    await fsp.chmod(paths.googleClient, 0o600);
  } catch {
    /* as above */
  }
}

/** Forget what was read, so the next call goes back to the file. */
export function reset() {
  cached = null;
}
