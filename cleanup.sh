#!/usr/bin/env sh
# Remove pitwall from this machine and release anything it is still holding.
#
# Written for the DevContainer case, where install.sh put the hooks in $HOME and
# left no repo behind to run npm run uninstall-hooks from:
#
#   curl -fsSL https://raw.githubusercontent.com/ishikuro-shunsuke/pitwall/main/cleanup.sh | sh
#
#   1. kill hook processes still long-polling — a stop hook holds the agent's
#      turn open for up to 30 minutes, so these go first
#   2. strip the pitwall entries from ~/.cursor/hooks.json and
#      ~/.claude/settings.json, and delete the copied scripts
#   3. list the .bak.<timestamp> files, without deleting them
set -eu

REPO_URL="${PITWALL_REPO_URL:-https://github.com/ishikuro-shunsuke/pitwall.git}"
REPO_REF="${PITWALL_REPO_REF:-main}"

if pkill -f 'hooks/pitwall/[a-z-]*\.mjs' 2>/dev/null; then
  echo "killed hook processes that were still waiting on a reply"
fi
if pkill -f 'pitwall/src/server\.mjs' 2>/dev/null; then
  echo "stopped a pitwall server running here"
fi

if command -v git >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT INT TERM
  git clone --quiet --depth 1 --branch "$REPO_REF" "$REPO_URL" "$tmp_dir/pitwall"
  node "$tmp_dir/pitwall/bin/install-hooks.mjs" --uninstall
else
  # No git or node: the scripts can still go, but the config edits cannot be
  # undone safely without a JSON parser, so say so rather than guess.
  rm -rf "$HOME/.cursor/hooks/pitwall" "$HOME/.claude/hooks/pitwall"
  echo "removed the hook scripts"
  echo "git/node missing — delete the pitwall entries from these by hand:"
  echo "  $HOME/.cursor/hooks.json"
  echo "  $HOME/.claude/settings.json"
fi

backups=$(ls "$HOME"/.cursor/hooks.json.bak.* "$HOME"/.claude/settings.json.bak.* 2>/dev/null || true)
if [ -n "$backups" ]; then
  echo ""
  echo "backups left in place:"
  echo "$backups" | sed 's/^/  /'
fi

echo ""
echo "Cursor は再起動、Claude Code は新しいセッションを開くとフックが外れる"
