#!/usr/bin/env node
/**
 * Demo feeder — posts plausible hook payloads at random intervals so the
 * timeline has something to show without running real agents.
 *
 *   node demo/feed.mjs [--url URL] [--count N] [--min 4] [--max 10] [--no-images]
 *
 * Entries are created through the same endpoints the hooks use, and each wait
 * is long-polled the way a hook would, so replying in the browser really lands
 * and is printed here.
 *
 * Images come from Wikimedia Commons and are cached under /tmp, so a rerun
 * stays offline.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);

function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return fallback;
}

const BASE = (flag('url') || process.env.PITWALL_URL || 'http://127.0.0.1:4477').replace(/\/+$/, '');
const COUNT = Number(flag('count', 'Infinity'));
const MIN_MS = Number(flag('min', '4')) * 1000;
const MAX_MS = Number(flag('max', '10')) * 1000;
const WITH_IMAGES = !argv.includes('--no-images');
const IMAGE_DIR = flag('image-dir') || path.join(os.tmpdir(), 'pitwall-demo-images');
const IMAGE_POOL_SIZE = 12;

const UA = 'pitwall-demo/0.1 (https://github.com/ishikuro-shunsuke/pitwall)';

function log(...args) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}]`, ...args);
}

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (list) => list[randInt(0, list.length - 1)];
const chance = (p) => Math.random() < p;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickSome(list, n) {
  const copy = [...list];
  const out = [];
  while (out.length < n && copy.length) out.push(...copy.splice(randInt(0, copy.length - 1), 1));
  return out;
}

/* ---------------------------------------------------------------- images */

const SEARCH_TERMS = [
  'Formula One pit lane',
  'Formula One pit stop',
  'race engineer garage',
  'motorsport starting grid',
  'racing circuit aerial',
];

async function commonsSearch(term, limit) {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: term,
    gsrlimit: String(limit),
    prop: 'imageinfo',
    iiprop: 'url|mime|size',
    iiurlwidth: '1200',
  }).toString();

  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return [];
  const data = await res.json();
  return Object.values(data?.query?.pages ?? {})
    .map((page) => page.imageinfo?.[0])
    .filter((info) => info?.thumburl && /^image\/(jpeg|png)$/.test(info.mime));
}

function cachedImages() {
  try {
    return fs
      .readdirSync(IMAGE_DIR)
      .filter((name) => /\.(jpe?g|png)$/i.test(name))
      .map((name) => path.join(IMAGE_DIR, name));
  } catch {
    return [];
  }
}

/** Fill the cache up to IMAGE_POOL_SIZE files; whatever is already there counts. */
async function ensureImagePool() {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  let pool = cachedImages();
  if (pool.length >= IMAGE_POOL_SIZE) return pool;

  log(`fetching demo images from Wikimedia Commons → ${IMAGE_DIR}`);
  for (const term of SEARCH_TERMS) {
    if (pool.length >= IMAGE_POOL_SIZE) break;
    let results = [];
    try {
      results = await commonsSearch(term, 4);
    } catch (error) {
      log(`  search failed (${term}): ${error.message}`);
      continue;
    }

    for (const info of results) {
      if (pool.length >= IMAGE_POOL_SIZE) break;
      const name = decodeURIComponent(path.basename(new URL(info.thumburl).pathname))
        .replace(/[^\w.-]+/g, '_')
        .replace(/^\d+px-/, '');
      const target = path.join(IMAGE_DIR, name);
      if (fs.existsSync(target)) continue;
      try {
        const res = await fetch(info.thumburl, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) continue;
        await fsp.writeFile(target, Buffer.from(await res.arrayBuffer()));
        pool.push(target);
        log(`  ${name}`);
      } catch (error) {
        log(`  download failed (${name}): ${error.message}`);
      }
    }
  }

  pool = cachedImages();
  if (!pool.length) log('no images available — carrying on without them');
  return pool;
}

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

/**
 * Push the bytes the way a hook does — the server never opens a path from a
 * payload — and return the image objects to hang off the entry.
 */
async function uploadImages(files) {
  const images = [];
  for (const file of files) {
    const buffer = await fsp.readFile(file);
    const ext = path.extname(file).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    const sha = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
    const filename = `${sha}${ext}`;
    const base = { ref: file, sourcePath: file, name: path.basename(file), mime, bytes: buffer.length };

    const probe = await fetch(`${BASE}/api/hooks/images/${filename}`, { method: 'HEAD' }).catch(() => null);
    if (probe?.status === 200) {
      images.push({ ...base, filename, url: `/images/${filename}` });
      continue;
    }

    const res = await fetch(`${BASE}/api/hooks/images?sha=${sha}&ext=${encodeURIComponent(ext)}`, {
      method: 'POST',
      headers: { 'Content-Type': mime },
      body: buffer,
    }).catch(() => null);
    if (!res?.ok) {
      images.push({ ...base, missing: true, error: 'upload failed' });
      continue;
    }
    const stored = await res.json();
    images.push({ ...base, filename, url: stored.url });
  }
  return images;
}

/* --------------------------------------------------------------- sessions */

const REPOS = [
  {
    key: '/home/demo/src/pitwall',
    name: 'pitwall',
    root: '/home/demo/src/pitwall',
    branch: 'main',
    remote: 'git@github.com:ishikuro-shunsuke/pitwall.git',
  },
  {
    key: '/home/demo/src/telemetry-api',
    name: 'telemetry-api',
    root: '/home/demo/src/telemetry-api',
    branch: 'feat/lap-deltas',
    remote: 'git@github.com:demo/telemetry-api.git',
  },
  {
    key: '/workspaces/strategy-ui',
    name: 'strategy-ui',
    root: '/workspaces/strategy-ui',
    branch: 'fix/pit-window',
    remote: 'https://github.com/demo/strategy-ui.git',
  },
];

const CLAUDE_MODELS = [
  { label: 'claude-opus-5[1m]', id: 'claude-opus-5[1m]', effort: 'high', permissionMode: 'acceptEdits' },
  { label: 'claude-sonnet-5', id: 'claude-sonnet-5', effort: 'medium', permissionMode: 'default' },
  { label: 'claude-opus-5', id: 'claude-opus-5', effort: 'xhigh', permissionMode: 'plan' },
];

const CURSOR_MODELS = [
  { label: 'composer-1', id: 'composer-1', params: [{ id: 'effort', value: 'high' }] },
  { label: 'gpt-5-codex', id: 'gpt-5-codex', params: [{ id: 'effort', value: 'medium' }] },
];

function makeSessions() {
  const sessions = [];
  for (const repo of REPOS) {
    sessions.push({
      agent: 'claude',
      repo,
      model: pick(CLAUDE_MODELS),
      sessionId: crypto.randomUUID(),
      agentType: chance(0.25) ? 'Explore' : null,
    });
    sessions.push({
      agent: 'cursor',
      repo,
      model: pick(CURSOR_MODELS),
      conversationId: crypto.randomUUID(),
      loopCount: 0,
    });
  }
  return sessions;
}

const hostFor = (repo) => ({
  platform: 'linux',
  wslDistro: repo.root.startsWith('/workspaces') ? null : 'Ubuntu',
  cwd: repo.root,
});

/* --------------------------------------------------------------- messages */

const CLAUDE_TURNS = [
  {
    title: 'ピットウィンドウの再計算',
    body: `## やったこと

ピットウィンドウの計算を \`strategy/window.ts\` に切り出しました。呼び出し側 3 箇所も差し替え済みです。

\`\`\`ts
export function computeWindow(stint: Stint, tyre: TyreState): Window {
  const remaining = stint.totalLaps - stint.lap;
  const wear = tyre.wearRate * remaining;          // 0..1
  const earliest = stint.lap + Math.ceil(remaining * (1 - wear) * 0.35);
  const latest = stint.lap + Math.floor(remaining * (1 - wear) * 0.70);
  return { earliest, latest, confidence: wear < 0.8 ? 'high' : 'low' };
}
\`\`\`

## 変えた挙動

1. 残ラップと磨耗率だけを見ます（以前は燃料搭載量も混ざっていました）
2. セーフティカー中は窓を **2 ラップ前倒し** します
3. \`confidence\` が \`low\` のときは UI 側でグレーアウトされます

> 前倒し幅の 2 ラップは、過去 3 シーズンのログから中央値を取っただけです。
> レギュレーション側の根拠は見つけられませんでした。

この 2 ラップ、このままでいいですか。それともレースごとに係数を持たせますか。`,
  },
  {
    title: 'ラップデルタ API の移行',
    body: `\`/v2/laps\` への移行、破壊的変更が 1 つだけ残ります。

\`\`\`diff
 export interface LapRow {
   lap: number;
   driver: string;
-  delta: number;          // 秒。小数第 3 位まで
+  deltaMs: number;        // ミリ秒。整数
-  sectors: number[];      // 秒
+  sectorsMs: number[];    // ミリ秒
 }
\`\`\`

浮動小数の丸めで **1 周あたり最大 4ms** ずれていたのが原因です。移行後のレスポンスはこうなります。

\`\`\`json
{
  "lap": 34,
  "driver": "VER",
  "deltaMs": -412,
  "sectorsMs": [28914, 41220, 22887]
}
\`\`\`

選んでほしいのはここです。

1. 旧フィールドを 1 リリース残す（\`Deprecation\` ヘッダ + 6 週間の猶予）
2. いま消す（社内 2 クライアントは同時に直す）

ダッシュボード以外に \`delta\` を読んでいる利用者、把握していますか。`,
  },
  {
    title: 'テストが 2 件落ちている',
    body: `\`npm test\` が 2 件落ちます。どちらもタイムゾーン依存でした。

\`\`\`bash
$ npm test -- --reporter=dot

  ✗ formats a lap time in the driver's local zone
      expected "14:03:21" to equal "23:03:21"
  ✗ rolls the session date over at midnight UTC
      expected "2026-03-15" to equal "2026-03-14"

  38 passing, 2 failing  (1.9s)
\`\`\`

CI は UTC、手元は \`Asia/Tokyo\` で走っているので、手元では通ります。直し方が 2 つあります。

- CI とローカルの両方を \`TZ=UTC\` に固定する — 一行で済むが、ローカル時刻の表示バグは今後も落ちません
- テスト側で \`zone\` を明示して、\`Asia/Tokyo\` と \`Europe/Monaco\` の 2 ケースに増やす — 手間はかかるが実際のバグを踏めます

どちらにしますか。後者なら \`test/helpers/zones.mjs\` を足します。`,
  },
  {
    title: 'SSE がスリープ復帰後に死ぬ',
    body: `タイムラインの SSE が、ラップトップのスリープ復帰後に無言で切れていました。ブラウザは \`error\` を一度投げるだけで、\`EventSource\` は再接続を諦めます。

\`\`\`js
function connect(retry = 0) {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => { retry = 0; });
  es.addEventListener('error', () => {
    es.close();
    const wait = Math.min(30_000, 500 * 2 ** retry) + Math.random() * 250;
    setTimeout(() => connect(retry + 1), wait);
  });
  return es;
}
\`\`\`

上限は 30 秒にしました。ジッタを足しているのは、会議明けに全員のタブが同時に戻ってくるからです。

> 復帰直後の 1 回目だけ即時リトライにすると体感は良くなりますが、機内モードのまま開いていると無駄打ちが増えます。

上限 30 秒、短くしますか。`,
  },
  {
    title: 'スティント比較のレイアウト 2 案',
    body: `スティント比較の画面、2 案作って両方動かせる状態にしてあります。

### 案 1 — 横並び（ドライバごとに列）

IMAGE_1

- 4 人までなら一覧性が高い
- 5 人を超えると列が潰れます

### 案 2 — 重ね描き（デルタを面で塗る）

IMAGE_2

- 人数が増えても潰れない
- 交差が多いレースだと面が濁ります

いまのところ **案 2** を推します。人数の上限を切りたくないからです。どちらで進めますか。`,
    images: 2,
  },
  {
    title: 'タイヤ磨耗グラフの描き直し',
    body: `タイヤ磨耗のグラフを描き直しました。スケールを線形から対数に変えて、終盤の落ち込みが潰れないようにしています。

変更前 / 変更後 / 実データを重ねたもの、の順です。

IMAGE_1
IMAGE_2
IMAGE_3

残っている見た目の問題が 1 つあります。

\`\`\`
"MEDIUM (used, 12 laps) — VER"   ← 折り返して 2 行になる
"SOFT — HAM"                      ← 1 行
\`\`\`

軸のラベルが長いスティント名で折り返して、行の高さが揃いません。

1. 省略して tooltip に全文を出す
2. 軸を左に 80px 広げる
3. ラベルを 2 段（コンパウンド / ドライバ）に分ける

どれがいいですか。`,
    images: 3,
  },
  {
    title: 'laps テーブルのマイグレーション',
    body: `\`laps\` に \`deltaMs\` を足すマイグレーションを書きました。ただ、このテーブルは **4,210 万行** あります。

\`\`\`sql
-- 即時。メタデータだけ触ります
ALTER TABLE laps ADD COLUMN delta_ms integer;

-- ここが問題。単発で流すとロックが数分伸びます
UPDATE laps SET delta_ms = round(delta * 1000);
\`\`\`

分割して流す前提で、こう考えています。

1. バッチ 5 万行、あいだに 200ms スリープ
2. 進捗は \`migration_progress\` に \`last_id\` で記録（途中で落ちても再開できます）
3. 全件埋まったら \`NOT NULL\` と \`DROP COLUMN delta\` を別リリースで

> 見積もりで **約 42 分**。レプリカ遅延は 1 秒以内に収まる計算です。

平日の日中に流していいですか。それとも週末の窓を取りますか。`,
  },
  {
    title: 'ラップフィードの計測',
    body: `再レンダリングの件、計測しました。\`useLapFeed\` が毎フレーム新しい配列を返しているのが原因です。

\`\`\`
                    before      after
renders / sec         61.4        4.0
main thread ms       184.2       21.7
dropped frames        37           0
\`\`\`

IMAGE_1
IMAGE_2

直したのは 2 箇所です。

- \`useSyncExternalStore\` に寄せて、スナップショットを安定させました
- 描画は \`requestAnimationFrame\` に集約しました

副作用として、**バックグラウンドタブでは更新が完全に止まります**。タブを戻したときに最新へ飛びます。

ピットウォールのモニタを別タブで出しっぱなしにする使い方、ありますか。あるなら止めない実装にします。`,
    images: 2,
  },
];

const CURSOR_TURNS = [
  {
    chunks: [
      `シミュレータを読みました。ピットロスが定数で埋まっています。

\`\`\`python
PIT_LOSS = 22.4  # seconds
\`\`\``,
      `サーキットごとに 4 秒以上ちがいます。実測の中央値だとこうです。

- Monaco … 18.9
- Silverstone … 21.6
- Spa … 24.3
- Singapore … 27.1

テーブルを引く形に変えていいですか。無いサーキットは 22.4 にフォールバックします。`,
    ],
  },
  {
    chunks: [
      '`useLapFeed` の再レンダリングを潰しました。**1 秒あたり 61 回 → 4 回**です。',
      `やったのはこれだけです。

\`\`\`tsx
-  const laps = feed.rows.map(toRow);              // 毎フレーム新しい配列
+  const laps = useSyncExternalStore(feed.subscribe, feed.snapshot);
\`\`\`

\`requestAnimationFrame\` に寄せたので、バックグラウンドタブでは更新が完全に止まります。止まると困る画面はありますか。`,
    ],
  },
  {
    chunks: [
      '`laps` にカラムを足すマイグレーションを書きましたが、行数が 4,210 万ありました。',
      `\`ADD COLUMN\` 自体は即時です。問題はバックフィルのほうで、単発の \`UPDATE\` だとロックが数分伸びます。

\`\`\`sql
UPDATE laps SET delta_ms = round(delta * 1000)
WHERE id > :last_id
ORDER BY id
LIMIT 50000;
\`\`\``,
      `> 見積もり: 843 バッチ、あいだに 200ms スリープで **約 42 分**。

このサイズで流していいですか。本番の許容できる遅延を知りたいです。`,
    ],
  },
  {
    chunks: [
      'いまのピットウォールのレイアウトを撮りました。',
      `幅 1280 / 1024 / 720 の順です。

IMAGE_1
IMAGE_2
IMAGE_3

気になるのは 2 つです。

1. 画像つきのカードだけ極端に背が高い
2. チップの行が 2 行に折り返すと、下のカードとの間隔が詰まって見える

1 のほうは、画像を横スクロールの帯にすれば揃います。やりますか。`,
    ],
    images: 3,
  },
  {
    chunks: [
      '依存を上げました。監査で 1 件だけ残っています。',
      `\`\`\`
# npm audit report

tar  <6.2.1
  Severity: moderate
  Arbitrary File Creation/Overwrite — GHSA-f5x3-32g6-xq36
  fix available via \`npm audit fix --force\`
  Will install @vercel/nft@0.24.4, which is a breaking change

1 moderate severity vulnerability
\`\`\``,
      `\`tar\` は本番のコードパスからは呼ばれていません（ビルド時のみ）。

- いま上げる … \`@vercel/nft\` が破壊的変更を含むので、ビルド設定を触ることになります
- 次のリリースまで置く … 監査は赤のままです

どちらにしますか。`,
    ],
  },
];

const NOTICES = [
  {
    notificationType: 'permission_prompt',
    title: 'Permission needed',
    body: 'Claude が `rm -rf node_modules && npm ci` を実行しようとしています。',
  },
  {
    notificationType: 'idle_prompt',
    title: 'Waiting for input',
    body: '60 秒間なにも入力がありません。',
  },
  {
    notificationType: 'agent_needs_input',
    title: 'Agent needs input',
    body: 'サブエージェント `Explore` が対象ディレクトリの指定を待っています。',
  },
];

/** Swap IMAGE_n placeholders for bare paths — that is how the hooks see them. */
function inlineImageRefs(text, images) {
  return text.replace(/IMAGE_(\d+)/g, (match, n) => images[Number(n) - 1]?.ref ?? match);
}

/** Tacked onto a turn that carries no screenshot of its own, so most turns do. */
const EXTRA_IMAGE_LEADS = [
  '手元の画面も貼っておきます。',
  '直前の表示はこれです。',
  '参考まで、いま出ている画面です。',
  'ついでに撮ったものを置いておきます。',
  '見比べられるように、順に並べました。',
];

/** How many images this turn wants — its own, or a tacked-on batch. */
function imageBudget(turn, pool) {
  if (!WITH_IMAGES || !pool.length) return 0;
  if (turn.images) return Math.min(turn.images, pool.length);
  return chance(0.45) ? Math.min(randInt(2, 4), pool.length) : 0;
}

/** A lead-in plus one bare path per image, for turns that had none of their own. */
function extraImageBlock(count) {
  const refs = Array.from({ length: count }, (_, i) => `IMAGE_${i + 1}`).join('\n');
  return `${pick(EXTRA_IMAGE_LEADS)}\n\n${refs}`;
}

/* ----------------------------------------------------------------- posting */

async function post(pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** Hold the entry open the way a hook does, and report what came back. */
function pollResolve(id, label) {
  fetch(`${BASE}/api/hooks/wait/${id}/resolve`, { signal: AbortSignal.timeout(1_900_000) })
    .then((res) => res.json())
    .then((data) => {
      if (data.action === 'reply') log(`${label} ← 返信: ${JSON.stringify(data.message)}`);
      else log(`${label} ← ${data.action}${data.reason ? ` (${data.reason})` : ''}`);
    })
    .catch(() => {});
}

async function feedClaude(session, pool) {
  const turn = pick(CLAUDE_TURNS);
  const wanted = imageBudget(turn, pool);
  const images = wanted ? await uploadImages(pickSome(pool, wanted)) : [];
  const body = turn.images || !wanted
    ? turn.body
    : `${turn.body}\n\n${extraImageBlock(wanted)}`;

  const created = await post('/api/hooks/wait', {
    agent: 'claude',
    sessionId: session.sessionId,
    title: turn.title,
    transcriptPath: `/home/demo/.claude/projects/demo/${session.sessionId}.jsonl`,
    stop_hook_active: false,
    last_assistant_message: inlineImageRefs(body, images),
    images,
    background_tasks: chance(0.2) ? [{ id: 'bg_1' }, { id: 'bg_2' }] : [],
    agent_type: session.agentType,
    permission_mode: session.model.permissionMode,
    repo: session.repo,
    host: hostFor(session.repo),
    model: {
      label: session.model.label,
      id: session.model.id,
      effort: session.model.effort,
      permissionMode: session.model.permissionMode,
      agentType: session.agentType,
    },
  });

  if (!created?.id) return log(`claude/${session.repo.name} → 拒否: ${JSON.stringify(created)}`);
  log(`claude/${session.repo.name} → ${created.id} "${turn.title}"${images.length ? ` +${images.length}img` : ''}`);
  pollResolve(created.id, `claude/${session.repo.name}`);
}

async function feedCursor(session, pool) {
  const turn = pick(CURSOR_TURNS);
  const wanted = imageBudget(turn, pool);
  const images = wanted ? await uploadImages(pickSome(pool, wanted)) : [];
  // Onto the last chunk, not after it: the last chunk is what the card shows.
  const chunks = turn.images || !wanted
    ? turn.chunks
    : turn.chunks.map((chunk, i) =>
      (i === turn.chunks.length - 1 ? `${chunk}\n\n${extraImageBlock(wanted)}` : chunk));

  // Cursor's stop payload carries no text; the turn arrives as afterAgentResponse
  // chunks that the server buffers until the stop lands.
  for (const chunk of chunks) {
    await post('/api/hooks/response', {
      conversationId: session.conversationId,
      text: inlineImageRefs(chunk, images),
      images: /IMAGE_\d/.test(chunk) ? images : [],
    });
  }

  session.loopCount += 1;
  const created = await post('/api/hooks/wait', {
    agent: 'cursor',
    status: 'completed',
    conversationId: session.conversationId,
    generationId: crypto.randomUUID(),
    transcriptPath: null,
    workspace_roots: [session.repo.root],
    loop_count: session.loopCount,
    repo: session.repo,
    host: hostFor(session.repo),
    model: { ...session.model, effort: session.model.params?.[0]?.value ?? null },
  });

  if (!created?.id) return log(`cursor/${session.repo.name} → 拒否: ${JSON.stringify(created)}`);
  log(`cursor/${session.repo.name} → ${created.id} (${chunks.length} chunks)${images.length ? ` +${images.length}img` : ''}`);
  pollResolve(created.id, `cursor/${session.repo.name}`);
}

async function feedNotice(session) {
  const notice = pick(NOTICES);
  const created = await post('/api/hooks/notify', {
    agent: 'claude',
    sessionId: session.sessionId ?? crypto.randomUUID(),
    notificationType: notice.notificationType,
    notice: notice.notificationType,
    title: notice.title,
    body: notice.body,
    repo: session.repo,
    host: hostFor(session.repo),
  });
  log(`notice/${session.repo.name} → ${created?.id ?? JSON.stringify(created)} (${notice.notificationType})`);
}

/* -------------------------------------------------------------------- run */

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (!health?.ok) {
  console.error(`pitwall に繋がりません: ${BASE} — 先に npm start を動かしてください`);
  process.exit(1);
}

const pool = WITH_IMAGES ? await ensureImagePool() : [];
const sessions = makeSessions();

log(`feeding ${BASE} — ${MIN_MS / 1000}〜${MAX_MS / 1000}s おき, 画像 ${pool.length} 枚 (Ctrl-C で停止)`);

let sent = 0;
let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
  log('停止します');
  process.exit(0);
});

while (!stopping && sent < COUNT) {
  await sleep(rand(MIN_MS, MAX_MS));

  const roll = Math.random();
  try {
    if (roll < 0.15) {
      await feedNotice(pick(sessions));
    } else {
      const claude = roll < 0.6;
      const session = pick(sessions.filter((s) => (claude ? s.agent === 'claude' : s.agent === 'cursor')));
      if (claude) await feedClaude(session, pool);
      else await feedCursor(session, pool);
    }
  } catch (error) {
    log(`送信に失敗: ${error.message}`);
  }
  sent += 1;
}
