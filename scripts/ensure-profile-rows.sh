#!/usr/bin/env bash
# Mount the agent-preset roster the TUI's /mode needs into a dsh profile.
#
# Thin wrapper: the logic lives in scripts/profile-rows.mjs, which is portable
# (the CI probe bootstrap calls it directly, so Windows gets the same roster
# without needing bash).
#
# Usage:
#   bash scripts/ensure-profile-rows.sh [profile]   # default: tui (or $DSH_TUI_PROFILE)
set -euo pipefail

PROFILE="${1:-${DSH_TUI_PROFILE:-tui}}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec node "${REPO_DIR}/scripts/profile-rows.mjs" "$PROFILE"
