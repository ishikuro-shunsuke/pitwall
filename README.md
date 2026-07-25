# pitwall

すべての coding agent（Cursor IDE / Claude Code）の **入力待ち** を、ひとつのローカル Web タイムラインに集約する。返信するとそのまま同じチャット／セッションに打ち返される。依存パッケージなし（Node.js 20+ のみ）。

## Quick start

```bash
npm start              # → http://127.0.0.1:4477/
npm run install-hooks  # 別ターミナルで、~/ にフックを登録
```

Cursor は再起動、Claude Code は新しいセッションを開くとフックが読み込まれる。外すのは `npm run uninstall-hooks`。

登録先は `~/.cursor/hooks.json` と `~/.claude/settings.json` の 2 つだけで全プロジェクトに効く。既存フックは消さず pitwall 用エントリだけをマージし、書き込み前に `.bak.<timestamp>` を残す。何度実行しても増殖しない。

| エージェント | イベント |
|---|---|
| Cursor | `afterAgentResponse`（本文 + 画像）/ `stop`（待ち受け・打ち返し） |
| Claude Code | `Stop`（待ち受け・打ち返し）/ `Notification`（permission / idle を notice 表示） |

フックはこのリポジトリを参照せず、各設定ディレクトリの `hooks/pitwall/` に**コピー**される。生成コマンドに絶対パスは出てこない（Cursor は cwd `~/.cursor` なので相対パス、Claude Code はシェル経由なので `$HOME`）。

## DevContainer から使う

リポジトリをマウントもクローンもせず、コンテナ内で完結する:

```bash
curl -fsSL https://raw.githubusercontent.com/ishikuro-shunsuke/pitwall/main/install.sh \
  | sh -s -- --devcontainer
```

`install.sh` は pitwall を一時ディレクトリに shallow clone して `bin/install-hooks.mjs` に引数を渡し、自分で消える。`--url http://example:4477` なども透過する。`postCreateCommand` に置くとよい（コンテナを作り直すたびに再実行が必要）。要件は git と node >= 20.6。

`--devcontainer` は URL `http://host.docker.internal:4477` をフックのコマンドに焼き込むので `containerEnv` は不要。加えて compose 側に名前解決が必要なことが多い:

```yaml
extra_hosts: ["host.docker.internal:host-gateway"]
```

ホストの `~/.cursor` / `~/.claude` をそのまま持ち込みたい場合は bind mount + ホスト側で一度 `npm run install-hooks:devcontainer` でもよい（どちらか片方）。焼き込んだ URL はホストのエージェントにも効くので、ホスト専用に戻すには引数なしの `npm run install-hooks` をやり直す。

コンテナ内パス（`/workspaces/...`）はホストの Cursor で開けないため、そのエントリの IDE ジャンプだけは機能しない。

## 待ち受けの挙動（ハイブリッド保持）

打ち返しを同一スレッドに届ける唯一の手段は、stop フックを終わらせずに long-poll すること。その間エージェントは「実行中」で凍結する（トークン消費なし）。

| 条件 | 結果 |
|---|---|
| 何もしない | **90 秒**で解放 → `expired`、エージェントは通常停止 |
| 返信コンポーザを開いている | 20 秒ごとにハートビートで延長、**最大 30 分** |
| 返信する | `followup_message` / `decision:block` を返し同一スレッドで継続 |
| 返信せず閉じる | `{}` を返して通常停止 → `dismissed` |
| IDE 側で Stop / Esc | 接続断 → `detached` |

フックランナーの `timeout` は 1920 秒（> 30 分）。必ず pitwall 側が先に解放する — ランナーが先に殺すとトランスクリプトにフックエラーが残るため。

## 画像

本文中の `![](...)` / `<img src>` / `file://` / 拡張子付きパスを拾う。抽出・読み取り・ハッシュ計算は**フック側**で行い、バイト列を `POST /api/hooks/images` にアップロードする（サーバはパスを解決しない。コンテナの `/workspaces/...` はホストに存在しないため）。内容の SHA-256 でアドレスされるので同じ画像は一度しか保存されず、フックは `HEAD /api/hooks/images/<sha>.<ext>` で先に確認してアップロードを省く。あとからファイルが上書きされてもタイムラインには当時の絵が残る。`http(s)://` と `data:` は取り込まない。

## 制約

1. **Claude Code は連続 8 回で強制打ち切り。** ターミナルで直接入力せずブラウザから打ち返せるのは 8 往復まで。近づくとカードが警告する。
2. **Cursor の `loop_limit` は `null`（無制限）で登録する。** 既定の 5 だと 5 回で止まる。
3. **model / effort は表示専用。** どちらのフックにも外部から切り替える出力フィールドが無い。
4. **サーバが落ちていれば fail open。** フックは 1.5–2 秒で諦めて `{}` を返し、エージェントは普段どおり停止する。
5. **サーバ再起動をまたいだ `waiting` は `expired` になる**（long-poll 接続が切れるため）。
6. WSL では `cursor://file//home/...` が Windows パスとして解決され動かないので、`WSL_DISTRO_NAME` を送って `cursor://vscode-remote/wsl+<distro>/<path>` を組み立てている。

## 環境変数

| 変数 | 既定 | 意味 |
|---|---|---|
| `PITWALL_HOST` | `0.0.0.0`（`npm start`） / コード既定 `127.0.0.1` | bind |
| `PITWALL_PORT` | `4477` | port |
| `PITWALL_URL` | `http://127.0.0.1:4477` | フックが叩く先 |
| `PITWALL_HOLD_SECONDS` | `90` | 無操作での解放 |
| `PITWALL_MAX_HOLD_SECONDS` | `1800` | ハートビート込みの上限 |
| `PITWALL_DATA` | `./data` | 永続化ディレクトリ |

## 開発

```bash
npm run dev    # --watch
npm run smoke  # end-to-end 検証（API + 実フックスクリプト）
```

データは `data/entries.json` と `data/images/`（`.gitignore` 済み）。
