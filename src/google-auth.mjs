/**
 * OAuth for a desktop client: the consent screen runs once in your browser and
 * hands back a refresh token, which is the only thing kept on disk. Google
 * treats any port on 127.0.0.1 as a valid redirect for this client type, so the
 * callback listener can take whatever port is free instead of asking for one to
 * be registered.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config, paths } from './config.mjs';

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  // Not the read-only one: a card can tick its task off, and Google has no
  // narrower grant for that than the whole of Tasks.
  'https://www.googleapis.com/auth/tasks',
  // Not the read-only one: a card replies and archives. Google has no scope
  // that reads and moves mail without also being able to send it.
  'https://www.googleapis.com/auth/gmail.modify',
];
export const SCOPE = SCOPES.join(' ');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Raised when the saved grant is gone and only the browser can get a new one. */
export class NeedsLinkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NeedsLinkError';
  }
}

/**
 * Either the two environment variables, or the JSON Google Cloud Console hands
 * you on the download button — which nests the pair under `installed`.
 */
export function readClient() {
  const { clientId, clientSecret } = config.google;
  if (clientId && clientSecret) return { clientId, clientSecret };
  try {
    const raw = JSON.parse(fs.readFileSync(paths.googleClient, 'utf8'));
    const c = raw.installed || raw.web || raw;
    if (c.client_id && c.client_secret) {
      return { clientId: c.client_id, clientSecret: c.client_secret };
    }
  } catch {
    /* no file, or not the file we were hoping for */
  }
  return null;
}

function readToken() {
  try {
    return JSON.parse(fs.readFileSync(paths.googleToken, 'utf8'));
  } catch {
    return null;
  }
}

async function writeToken(token) {
  await fsp.writeFile(paths.googleToken, JSON.stringify(token, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  // `mode` above only applies when the file is being created, and a token that
  // was once written wide open would stay that way through every renewal.
  try {
    await fsp.chmod(paths.googleToken, 0o600);
  } catch {
    /* a filesystem without modes has nothing to tighten */
  }
}

export function isLinked() {
  return Boolean(readToken()?.refresh_token);
}

export function linkedAccount() {
  return readToken()?.account || null;
}

/** When the grant on disk was made. A Testing client's lasts about a week. */
export function linkedAt() {
  return readToken()?.linkedAt || null;
}

/**
 * Whether the saved grant covers something. A link made before a scope was
 * added keeps working for everything it already had, and the part that is new
 * would otherwise spend every poll being refused.
 */
export function hasScope(scope) {
  const granted = String(readToken()?.scope || '').split(/\s+/).filter(Boolean);
  return granted.includes(scope);
}

/**
 * The zone the account keeps its calendar in, recorded at link time. A due
 * date has no clock on it, and the server's own zone is whatever the container
 * was built with.
 */
export function linkedTimeZone() {
  return readToken()?.timeZone || null;
}

async function postForm(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    const error = new Error(`google token endpoint: ${detail}`);
    error.code = data.error;
    throw error;
  }
  return data;
}

/** access_token + when it dies, held in memory only. */
let cached = null;
let refreshing = null;

export async function getAccessToken() {
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
  // Two polls landing at once must not burn two refreshes; the second waits on
  // the first, and a refresh token Google has rotated stays valid for both.
  if (refreshing) return refreshing;

  refreshing = (async () => {
    const client = readClient();
    if (!client) {
      throw new NeedsLinkError('no Google OAuth client configured');
    }
    const saved = readToken();
    if (!saved?.refresh_token) {
      throw new NeedsLinkError('Google account not linked');
    }

    let data;
    try {
      data = await postForm(TOKEN_URL, {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: saved.refresh_token,
        grant_type: 'refresh_token',
      });
    } catch (error) {
      // The grant is revoked or expired: nothing on this machine can renew it,
      // so drop the token rather than retry against it every poll.
      if (error.code === 'invalid_grant') {
        await fsp.rm(paths.googleToken, { force: true });
        throw new NeedsLinkError('Google refused the saved grant — link again');
      }
      throw error;
    }

    if (data.refresh_token && data.refresh_token !== saved.refresh_token) {
      await writeToken({ ...saved, refresh_token: data.refresh_token });
    }
    cached = {
      token: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    };
    return cached.token;
  })();

  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

/** Forget the in-memory access token so the next call re-reads what is on disk. */
export function reset() {
  cached = null;
}

async function api(url, init = {}) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    cached = null;
    throw new NeedsLinkError('Google rejected the access token');
  }
  if (!res.ok) {
    throw apiError(res.status, await res.text().catch(() => ''));
  }
  return res.json();
}

/**
 * What Google actually said, in one line.
 *
 * An API that has never been switched on in the project answers every call
 * with a page of JSON, and the only part of it that matters is the address
 * that switches it on. Left raw it arrives cut off mid-sentence in the log,
 * which is where a poll that repeats forever puts it.
 */
function apiError(status, text) {
  let error = null;
  try {
    error = JSON.parse(text)?.error;
  } catch {
    /* not JSON, so there is nothing in it to find */
  }
  const off = (error?.details || []).find((d) => d.reason === 'SERVICE_DISABLED');
  if (off) {
    const service = off.metadata?.service || 'an API pitwall needs';
    const where = off.metadata?.activationUrl;
    return new Error(
      `${service} is not enabled on your Google Cloud project${where ? ` — turn it on at ${where}` : ''}`,
    );
  }
  return new Error(`google api ${status}: ${String(error?.message || text).slice(0, 300)}`);
}

export function apiGet(url) {
  return api(url);
}

export function apiPatch(url, body) {
  return api(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function apiPost(url, body) {
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    // No opener on a headless box or inside a container. The caller has already
    // printed the address, so there is nothing to recover from.
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>pitwall</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0">
<p>Linked. You can close this tab.</p>`;

/**
 * Run the consent screen and save the refresh token.
 * `onUrl` receives the address to visit, for a caller that would rather print
 * it than have a browser opened on top of whatever is on screen.
 */
export async function authorize({ onUrl = openBrowser } = {}) {
  const client = readClient();
  if (!client) {
    throw new Error(
      `no OAuth client: set PITWALL_GOOGLE_CLIENT_ID and PITWALL_GOOGLE_CLIENT_SECRET, or save the console download to ${paths.googleClient}`,
    );
  }

  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');

  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.google.oauthPort, '127.0.0.1', resolve);
  });
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

  const authUrl = new URL(AUTH_URL);
  authUrl.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    // Without both of these Google withholds the refresh token on every
    // consent after the first, and the link silently lasts one hour.
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString();

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('consent timed out')), 5 * 60_000);
    server.on('request', (req, res) => {
      const url = new URL(req.url || '/', redirectUri);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const done = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
      };
      if (url.searchParams.get('state') !== state) {
        done(400, 'state mismatch');
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        done(400, `denied: ${error}`);
        clearTimeout(timer);
        reject(new Error(`consent denied: ${error}`));
        return;
      }
      done(200, DONE_PAGE);
      clearTimeout(timer);
      resolve(url.searchParams.get('code'));
    });
    onUrl(authUrl.toString());
  }).finally(() => server.close());

  const data = await postForm(TOKEN_URL, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  if (!data.refresh_token) {
    throw new Error('Google returned no refresh token — revoke pitwall at myaccount.google.com and try again');
  }

  cached = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };

  let account = null;
  let timeZone = null;
  try {
    const me = await apiGet('https://www.googleapis.com/calendar/v3/calendars/primary');
    account = me.id || null;
    timeZone = me.timeZone || null;
  } catch {
    /* the token works; whose it is, is only for the console line */
  }

  await writeToken({
    refresh_token: data.refresh_token,
    scope: data.scope || SCOPE,
    account,
    timeZone,
    linkedAt: new Date().toISOString(),
  });
  return { account };
}

export { openBrowser };

/**
 * The consent run the settings panel started, if there is one.
 *
 * `authorize` hands its address out before it starts waiting, so the panel can
 * be given somewhere to send you while the run carries on behind it. What
 * happens after that reaches nobody — the tab that approves it lands on the
 * loopback listener, not on the page that opened it — so the outcome is kept
 * here for the panel to come back and read.
 */
let consent = null;

export function startConsent() {
  if (consent && !consent.settled) return consent.url;

  const record = { settled: false, error: null, account: null };
  record.url = new Promise((resolve, reject) => {
    authorize({ onUrl: resolve })
      .then(({ account }) => {
        record.settled = true;
        record.account = account;
      })
      .catch((error) => {
        record.settled = true;
        record.error = error.message;
        // Only lands anywhere when it failed before there was an address to
        // send you to — a missing client, or a port that will not open.
        reject(error);
      });
  });
  consent = record;
  return record.url;
}

export function consentStatus() {
  if (!consent) return null;
  return { running: !consent.settled, error: consent.error, account: consent.account };
}

/**
 * Drop what the last run said. Called when the client is replaced: whatever it
 * failed over is not the client that is there now, and an error left standing
 * describes a setup that no longer exists.
 */
export function forgetConsent() {
  if (consent?.settled !== false) consent = null;
}
