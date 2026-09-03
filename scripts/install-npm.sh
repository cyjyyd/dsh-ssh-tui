#!/usr/bin/env bash
# Install dsh-ssh-tui from the npm registry into a dsh profile.
#
# Prerequisite: DeepSeek Harness CLI (`npm i -g @deepseek-ai/dsh`) and pnpm.
#
# Usage:
#   bash scripts/install-npm.sh [profile]   # default: tui (or $DSH_TUI_PROFILE)
set -euo pipefail

PROFILE="${1:-${DSH_TUI_PROFILE:-tui}}"

if ! command -v dsh >/dev/null 2>&1; then
  echo "error: 'dsh' not found on PATH (install @deepseek-ai/dsh first)" >&2
  exit 1
fi

echo "==> adding dsh-ssh-tui from npm into dsh profile '$PROFILE'"
dsh plugin --profile "$PROFILE" add dsh-ssh-tui@latest

echo "==> done"
echo "start with:     dsh --profile $PROFILE"
echo "verify with:    bash scripts/verify.sh $PROFILE"
echo "uninstall with: dsh plugin --profile $PROFILE remove dsh-ssh-tui"
