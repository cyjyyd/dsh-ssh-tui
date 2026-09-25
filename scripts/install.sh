#!/usr/bin/env bash
# Build dsh-ssh-tui and link it into a dsh profile.
#
# Thin wrapper: the logic lives in scripts/install.mjs, which is what runs on
# Windows too (`node scripts/install.mjs`). This file stays so the documented
# `bash scripts/install.sh` keeps working.
#
# Usage:
#   bash scripts/install.sh [profile]     # default: tui (or $DSH_TUI_PROFILE)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "${REPO_DIR}/scripts/install.mjs" "$@"
