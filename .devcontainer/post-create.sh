#!/usr/bin/env bash
# Dev Container 起動後: 環境を軽く確認して、コンテナ自身の $HOME にフックを入れる。
# 失敗してもコンテナは使える。
set -u

ok() { printf '  OK  %s\n' "$*"; }
ng() { printf '  !!  %s\n' "$*"; }

echo "==> post-create checks"

# 20.6 未満だとサーバもフックも動かない。image を上げたときにここで気づく。
if node -e 'const [a,b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 6) ? 0 : 1)'; then
  ok "node $(node -p 'process.versions.node')"
else
  ng "node $(node -p 'process.versions.node') — package.json の engines は >=20.6"
fi

for c in git gh; do
  command -v "$c" >/dev/null 2>&1 && ok "$c" || ng "$c missing"
done

# origin は HTTPS で、gh を credential helper に使う。ホストの .gitconfig に
# 既に入っていても setup-git は冪等なので毎回流して確実にする。
if gh auth setup-git >/dev/null 2>&1; then
  ok "gh auth setup-git"
else
  ng "gh auth setup-git 失敗"
fi
if gh auth status >/dev/null 2>&1; then
  ok "gh authenticated (~/.config/gh をホストと共有)"
else
  ng "gh 未ログイン — HTTPS remote に push できない。gh auth login、またはホスト側の gh auth status を確認"
fi

# Claude Code CLI。単一バイナリなので native installer で ~/.local/bin に置く。
# npm グローバルに入れる feature 方式だと root 所有のまま出来上がり、claude 自身の
# auto-update が毎回そこへの書き込みで失敗する。以後の更新は claude update に任せる。
export PATH="$HOME/.local/bin:$PATH"
echo "==> claude code cli"
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash
fi
command -v claude >/dev/null 2>&1 && ok "claude" || ng "claude install failed"

# herdr。claude と同じく単一バイナリなので native installer で ~/.local/bin に置く。
echo "==> herdr"
if ! command -v herdr >/dev/null 2>&1; then
  curl -fsSL https://herdr.dev/install.sh | sh
fi
command -v herdr >/dev/null 2>&1 && ok "herdr" || ng "herdr install failed"

# root が作ったものを node に渡す。ボリュームは空で作られると root 所有になり、
# 作り直すたびに戻るので毎回ここで直す。
echo "==> hand root's work to node"
d="$HOME/.claude"
if [ -d "$d" ]; then
  if [ -O "$d" ]; then
    ok "$d"
  elif sudo chown -R node:npm "$d" && sudo chmod -R g+w "$d"; then
    ok "$d  (root 所有だったので渡した)"
  else
    ng "$d  を渡せなかった"
  fi
fi

echo "==> install hooks"
# ここの ~/.cursor と ~/.claude はコンテナ専用（ホストとは共有していない）。
# 送信先は既定の 127.0.0.1:4477 = このコンテナで npm start した pitwall。
npm run install-hooks

echo "==> done. npm start → ホストのブラウザから http://127.0.0.1:4477/"
