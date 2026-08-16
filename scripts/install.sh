#!/usr/bin/env bash
# Build dsh-ssh-tui and link it into a dsh profile.
#
# Usage:
#   bash scripts/install.sh [profile]     # default: tui (or $DSH_TUI_PROFILE)
set -euo pipefail

PROFILE="${1:-${DSH_TUI_PROFILE:-tui}}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v dsh >/dev/null 2>&1; then
  echo "error: 'dsh' not found on PATH (install @deepseek-ai/dsh first)" >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: 'pnpm' not found on PATH (install pnpm first)" >&2
  exit 1
fi

echo "==> installing dependencies"
npm install --no-audit --no-fund

echo "==> building dsh-ssh-tui"
npm run build

echo "==> linking into dsh profile '$PROFILE'"
dsh plugin --profile "$PROFILE" add "link:${REPO_DIR}"

echo "==> done"
echo "start with:          dsh --profile $PROFILE"
echo "verify with:         bash scripts/verify.sh $PROFILE"
echo "uninstall with:      bash scripts/uninstall.sh $PROFILE"
