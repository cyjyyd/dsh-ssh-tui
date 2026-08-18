#!/usr/bin/env bash
# Install dsh-routing-suite into a dsh profile and materialize its
# "智能路由模式" preset so the TUI /mode menu can select it.
#
# Prerequisite: DeepSeek Harness CLI (`npm i -g @deepseek-ai/dsh`) and pnpm.
#
# Usage:
#   bash scripts/install-routing-suite.sh [profile]   # default: tui
set -euo pipefail

PROFILE="${1:-${DSH_TUI_PROFILE:-tui}}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

if ! command -v dsh >/dev/null 2>&1; then
  echo "error: 'dsh' not found on PATH (install @deepseek-ai/dsh first)" >&2
  exit 1
fi

echo "==> adding dsh-routing-suite into dsh profile '$PROFILE'"
dsh plugin --profile "$PROFILE" add dsh-routing-suite

PKG_DIR="$DSH_HOME/profiles/$PROFILE/node_modules/dsh-routing-suite"
if [ ! -d "$PKG_DIR/preset/routing-suite" ]; then
  echo "error: cannot find dsh-routing-suite preset at $PKG_DIR/preset/routing-suite" >&2
  exit 1
fi

DEST="$DSH_HOME/.agent-presets/routing-suite"
mkdir -p "$DSH_HOME/.agent-presets"
rm -rf "$DEST"
cp -R "$PKG_DIR/preset/routing-suite" "$DEST"

echo "==> done"
echo "start with: dsh --profile $PROFILE"
echo "then use /mode and select 智能路由模式 (routing-suite)"
