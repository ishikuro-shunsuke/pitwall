# pitwall

すべての coding agent（Cursor IDE / Claude Code）の **入力待ち** を、ひとつのローカル Web タイムラインに集約する。

- `http://127.0.0.1:4477/` でブラウザから見る
- 各エントリはリポジトリ・ブランチ・model / effort / option・待ち開始時刻・本文・画像
- 返信すると、同じチャット／セッションに打ち返される
- 依存パッケージなし（Node.js 20+ のみ）

## Quick start

```bash
cd ~/ishikuro-shunsuke/pitwall   # このリポジトリ
npm start                       # → http://127.0.0.1:4477/
```

別ターミナルで、ホームにフックを一括登録:

```bash
npm run install-hooks
```

Cursor を再起動（または Hooks 設定を開き直す）、Claude Code は新しいセッションを開く。あとは各エージェントがターンを終えるたびに pitwall にカードが出る。

外すとき:

```bash
npm run uninstall-hooks
```

## フックは `~/` に一括でよい

プロジェクトごとの `.cursor/hooks.json` / `.claude/settings.json` は不要。

| エージェント | 登録先 | スコープ |
|---|---|---|
| Cursor | `~/.cursor/hooks.json` | 全プロジェクト |
| Claude Code | `~/.claude/settings.json` | 全プロジェクト |

`npm run install-hooks` は既存のフックを消さず、pitwall 用エントリだけをマージする。書き込み前に `.bak.<timestamp>` を残す。何度実行しても増殖しない。

登録されるイベント:

- **Cursor**: `afterAgentResponse`（本文バッファ + 画像アップロード）+ `stop`（待ち受け / 打ち返し）
- **Claude Code**: `Stop`（待ち受け / 打ち返し）+ `Notification`（permission / idle などを notice として表示）

## フックは「コピー」される（このリポジトリに依存しない）

インストーラはスクリプトを参照するのではなく、各エージェントの設定ディレクトリに**コピー**する:

```
~/.cursor/hooks/pitwall/{lib,cursor-stop,cursor-after-response}.mjs
~/.claude/hooks/pitwall/{lib.mjs,claude-stop.mjs,claude-notification.sh}
```

生成されるコマンドに絶対パスは現れない。Cursor はユーザーフックを cwd `~/.cursor/` で実行するので相対パス、Claude Code はシェル経由なので `$HOME` を使う:

```jsonc
// ~/.cursor/hooks.json
{ "command": "node ./hooks/pitwall/cursor-stop.mjs", "timeout": 1920, "loop_limit": null }

// ~/.claude/settings.json
{ "type": "command", "command": "node \"$HOME/.claude/hooks/pitwall/claude-stop.mjs\"", "timeout": 1920 }
```

これが DevContainer で効いてくる。`~/.cursor` と `~/.claude` をマウントすれば、$HOME の実体が別ユーザーでも同じ設定がそのまま動く。pitwall リポジトリをコンテナにマウントする必要はない。

## DevContainer から使う

```bash
npm run install-hooks:devcontainer
```

これで hooks.json / settings.json のコマンドに  
`--url "http://host.docker.internal:4477"`（Notification は `PITWALL_URL=...`）が埋め込まれる。  
`containerEnv` で URL を渡す必要はない。

あとは:

1. **設定ディレクトリをマウント**（フック本体もこの中にいる）:

```jsonc
"mounts": [
  "source=${localEnv:HOME}/.cursor,target=/home/vscode/.cursor,type=bind",
  "source=${localEnv:HOME}/.claude,target=/home/vscode/.claude,type=bind"
]
```

2. **compose で名前解決**（無いことが多い）:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

3. **サーバを `0.0.0.0` で待ち受ける。** `npm start` が既にそうしている。

注意: 埋め込んだ URL はホスト上のエージェントにも効く。Docker Desktop なら多くの場合そのまま届く。ホスト専用に戻すときは `npm run install-hooks`（引数なし）をやり直す。

コンテナ内のパス（`/workspaces/...`）はホストの Cursor で開けないため、そのエントリの IDE ジャンプリンクは機能しない。リポジトリ名・ブランチ・本文・画像は普通に届く。

## 待ち受けの挙動（ハイブリッド保持）

打ち返しを同一スレッドに届ける唯一の手段は、stop フックを終わらせずに long-poll すること。その間エージェントは「実行中」のまま凍結する（トークン消費なし）。

| 条件 | 結果 |
|---|---|
| 何もしない | **90 秒**で自動解放 → エントリは `expired`、エージェントは通常停止 |
| 返信コンポーザを開いている | 20 秒ごとにハートビート → 期限を 90 秒延長、**最大 30 分** |
| 返信する | フックが `followup_message` / `decision:block` を返し、同一スレッドで継続 |
| 返信せず閉じる | フックは `{}` を返して通常停止 → `dismissed` |
| IDE 側で Stop / Esc | 接続断 → `detached` |

フックランナー側の `timeout` は 1920 秒（> 30 分）にしてあり、必ず pitwall 側が先に静かに解放する。ランナーが先に殺すとトランスクリプトにフックエラーが残るため。

## model / effort / option

**表示のみ。** Cursor / Claude Code のどちらのフックにも、外部から model / effort を切り替える出力フィールドは無い。

- Cursor: `model`, `model_id`, `model_params`（thinking / context / effort）
- Claude Code: transcript JSONL 末尾から `message.model` を読む。加えて `effort.level`, `permission_mode`, `agent_type`

## 画像

本文中の `![](...)`, `<img src>`, `file://`, 拡張子付きパスを拾う。抽出とファイル読み取りは**フック側**で行い、バイト列を `POST /api/hooks/images` でアップロードする。サーバはパスを一切解決しない。コンテナ内のエージェントが送ってきた `/workspaces/...` はホストには存在しないので、サーバに読ませる設計だと成立しない。

内容の SHA-256 でアドレスされるため、同じ画像は一度しか保存されない。フックは `HEAD /api/hooks/images/<sha>.<ext>` で先に存在確認し、あればアップロードを省く。パイプラインが出力を上書きしても、タイムラインには当時の絵が残る。

`http(s)://` と `data:` の参照は取り込まない。

## IDE へのジャンプ（WSL）

WSL では `cursor://file//home/...` は Windows 側パスとして解決されて動かない。フックが `WSL_DISTRO_NAME` を送り、サーバが

```
cursor://vscode-remote/wsl+Ubuntu/<path>
```

を組み立てる。Claude Code のエントリには `claude --resume <session_id>` のコピーボタンもある。

## 制約（知っておくこと）

1. **Claude Code は連続 8 回で強制打ち切り。** ターミナルで一度も直接入力せずにブラウザから打ち返せるのは 8 往復まで。近づくとカードに警告が出る。
2. **Cursor の `loop_limit` は `null`（無制限）で登録する。** 既定の 5 だと打ち返し 5 回で止まる。
3. **pitwall サーバが落ちている / 起動していないときは fail open。** フックは 1.5–2 秒で諦めて `{}` を返し、エージェントは普段どおり停止する。普段の作業は壊れない。
4. **サーバ再起動中の `waiting` エントリは `expired` になる。** long-poll 接続が切れるため。
5. **model 変更はできない**（上記）。

## 環境変数

| 変数 | 既定 | 意味 |
|---|---|---|
| `PITWALL_HOST` | `0.0.0.0`（`npm start`） / コード既定は `127.0.0.1` | bind |
| `PITWALL_PORT` | `4477` | port |
| `PITWALL_URL` | `http://127.0.0.1:4477` | フックが叩く先（DevContainer では `http://host.docker.internal:4477`） |
| `PITWALL_HOLD_SECONDS` | `90` | 無操作での解放 |
| `PITWALL_MAX_HOLD_SECONDS` | `1800` | ハートビート込みの上限 |
| `PITWALL_DATA` | `./data` | 永続化ディレクトリ |

## 開発

```bash
npm start          # 本番同等
npm run dev        # --watch
npm run smoke      # API の end-to-end 検証
```

データは `data/entries.json` と `data/images/` に保存される（`.gitignore` 済み）。
