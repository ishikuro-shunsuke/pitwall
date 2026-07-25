# pitwall

Cursor と Claude Code が**あなたの入力を待っている**状態を、ブラウザのひとつのタイムラインにまとめて表示する。そこから返信すると、同じチャット／セッションにそのまま届く。ローカル完結・依存パッケージなし（Node.js 20+）。

## 使いはじめる

```bash
npm start              # → http://127.0.0.1:4477/
npm run install-hooks  # 別ターミナルで一度だけ
```

フックが読み込まれるのは Cursor は再起動後、Claude Code は次のセッションから。外すのは `npm run uninstall-hooks`。

## 返信する


| あなたの操作    | エージェント           |
| --------- | ---------------- |
| 何もしない     | 90 秒待って通常どおり停止する |
| 返信欄を開いている | 最大 30 分まで待ち続ける   |


Claude Code へ連続で返信できるのは 8 回まで。超えるとセッションが打ち切られるので、近づくとカードが警告する。ターミナルで一度入力すればリセットされる。

## DevContainer

コンテナの中で実行する:

```bash
curl -fsSL https://raw.githubusercontent.com/ishikuro-shunsuke/pitwall/main/install.sh \
  | sh -s -- --devcontainer
```

`.devcontainer/devcontainer.json` の `postCreateCommand` に置く。

`host.docker.internal` は Docker Desktop ならそのまま引けるが、Linux の Docker Engine（Docker Desktop なしの WSL2 を含む）では自分で足す。`devcontainer.json` が `dockerComposeFile` を指しているなら、その compose ファイルの該当サービスに:

```yaml
services:
  app:
    extra_hosts: ["host.docker.internal:host-gateway"]
```

`image` か `dockerFile` を直接書いているなら、`devcontainer.json` に:

```jsonc
"runArgs": ["--add-host=host.docker.internal:host-gateway"]
```



## 開発

`npm run dev`（`--watch`）、`npm run smoke`（end-to-end 検証）。既定値は `src/config.mjs`、`PITWALL_*` で上書きできる。