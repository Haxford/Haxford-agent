#!/usr/bin/env bash
# haxford launcher — makes `haxford` behave like `claude`/`pi` everywhere.
#
# - Inside a herdr pane (HERDR_ENV=1): splits a sibling pane in the current tab
#   and runs haxford there, so the TUI gets a real TTY and keys stay with the
#   user. Pass -p/--print (or -h/--help) to run inline instead, script-friendly.
# - Outside herdr (regular terminal): execs the binary directly.
set -euo pipefail

# Resolve the binary relative to this script (repo layout: bin/haxford.sh ->
# ../haxford), then fall back to whatever `haxford` is on PATH — an installed
# copy under ~/.local/bin. Hardcoding an absolute path pinned this launcher to
# one machine and one checkout.
_here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -x "$_here/../haxford" ]]; then
  BIN="$_here/../haxford"
elif command -v haxford >/dev/null 2>&1; then
  BIN="$(command -v haxford)"
else
  echo "haxford: binary not found (built it with 'bun run compile'?)" >&2
  exit 127
fi

if [[ "${HERDR_ENV:-}" == "1" ]] && command -v herdr >/dev/null 2>&1; then
  for a in "$@"; do
    case "$a" in -p | --print | -h | --help) exec "$BIN" "$@" ;; esac
  done

  pane_id="$(
    herdr pane split --current --direction right --cwd "$PWD" --no-focus \
      | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])'
  )"
  # Give the new shell a beat to reach its prompt, then start the TUI there.
  quoted="$(printf '%q ' "$BIN" "$@")"
  (sleep 0.8; herdr pane run "$pane_id" "exec $quoted" >/dev/null 2>&1) &
  disown
  exit 0
fi

exec "$BIN" "$@"
