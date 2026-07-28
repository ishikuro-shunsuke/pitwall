#!/usr/bin/env node
/**
 * End-to-end smoke test against a temporary pitwall server.
 * Does not touch ~/.cursor or ~/.claude.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4477 + Math.floor(Math.random() * 1000);
const DATA = await fsp.mkdtemp(path.join(os.tmpdir(), 'pitwall-smoke-'));
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function ok(name) {
  passed += 1;
  console.log(`  ok  ${name}`);
}
function fail(name, err) {
  failed += 1;
  console.error(`  FAIL ${name}: ${err?.message || err}`);
}

async function json(method, pathname, body, { timeoutMs = 5000, headers } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
      env: {
        ...process.env,
        PITWALL_PORT: String(PORT),
        PITWALL_HOST: '127.0.0.1',
        PITWALL_DATA: DATA,
        PITWALL_HOLD_SECONDS: '3',
        PITWALL_MAX_HOLD_SECONDS: '30',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let booted = false;
    const onData = (buf) => {
      const text = buf.toString();
      if (!booted && text.includes('http://')) {
        booted = true;
        resolve(child);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => process.stderr.write(b));
    child.on('exit', (code) => {
      if (!booted) reject(new Error(`server exited early: ${code}`));
    });
    setTimeout(() => {
      if (!booted) reject(new Error('server boot timeout'));
    }, 5000);
  });
}

async function main() {
  console.log(`smoke → ${BASE}  data=${DATA}`);
  const child = await startServer();

  try {
    // health
    {
      const { status, data } = await json('GET', '/api/health');
      if (status === 200 && data.ok) ok('health');
      else fail('health', JSON.stringify(data));
    }

    // hook-side image upload, then dedupe probe
    let uploadedImage = null;
    {
      // 1x1 PNG
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      const sha = createHash('sha256').update(png).digest('hex').slice(0, 32);

      const before = await fetch(`${BASE}/api/hooks/images/${sha}.png`, { method: 'HEAD' });
      if (before.status === 404) ok('image probe misses before upload');
      else fail('image probe misses before upload', before.status);

      const res = await fetch(`${BASE}/api/hooks/images?sha=${sha}&ext=.png`, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: png,
      });
      const data = await res.json();
      if (res.ok && data.url === `/images/${sha}.png`) ok('image upload');
      else fail('image upload', data);
      uploadedImage = { ref: 'outputs/sample.png', name: 'sample.png', url: data.url, mime: 'image/png', bytes: png.length };

      const after = await fetch(`${BASE}/api/hooks/images/${sha}.png`, { method: 'HEAD' });
      if (after.status === 200) ok('image probe hits after upload');
      else fail('image probe hits after upload', after.status);

      const served = await fetch(`${BASE}${data.url}`);
      if (served.ok && served.headers.get('content-type') === 'image/png') ok('image served');
      else fail('image served', served.status);

      const bad = await fetch(`${BASE}/api/hooks/images?sha=x&ext=.exe`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('nope'),
      });
      if (bad.status === 400) ok('image ext allowlist');
      else fail('image ext allowlist', bad.status);
    }

    // cursor response buffer + wait + reply
    {
      const conv = 'smoke-cursor-1';
      await json('POST', '/api/hooks/response', {
        conversationId: conv,
        text: 'First chunk mentioning outputs/sample.png',
        images: [uploadedImage],
      });
      await json('POST', '/api/hooks/response', {
        conversationId: conv,
        text: 'Final assistant message mentioning outputs/sample.png',
        images: [uploadedImage],
      });

      const created = await json('POST', '/api/hooks/wait', {
        agent: 'cursor',
        status: 'completed',
        conversationId: conv,
        workspace_roots: [DATA],
        repo: { root: DATA, name: 'smoke-repo', branch: 'main' },
        host: { platform: 'linux', wslDistro: 'Ubuntu', cwd: DATA },
        model: {
          label: 'claude-opus-test',
          id: 'claude-opus-test',
          params: [
            { id: 'thinking', value: 'high' },
            { id: 'effort', value: 'max' },
          ],
          effort: 'max',
        },
      });
      if (!created.data?.id) throw new Error('no id from wait');
      const id = created.data.id;
      ok('cursor wait created');

      // resolve in background
      const resolveP = json('GET', `/api/hooks/wait/${id}/resolve`, null, { timeoutMs: 10_000 });

      // hold heartbeat
      const hold = await json('POST', `/api/entries/${id}/hold`);
      if (hold.status === 200 && hold.data.holdUntil) ok('hold extend');
      else fail('hold extend', hold.data);

      // reply
      const reply = await json('POST', `/api/entries/${id}/reply`, { message: 'please continue' });
      if (reply.status !== 200) fail('reply post', reply.data);
      else ok('reply post');

      const resolved = await resolveP;
      if (resolved.data?.action === 'reply' && resolved.data.message === 'please continue') {
        ok('cursor resolve reply');
      } else {
        fail('cursor resolve reply', resolved.data);
      }

      const list = await json('GET', '/api/entries?view=archive');
      const entry = list.data.entries?.find((e) => e.id === id);
      if (entry?.status === 'answered' && entry.body.includes('Final assistant')) ok('cursor body + archive');
      else fail('cursor body + archive', entry);

      if (entry?.images?.length === 1 && entry.images[0].url && !entry.images[0].missing) {
        ok('uploaded image attached and deduped');
      } else {
        fail('uploaded image attached and deduped', entry?.images);
      }

      if (entry?.links?.openWorkspace?.includes('vscode-remote/wsl+Ubuntu')) ok('wsl deeplink');
      else fail('wsl deeplink', entry?.links);
    }

    // paths from inside a container: the editor runs outside it, so the link
    // has to leave /workspaces behind or say that it cannot
    {
      const container = {
        platform: 'linux',
        cwd: '/workspaces/proj/sub',
        container: true,
        containerRoot: '/workspaces/proj',
        hostRoot: '/home/me/src/proj',
      };
      const mapped = await json('POST', '/api/hooks/wait', {
        agent: 'cursor',
        status: 'completed',
        conversationId: 'smoke-container-mapped',
        repo: { root: '/workspaces/proj', name: 'proj' },
        host: container,
      });
      const blind = await json('POST', '/api/hooks/wait', {
        agent: 'cursor',
        status: 'completed',
        conversationId: 'smoke-container-blind',
        repo: { root: '/workspaces/proj', name: 'proj' },
        host: { ...container, containerRoot: null, hostRoot: null },
      });

      const live = await json('GET', '/api/entries');
      const byId = (id) => live.data.entries?.find((e) => e.id === id);
      const link = byId(mapped.data?.id)?.links?.openWorkspace;
      if (link?.endsWith('/home/me/src/proj') && !link.includes('workspaces')) ok('container path mapped to host');
      else fail('container path mapped to host', link);

      const none = byId(blind.data?.id)?.links?.openWorkspace;
      if (none === null || none === undefined) ok('unmapped container gets no link');
      else fail('unmapped container gets no link', none);
    }

    // an absolute path in the message text, with no upload to fall back on
    {
      const conv = 'smoke-cursor-abs';
      const abs = path.join(DATA, 'abs-ref.png');
      await fsp.writeFile(abs, Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ));
      await json('POST', '/api/hooks/response', {
        conversationId: conv,
        text: `saved to ${abs} and to ~/nope.png`,
      });
      const created = await json('POST', '/api/hooks/wait', {
        agent: 'cursor',
        status: 'completed',
        conversationId: conv,
        repo: { root: DATA, name: 'smoke-repo', branch: 'main' },
      });
      const id = created.data?.id;
      const resolveP = json('GET', `/api/hooks/wait/${id}/resolve`, null, { timeoutMs: 10_000 });
      const list = await json('GET', '/api/entries?view=timeline');
      const entry = list.data.entries?.find((e) => e.id === id);
      const found = entry?.images?.find((i) => i.ref === abs);
      if (found?.url && !found.missing) ok('absolute path in prose resolves');
      else fail('absolute path in prose resolves', entry?.images);

      await json('POST', `/api/entries/${id}/dismiss`);
      await resolveP;
    }

    // claude wait + dismiss
    {
      const created = await json('POST', '/api/hooks/wait', {
        agent: 'claude',
        sessionId: 'sess-smoke',
        last_assistant_message: 'Claude is waiting on you.',
        permission_mode: 'default',
        stop_hook_active: false,
        repo: { root: DATA, name: 'smoke-repo', branch: 'main' },
        host: { platform: 'linux', wslDistro: 'Ubuntu', cwd: DATA },
        model: { label: 'claude-sonnet', effort: 'high', permissionMode: 'default' },
      });
      const id = created.data.id;
      const resolveP = json('GET', `/api/hooks/wait/${id}/resolve`, null, { timeoutMs: 10_000 });
      await json('POST', `/api/entries/${id}/dismiss`);
      const resolved = await resolveP;
      if (resolved.data?.action === 'dismiss') ok('claude dismiss');
      else fail('claude dismiss', resolved.data);

      const archived = await json('GET', '/api/entries?view=archive');
      const entry = archived.data.entries?.find((e) => e.id === id);
      if (entry?.unanswered) ok('dismissed sits in the archive unanswered');
      else fail('dismissed sits in the archive unanswered', { entry });
    }

    // Claude's hook waits with the session already stopped, so its card is not
    // on the idle clock — and the next stop of the same session retires it.
    {
      const payload = (text) => ({
        agent: 'claude',
        sessionId: 'sess-supersede',
        last_assistant_message: text,
        repo: { root: DATA, name: 'smoke-repo' },
        host: { cwd: DATA },
        model: { label: 'claude-sonnet' },
      });
      const first = await json('POST', '/api/hooks/wait', payload('first stop'));
      const id = first.data.id;
      const idleWindowMs = 3000;
      if (first.data.holdUntil - Date.now() > idleWindowMs) ok('claude outlasts the idle window');
      else fail('claude outlasts the idle window', first.data);

      const resolveP = json('GET', `/api/hooks/wait/${id}/resolve`, null, { timeoutMs: 10_000 });
      await json('POST', '/api/hooks/wait', payload('second stop'));
      const resolved = await resolveP;
      if (resolved.data?.action === 'release' && resolved.data.reason === 'superseded') {
        ok('claude supersede');
      } else {
        fail('claude supersede', resolved.data);
      }
    }

    // A hook can die between registering and polling — the agent was
    // interrupted, or the server restarted under it. Acting on the card must
    // still move it, or the button looks dead and the card never leaves.
    {
      const payload = (session) => ({
        agent: 'claude',
        sessionId: session,
        last_assistant_message: 'registered but never polled',
        repo: { root: DATA, name: 'smoke-repo' },
        host: { cwd: DATA },
        model: { label: 'claude-sonnet' },
      });

      const created = await json('POST', '/api/hooks/wait', payload('sess-no-poll'));
      const id = created.data.id;
      const reply = await json('POST', `/api/entries/${id}/reply`, { message: 'answer me' });
      const after = await json('GET', `/api/entries/${id}`);
      if (reply.status === 200 && after.data.entry?.status === 'answered') {
        ok('reply to an unpolled entry lands');
      } else {
        fail('reply to an unpolled entry lands', { status: reply.status, entry: after.data.entry?.status });
      }

      const other = await json('POST', '/api/hooks/wait', payload('sess-no-poll-dismiss'));
      const otherId = other.data.id;
      await json('POST', `/api/entries/${otherId}/dismiss`);
      const dismissed = await json('GET', `/api/entries/${otherId}`);
      if (dismissed.data.entry?.status === 'dismissed') ok('dismissing an unpolled entry lands');
      else fail('dismissing an unpolled entry lands', dismissed.data.entry?.status);

      const superseded = await json('POST', '/api/hooks/wait', payload('sess-no-poll-super'));
      const superId = superseded.data.id;
      await json('POST', '/api/hooks/wait', payload('sess-no-poll-super'));
      const retired = await json('GET', `/api/entries/${superId}`);
      if (retired.data.entry?.status === 'expired') ok('superseding an unpolled entry retires it');
      else fail('superseding an unpolled entry retires it', retired.data.entry?.status);
    }

    // Left alone, an unpolled card still has to come off the clock by itself.
    // Cursor's hold is the short one, so this is the 3s window.
    {
      const created = await json('POST', '/api/hooks/wait', {
        agent: 'cursor',
        conversationId: 'conv-no-poll-expire',
        last_assistant_message: 'nobody ever polls this',
        repo: { root: DATA, name: 'smoke-repo' },
        host: { cwd: DATA },
      });
      const id = created.data.id;
      await new Promise((r) => setTimeout(r, 4200));
      const after = await json('GET', `/api/entries/${id}`);
      const entry = after.data.entry;
      if (entry?.status === 'expired' && entry.bucket === 'timeline' && entry.unanswered) {
        ok('an expired entry stays on the timeline');
      } else {
        fail('an expired entry stays on the timeline', { status: entry?.status, bucket: entry?.bucket, unanswered: entry?.unanswered });
      }

      // The reply box is gone from the card, and the endpoint behind it says the
      // same thing. Boxing is then the only way it leaves.
      const late = await json('POST', `/api/entries/${id}/reply`, { message: 'too late' });
      if (late.status === 409) ok('an expired entry takes no reply');
      else fail('an expired entry takes no reply', late.status);

      await json('POST', `/api/entries/${id}/dismiss`);
      const boxed = (await json('GET', `/api/entries/${id}`)).data.entry;
      if (boxed?.bucket === 'archive' && boxed.unanswered && boxed.resolution === 'expired') {
        ok('boxing an expired entry files it unanswered');
      } else {
        fail('boxing an expired entry files it unanswered', { bucket: boxed?.bucket, unanswered: boxed?.unanswered, resolution: boxed?.resolution });
      }
    }

    // notice: raw Claude Notification payload forwarded by the curl hook
    {
      const n = await json('POST', '/api/hooks/notify?agent=claude', {
        session_id: 'sess-notify',
        cwd: DATA,
        hook_event_name: 'Notification',
        message: 'Claude needs your permission',
        title: 'Permission needed',
        notification_type: 'permission_prompt',
      });
      if (n.data?.id) ok('notify accepts raw payload');
      else fail('notify accepts raw payload', n.data);

      const skipped = await json('POST', '/api/hooks/notify?agent=claude', {
        cwd: DATA,
        notification_type: 'auth_success',
        message: 'ignore me',
      });
      if (skipped.data?.skipped) ok('notify filters uninteresting types');
      else fail('notify filters uninteresting types', skipped.data);
    }

    // expired via short hold
    {
      const created = await json('POST', '/api/hooks/wait', {
        agent: 'cursor',
        status: 'completed',
        conversationId: 'smoke-expire',
        body: 'will expire',
        repo: { root: DATA, name: 'smoke-repo' },
        host: { cwd: DATA },
        model: { label: 'x' },
      });
      const id = created.data.id;
      const resolved = await json('GET', `/api/hooks/wait/${id}/resolve`, null, { timeoutMs: 10_000 });
      if (resolved.data?.action === 'release' && resolved.data.reason === 'expired') ok('expire release');
      else fail('expire release', resolved.data);
    }

    // A poll that outlives the client's five-minute headers timeout: the reply
    // headers have to land long before the reply does.
    {
      const created = await json('POST', '/api/hooks/wait', {
        agent: 'claude',
        sessionId: 'smoke-headers',
        last_assistant_message: 'slow poll',
        repo: { root: DATA, name: 'smoke-repo' },
        host: { cwd: DATA },
      });
      const id = created.data.id;
      const poll = fetch(`${BASE}/api/hooks/wait/${id}/resolve`);
      // Nothing has resolved yet, so this can only settle on the early flush.
      const headers = await Promise.race([
        poll.then((res) => res.status),
        new Promise((r) => setTimeout(() => r('timeout'), 2000)),
      ]);
      if (headers === 200) ok('resolve flushes headers before it answers');
      else fail('resolve flushes headers before it answers', headers);

      await json('POST', `/api/entries/${id}/reply`, { message: 'late' });
      const body = await poll.then((res) => res.text());
      if (JSON.parse(body)?.message === 'late') ok('heartbeat padding stays parseable');
      else fail('heartbeat padding stays parseable', body);
    }

    // static UI
    {
      const res = await fetch(`${BASE}/`);
      const html = await res.text();
      if (res.ok && html.includes('pitwall')) ok('ui index');
      else fail('ui index', res.status);
    }

    // Real hook scripts (the distributed copies), not just the HTTP API.
    {
      const fixtures = path.join(DATA, 'hook-fixtures');
      await fsp.mkdir(fixtures, { recursive: true });
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      await fsp.writeFile(path.join(fixtures, 'shot.png'), png);

      const runHook = (command, args, stdinObj, { cwd = fixtures } = {}) =>
        new Promise((resolve) => {
          const child = spawn(command, args, {
            cwd,
            env: { ...process.env, PITWALL_URL: BASE },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          const out = [];
          child.stdout.on('data', (c) => out.push(c));
          child.stdin.end(JSON.stringify(stdinObj));
          child.on('close', (code) => {
            resolve({ code, stdout: Buffer.concat(out).toString('utf8') });
          });
        });

      const after = await runHook(process.execPath, [
        path.join(ROOT, 'hooks', 'cursor-after-response.mjs'),
        '--url',
        BASE,
      ], {
        conversation_id: 'smoke-hook-script',
        text: 'Look at ![x](shot.png)',
        workspace_roots: [fixtures],
      });
      if (after.code === 0 && after.stdout.trim() === '{}') {
        ok('cursor-after-response.mjs fail-open stdout');
      } else {
        fail('cursor-after-response.mjs fail-open stdout', after);
      }

      const sha = createHash('sha256').update(png).digest('hex').slice(0, 32);
      const probe = await fetch(`${BASE}/api/hooks/images/${sha}.png`, { method: 'HEAD' });
      if (probe.status === 200) ok('cursor-after-response.mjs uploaded image');
      else fail('cursor-after-response.mjs uploaded image', probe.status);

      const notify = await runHook(process.execPath, [
        path.join(ROOT, 'hooks', 'claude-notification.mjs'),
      ], {
        session_id: 'sess-hook-sh',
        cwd: fixtures,
        notification_type: 'idle_prompt',
        message: 'Claude is waiting for your input',
        title: 'Idle',
      });
      await new Promise((r) => setTimeout(r, 200));
      const notices = await json('GET', '/api/entries?view=timeline');
      const notice = notices.data.entries?.find((e) => e.notificationType === 'idle_prompt');
      if (notify.code === 0 && notice) ok('claude-notification.mjs created notice');
      else fail('claude-notification.mjs created notice', { notify, notice });

      // The question card is the question: a notice saying only that one was
      // asked is what this hook exists to replace.
      const asked = await runHook(process.execPath, [
        path.join(ROOT, 'hooks', 'claude-dialog.mjs'),
      ], {
        session_id: 'sess-hook-ask',
        cwd: fixtures,
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: {
          questions: [{
            question: 'Which library should we use?',
            header: 'Library',
            multiSelect: false,
            options: [
              { label: 'date-fns', description: 'Tree-shakeable' },
              { label: 'Day.js', description: '2KB' },
            ],
          }],
        },
      });
      await new Promise((r) => setTimeout(r, 200));
      const asks = await json('GET', '/api/entries?view=timeline');
      const card = asks.data.entries?.find((e) => e.notificationType === 'ask_user_question');
      const carries = card?.body?.includes('Which library should we use?')
        && card.body.includes('**date-fns** — Tree-shakeable')
        && card.body.includes('**Day.js**');
      if (asked.code === 0 && carries) ok('claude-dialog.mjs carries the question and its options');
      else fail('claude-dialog.mjs carries the question and its options', { asked, body: card?.body });

      // Nothing is decided here: an empty stdout would be a decision withheld,
      // and a non-zero exit would block the question from ever being asked.
      if (asked.code === 0 && asked.stdout.trim() === '{}') ok('claude-dialog.mjs decides nothing');
      else fail('claude-dialog.mjs decides nothing', asked);

      // The plan Claude Code reads back into the call before dispatching it.
      const planned = await runHook(process.execPath, [
        path.join(ROOT, 'hooks', 'claude-dialog.mjs'),
      ], {
        session_id: 'sess-hook-plan',
        cwd: fixtures,
        hook_event_name: 'PreToolUse',
        tool_name: 'ExitPlanMode',
        tool_input: {
          plan: '## Context\n\nSwap the date library.',
          planFilePath: path.join(fixtures, 'plan.md'),
        },
      });
      await new Promise((r) => setTimeout(r, 200));
      const plans = await json('GET', '/api/entries?view=timeline');
      const planCard = plans.data.entries?.find((e) => e.notificationType === 'exit_plan_mode');
      if (planned.code === 0 && planCard?.body?.includes('Swap the date library.')) {
        ok('claude-dialog.mjs carries the plan awaiting approval');
      } else {
        fail('claude-dialog.mjs carries the plan awaiting approval', { planned, body: planCard?.body });
      }

      // The call itself carries no plan; only the path is its own. Whatever
      // Claude Code did or did not inject, the file is on this machine.
      await fsp.writeFile(path.join(fixtures, 'plan.md'), '## Context\n\nRead from the file.');
      const fromFile = await runHook(process.execPath, [
        path.join(ROOT, 'hooks', 'claude-dialog.mjs'),
      ], {
        session_id: 'sess-hook-plan',
        cwd: fixtures,
        hook_event_name: 'PreToolUse',
        tool_name: 'ExitPlanMode',
        tool_input: { planFilePath: path.join(fixtures, 'plan.md') },
      });
      await new Promise((r) => setTimeout(r, 200));
      const files = await json('GET', '/api/entries?view=timeline');
      const fileCard = files.data.entries?.find(
        (e) => e.notificationType === 'exit_plan_mode' && e.body?.includes('Read from the file.'),
      );
      if (fromFile.code === 0 && fileCard) ok('claude-dialog.mjs falls back to the plan file');
      else fail('claude-dialog.mjs falls back to the plan file', { fromFile, count: files.data.entries?.length });

      // Every other tool call runs this hook too if the matcher is ever lost.
      const other = await runHook(process.execPath, [
        path.join(ROOT, 'hooks', 'claude-dialog.mjs'),
      ], {
        session_id: 'sess-hook-ask',
        cwd: fixtures,
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
      await new Promise((r) => setTimeout(r, 200));
      const after2 = await json('GET', '/api/entries?view=timeline');
      const cards = after2.data.entries?.filter((e) => e.notificationType === 'ask_user_question');
      if (other.code === 0 && cards?.length === 1) ok('claude-dialog.mjs ignores other tools');
      else fail('claude-dialog.mjs ignores other tools', { other, count: cards?.length });
    }

    // --- requests from somebody else's page ---------------------------------

    {
      const site = (value) => (value === null ? undefined : { 'Sec-Fetch-Site': value });
      const health = '/api/health';

      const hook = await json('GET', health, null, { headers: site(null) });
      if (hook.status === 200) ok('a request no browser made is let through');
      else fail('a request no browser made is let through', hook);

      const own = await json('GET', health, null, { headers: site('same-origin') });
      if (own.status === 200) ok("and so is pitwall's own screen");
      else fail("and so is pitwall's own screen", own);

      const typed = await json('GET', health, null, { headers: site('none') });
      if (typed.status === 200) ok('and so is the address typed in by hand');
      else fail('and so is the address typed in by hand', typed);

      const other = await json('GET', health, null, { headers: site('cross-site') });
      if (other.status === 403) ok("but a page on somebody else's site is turned away");
      else fail("but a page on somebody else's site is turned away", other);

      // Ports do not make a site, so another server on this machine is
      // same-site to the browser while being nothing to do with pitwall.
      const neighbour = await json('GET', health, null, { headers: site('same-site') });
      if (neighbour.status === 403) ok('and so is another port on this machine');
      else fail('and so is another port on this machine', neighbour);

      // The one that matters: the routes that change something.
      const posted = await json('POST', '/api/entries/whatever/dismiss', {}, { headers: site('cross-site') });
      if (posted.status === 403) ok('a cross-site POST never reaches a card');
      else fail('a cross-site POST never reaches a card', posted);

      // A page is welcome to the app itself; it is the API that is guarded.
      const page = await fetch(`${BASE}/`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
      if (page.status === 200) ok('while the page itself is still served');
      else fail('while the page itself is still served', { status: page.status });
    }
  } catch (error) {
    fail('unexpected', error);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    await fsp.rm(DATA, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
