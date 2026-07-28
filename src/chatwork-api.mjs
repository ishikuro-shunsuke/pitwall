/**
 * Chatwork, on one API token.
 *
 * There is no consent screen to run and nothing kept on disk: a token issued
 * from the account's own settings page sits in the environment and every call
 * carries it. So it never goes stale by itself — it is either there or it is
 * not, and when Chatwork stops taking it the only fix is a new one.
 *
 * Everything is form-encoded, which is what the API takes; JSON bodies are
 * refused. Three hundred calls in five minutes is the whole allowance, shared
 * across everything below, which is why a poll asks `/rooms` what is loud
 * before it asks any room what was said.
 */
import { config } from './config.mjs';

const API = 'https://api.chatwork.com/v2';

/** Raised when there is no token, or Chatwork will not take the one there is. */
export class NeedsTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NeedsTokenError';
  }
}

export function hasToken() {
  return Boolean(config.chatwork.token);
}

async function failure(res) {
  const text = await res.text().catch(() => '');
  let said = null;
  try {
    said = (JSON.parse(text)?.errors || []).join('; ');
  } catch {
    /* not JSON, so the body is the message */
  }
  if (res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const when = Number.isFinite(reset) && reset > 0
      ? ` — the window reopens at ${new Date(reset * 1000).toISOString().slice(11, 19)}Z`
      : '';
    const error = new Error(`chatwork api: over 300 calls in five minutes${when}`);
    error.status = 429;
    return error;
  }
  const error = new Error(`chatwork api ${res.status}: ${String(said || text).slice(0, 300)}`);
  error.status = res.status;
  return error;
}

async function call(method, path, { query, form } = {}) {
  const token = config.chatwork.token;
  if (!token) throw new NeedsTokenError('no Chatwork token');

  const url = new URL(API + path);
  for (const [key, value] of Object.entries(query || {})) {
    url.searchParams.set(key, String(value));
  }

  const init = { method, headers: { 'X-ChatWorkToken': token, Accept: 'application/json' } };
  if (form) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  }

  const res = await fetch(url, init);
  if (res.status === 401) throw new NeedsTokenError('Chatwork rejected the token');
  // Nothing to hand back, which the messages endpoint means as an answer rather
  // than a failure: there was nothing there.
  if (res.status === 204) return null;
  if (!res.ok) throw await failure(res);
  return res.json().catch(() => null);
}

export function get(path, query) {
  return call('GET', path, { query });
}

export function post(path, form) {
  return call('POST', path, { form });
}

export function put(path, form, query) {
  return call('PUT', path, { form, query });
}

/** Held for the life of the process: the token is fixed, so whose it is, is too. */
let self = null;

export async function me() {
  if (self) return self;
  const data = await get('/me');
  self = {
    accountId: String(data?.account_id ?? ''),
    name: data?.name || 'you',
  };
  return self;
}

/** Forget the account, so a test can hand the next call a different one. */
export function reset() {
  self = null;
}
