# pitwall

Cursor と Claude Code が**あなたの入力を待っている**状態を、ブラウザのひとつのタイムラインにまとめて表示する。そこから返信すると、同じチャット／セッションにそのまま届く。ローカル完結・依存パッケージなし（Node.js 20+）。

## 使いはじめる

```bash
npm start              # → http://127.0.0.1:4477/
npm run install-hooks  # 別ターミナルで一度だけ
```

フックが読み込まれるのは Cursor は再起動後、Claude Code は次のセッションから。

## 返信する

| あなたの操作 | エージェント |
|---|---|
| 何もしない | 90 秒待って通常どおり停止する |
| 返信欄を開いている | 最大 30 分まで待ち続ける |

Claude Code へ連続で返信できるのは 8 回まで。超えるとセッションが打ち切られるので、近づくとカードが警告する。ターミナルで一度入力すればリセットされる。

## DevContainer

コンテナの中で実行する:

```bash
curl -fsSL https://raw.githubusercontent.com/ishikuro-shunsuke/pitwall/main/install.sh \
  | sh -s -- --devcontainer
```

`postCreateCommand` に置く。docker compose の場合は名前解決を追加する:

```yaml
extra_hosts: ["host.docker.internal:host-gateway"]
```

## 設定

`PITWALL_PORT`（既定 `4477`）、`PITWALL_HOLD_SECONDS`（`90`）、`PITWALL_MAX_HOLD_SECONDS`（`1800`）、`PITWALL_DATA`（`./data`）、`PITWALL_URL`（フックからの接続先）。

インストーラが書き込むのは次の 4 か所。設定ファイルは既存の内容を消さず pitwall のフックを追記し、`.bak.<timestamp>` を残す。

```
~/.cursor/hooks.json      ~/.cursor/hooks/pitwall/   ← lib.mjs, cursor-stop.mjs, cursor-after-response.mjs
~/.claude/settings.json   ~/.claude/hooks/pitwall/   ← lib.mjs, claude-stop.mjs, claude-notification.mjs
```

`npm run uninstall-hooks` は追記した設定と `hooks/pitwall/` ディレクトリを削除する。

## 開発

`npm run dev`（`--watch`）、`npm run smoke`（end-to-end 検証）。
