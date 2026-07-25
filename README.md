# pitwall

Cursor と Claude Code が**あなたの入力を待っている**状態を、ブラウザのひとつのタイムラインにまとめて表示する。そこから返信すると、同じチャット／セッションにそのまま届く。ローカル完結・依存パッケージなし（Node.js 20+）。

## 使いはじめる

```bash
npm start              # → http://127.0.0.1:4477/
npm run install-hooks  # 別ターミナルで一度だけ
```

Cursor は再起動、Claude Code は新しいセッションを開く。以降エージェントがターンを終えるたびにカードが出る。リポジトリ・ブランチ・model・本文・スクリーンショットが載っていて、その場で返信できる。

やめるときは `npm run uninstall-hooks`。

## 返信できる時間

| あなたの操作 | エージェント |
|---|---|
| 何もしない | 90 秒待って通常どおり停止する |
| 返信欄を開いている | 最大 30 分まで待ち続ける |
| 返信する | 同じスレッドで作業を続ける |

待っている間エージェントは止まっているだけで、トークンは消費しない。

## DevContainer

コンテナの中で一度実行する。リポジトリのマウントは要らない:

```bash
curl -fsSL https://raw.githubusercontent.com/ishikuro-shunsuke/pitwall/main/install.sh \
  | sh -s -- --devcontainer
```

`postCreateCommand` に置いておくとよい。ホスト側で `npm start` しておけばコンテナから届く。docker compose では名前解決を足す必要があることが多い:

```yaml
extra_hosts: ["host.docker.internal:host-gateway"]
```

## 知っておくこと

- **Claude Code へブラウザから返信できるのは連続 8 回まで。** 超えるとセッションが打ち切られるので、近づくとカードが警告する。ターミナルで一度入力すればリセットされる。
- **model / effort は表示だけ。** ブラウザから切り替えることはできない。
- **pitwall を起動していなくてもエージェントは普通に動く。** 数秒で諦めて通常どおり停止する。

## 設定

環境変数: `PITWALL_PORT`（既定 `4477`）、`PITWALL_HOLD_SECONDS`（`90`）、`PITWALL_MAX_HOLD_SECONDS`（`1800`）、`PITWALL_DATA`（`./data`）。フックからの接続先を変えるなら `PITWALL_URL`。

インストーラが触るのは `~/.cursor/hooks.json` と `~/.claude/settings.json` の 2 つだけで、pitwall 用のフックを追記する（既存の設定は消さず `.bak.<timestamp>` を残す。何度実行しても増殖しない）。フック本体は各設定ディレクトリにコピーされるので、このリポジトリを移動・削除しても動き続ける。

## 開発

`npm run dev`（`--watch`）、`npm run smoke`（end-to-end 検証）。データは `data/`。
