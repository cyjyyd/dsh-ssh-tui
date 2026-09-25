#!/usr/bin/env bash
# Verify the dsh-ssh-tui integration for one profile.
#
# Thin wrapper around scripts/verify.mjs (`node scripts/verify.mjs` on Windows).
# This file stays so `bash scripts/verify.sh` keeps working.
#
# Usage:
#   bash scripts/verify.sh [profile]      # default: tui (or $DSH_TUI_PROFILE)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "${REPO_DIR}/scripts/verify.mjs" "$@"
