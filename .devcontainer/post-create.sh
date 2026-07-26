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

# origin は HTTPS で、ホストの .gitconfig が credential helper に gh を指名して入ってくる。
# gh がログイン済みでないと push どころか git ls-remote から落ちる。
if gh auth status >/dev/null 2>&1; then
  ok "gh authenticated (~/.config/gh をホストと共有)"
else
  ng "gh 未ログイン — HTTPS remote に push できない。gh auth login、またはホスト側の gh auth status を確認"
fi

echo "==> install hooks"
# ここの ~/.cursor と ~/.claude はコンテナ専用（ホストとは共有していない）。
# 送信先は既定の 127.0.0.1:4477 = このコンテナで npm start した pitwall。
npm run install-hooks

echo "==> done. npm start → ホストのブラウザから http://127.0.0.1:4477/"
