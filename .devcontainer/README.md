# Dev Container (Cursor)

Cursor で「Reopen in Container」すると、pitwall を開発・実行できるシェルが立つ。

1. Cursor でこのリポを開く（WSL 側のパス）
2. Command Palette → **Dev Containers: Reopen in Container**
3. `post-create.sh` の出力が全部 `OK` であること
4. `npm start` → ホストのブラウザで http://127.0.0.1:4477/（4477 は転送済み）

依存パッケージは無いので `npm install` は要らない。`npm test` はどちらのテストも一時ディレクトリで完結する。

## 中身

| 層 | 何が入るか | どこで定義 |
|----|-----------|-----------|
| image | Node.js 22（`engines` の下限は 20.6） | `devcontainer.json` |
| CLI | `gh`（GitHub CLI） | `features` |
| CLI | `claude`（Claude Code） | `post-create.sh`（native installer、`~/.local/bin`） |

## フックはコンテナの $HOME に入る

`post-create.sh` が `npm run install-hooks` を走らせ、**コンテナ自身の** `~/.cursor` と `~/.claude` に
フックを置く。コンテナ内の agent が止まると、同じコンテナの `127.0.0.1:4477` に立てた pitwall へ届く。

**ホストの `~/.cursor` / `~/.claude` は意図的に bind していない。** このリポで日常的に走らせる
`install-hooks` / `uninstall-hooks` がまさにその2つを書き換えるツールで、共有するとコンテナ内の実行が
ホストのフック設定を壊す（`--devcontainer` はホストのフックまで `host.docker.internal` に向けてしまう）。

代償として、コンテナ内の Claude Code は一度 `claude` を起動してログインし直す必要がある。
ホーム側のグローバル skill / hook もコンテナには入らない。

サーバをホストで動かし、コンテナの agent からそこへ送りたいときは:

```bash
npm run install-hooks:devcontainer
```

`host.docker.internal` は `runArgs` の `--add-host` で解決できるようにしてある。

## gh は「あると便利」ではなく必須

`post-create.sh` が毎回 `gh auth setup-git` を流すので、ホスト側の `.gitconfig` に何が入っていたかに関わらず

```
credential.https://github.com.helper = !gh auth git-credential
```

が入る。origin は HTTPS なので、**gh が無いと `git ls-remote` / `git push` が
`could not read Username` で落ちる。**

`~/.config/gh` の bind でホストのログインセッションを共有する。注意:

- **共有は双方向**。コンテナ内で `gh auth logout` するとホスト側のセッションも消える。
- ホストに `~/.config/gh` が無い状態で rebuild すると Docker が root 所有で作り、gh が書けない。
  先にホストで `gh auth status` を通してから rebuild する。
- ホストの gh が OS キーリングにトークンを置いていると `hosts.yml` に `oauth_token` が無く、
  コンテナ側は未ログインになる。その場合はコンテナ内で一度 `gh auth login`（結果はホストにも反映）。

## data/

`./data`（タイムライン本体）はワークスペース内なのでホストと共有され、rebuild では消えない。
コンテナで動かした pitwall とホストで動かした pitwall は同じファイルを見る。同時に起動しない。
