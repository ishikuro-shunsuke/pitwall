#!/usr/bin/env bash
# Stop hook: 作業ツリーが汚れたままターンが終わろうとしたら Claude を叩き起こす。
# exit 2 でその旨を stderr に出すと、Claude が差分を読んで commit + push しに戻る。
set -uo pipefail

input=$(cat)

# このフックで一度起こした後の Stop では何もしない（ループ防止）。
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0

cd "$(printf '%s' "$input" | jq -r '.cwd // "."')" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

dirty=$(git status --porcelain)
[ -z "$dirty" ] && exit 0

branch=$(git rev-parse --abbrev-ref HEAD)
cat >&2 <<EOF
未コミットの変更が残っています (branch: $branch):
$dirty

差分を読んで、意味の分かるメッセージで commit し origin/$branch に push してください。
意図的に残している変更・作りかけなら、commit せずその旨を一言伝えて終了してかまいません。
EOF
exit 2
