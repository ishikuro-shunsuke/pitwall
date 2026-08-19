#!/usr/bin/env sh
# Remote bootstrapper for pitwall hooks.
#
# For environments where this repo isn't checked out or mounted (typically a
# DevContainer): shallow-clones pitwall into a temp dir and delegates to the
# real installer, bin/install-hooks.mjs. No bind mount of ~/.cursor or
# ~/.claude into the container is required — this installs straight into the
# container's own $HOME, scoped to that container.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ishikuro-shunsuke/pitwall/main/install.sh \
#     | sh -s -- --url https://pitwall.example.com
#
#   curl -fsSL https://raw.githubusercontent.com/ishikuro-shunsuke/pitwall/main/install.sh \
#     | sh -s -- --devcontainer
#
# Any argument accepted by bin/install-hooks.mjs (--devcontainer, --url,
# --uninstall) is forwarded as-is.
#
# Requires: git, node >= 20.6
set -eu

REPO_URL="${PITWALL_REPO_URL:-https://github.com/ishikuro-shunsuke/pitwall.git}"
REPO_REF="${PITWALL_REPO_REF:-main}"

command -v git >/dev/null 2>&1 || { echo "pitwall install: git is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "pitwall install: node >= 20.6 is required" >&2; exit 1; }

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

git clone --quiet --depth 1 --branch "$REPO_REF" "$REPO_URL" "$tmp_dir/pitwall"
node "$tmp_dir/pitwall/bin/install-hooks.mjs" "$@"
