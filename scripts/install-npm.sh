#!/usr/bin/env bash
# Install dsh-ssh-tui from the npm registry into a dsh profile.
#
# Thin wrapper around scripts/install-npm.mjs, which is what runs on Windows
# (`node scripts/install-npm.mjs`). This file stays so `bash scripts/install-npm.sh`
# keeps working.
#
# Usage:
#   bash scripts/install-npm.sh [profile]   # default: tui (or $DSH_TUI_PROFILE)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "${REPO_DIR}/scripts/install-npm.mjs" "$@"
