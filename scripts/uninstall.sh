#!/usr/bin/env bash
# Remove dsh-ssh-tui from a dsh profile.
#
# Thin wrapper around scripts/uninstall.mjs (`node scripts/uninstall.mjs` on
# Windows). This file stays so `bash scripts/uninstall.sh` keeps working.
#
# Usage:
#   bash scripts/uninstall.sh [profile]   # default: tui (or $DSH_TUI_PROFILE)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "${REPO_DIR}/scripts/uninstall.mjs" "$@"
