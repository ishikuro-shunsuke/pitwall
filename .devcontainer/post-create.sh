#!/usr/bin/env bash
# Dev Container 起動後。失敗してもコンテナは使える。
set -u

ok() { printf '  OK  %s\n' "$*"; }
ng() { printf '  !!  %s\n' "$*"; }

echo "==> tools"
# 20.6 未満だとサーバもフックも動かない。
if node -e 'const [a,b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 6) ? 0 : 1)'; then
  ok "node $(node -p 'process.versions.node')"
else
  ng "node $(node -p 'process.versions.node') — engines は >=20.6"
fi
for c in git gh; do
  command -v "$c" >/dev/null 2>&1 && ok "$c" || ng "$c missing"
done

echo "==> volumes"
# 空のボリュームは root 所有で来るので、何かが書く前に node に渡す。
hand() {
  d="$1"
  mkdir -p "$d" 2>/dev/null || sudo mkdir -p "$d"
  [ -O "$d" ] || sudo chown -R node:npm "$d" || { ng "$2"; return 1; }
  ok "$2"
}
hand "$HOME/.claude" "~/.claude" && sudo chmod -R g+w "$HOME/.claude"
hand "$HOME/.config/gh" "~/.config/gh"

echo "==> gh"
# origin は HTTPS で、gh を credential helper に使う。.gitconfig は毎回作り直される。
if ! gh auth status >/dev/null 2>&1; then
  ng "未ログイン — gh auth login"
elif gh auth setup-git >/dev/null 2>&1; then
  ok "authenticated"
else
  ng "gh auth setup-git 失敗"
fi

echo "==> cli"
# npm グローバルに入れると root 所有になり auto-update が落ちるので native installer。
export PATH="$HOME/.local/bin:$PATH"
command -v claude >/dev/null 2>&1 || curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1
command -v claude >/dev/null 2>&1 && ok "claude" || ng "claude install failed"
command -v herdr >/dev/null 2>&1 || curl -fsSL https://herdr.dev/install.sh | sh >/dev/null 2>&1
command -v herdr >/dev/null 2>&1 && ok "herdr" || ng "herdr install failed"

echo "==> hooks"
# herdr の hook は別グループなので pitwall の install-hooks とは衝突しない。
# 送信先は既定の 127.0.0.1:4477 = このコンテナで npm start した pitwall。
if command -v herdr >/dev/null 2>&1; then
  herdr integration install claude >/dev/null 2>&1 && ok "herdr" || ng "herdr integration install claude 失敗"
fi
npm run install-hooks --silent >/dev/null 2>&1 && ok "pitwall" || ng "npm run install-hooks 失敗"

echo "==> npm start → http://127.0.0.1:4477/"
