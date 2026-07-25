# pitwall

Cursor と Claude Code が**あなたの入力を待っている**状態を、ブラウザのひとつのタイムラインにまとめて表示する。そこから返信すると、同じチャット／セッションにそのまま届く。ローカル完結・依存パッケージなし（Node.js 20+）。

## 使いはじめる

```bash
npm start              # → http://127.0.0.1:4477/
npm run install-hooks  # 別ターミナルで一度だけ
```

フックが読み込まれるのは Cursor は再起動後、Claude Code は次のセッションから。外すのは `npm run uninstall-hooks`。

## 返信する

Cursor は返信が来るまでエージェントを止めて待つ。放っておくと 90 秒で通常どおり停止し、返信欄を開いている間は最大 30 分まで待ち続ける。

Claude Code は待たない。セッションはいつもどおり停止しているので手元でそのまま続きを打ってもよく、30 分以内にカードから返信すればそこから起き上がって続ける。同じセッションが先に次の停止をすると、古いカードは期限切れになる。

返信した文章そのものは Claude Code の画面には出ない。Claude が最初に一度引用するので、そこで読む。

## DevContainer

コンテナの中で実行する。`.devcontainer/devcontainer.json` の `postCreateCommand` に置けば、作り直すたびに入る:

```bash
curl -fsSL https://raw.githubusercontent.com/ishikuro-shunsuke/pitwall/main/install.sh \
  | sh -s -- --devcontainer
```

コンテナからは `host.docker.internal` 経由でホストの pitwall に繋ぐ。それが引けない環境なら、インストーラが必要な設定を出力する。

消すときは同じように:

```bash
curl -fsSL https://raw.githubusercontent.com/ishikuro-shunsuke/pitwall/main/cleanup.sh | sh
```

## 開発

`npm run dev`（`--watch`）、`npm run smoke`（end-to-end 検証）。既定値は `src/config.mjs`、`PITWALL_*` で上書きできる。