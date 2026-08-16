#!/usr/bin/env bash
# Remove dsh-ssh-tui from a dsh profile.
#
# Usage:
#   bash scripts/uninstall.sh [profile]   # default: tui (or $DSH_TUI_PROFILE)
set -euo pipefail

PROFILE="${1:-${DSH_TUI_PROFILE:-tui}}"

if ! command -v dsh >/dev/null 2>&1; then
  echo "error: 'dsh' not found on PATH" >&2
  exit 1
fi

echo "==> removing dsh-ssh-tui from dsh profile '$PROFILE'"
dsh plugin --profile "$PROFILE" remove dsh-ssh-tui

echo "==> done"
