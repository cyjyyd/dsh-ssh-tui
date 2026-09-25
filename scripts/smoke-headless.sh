#!/usr/bin/env bash
# Smoke the composed headless (or tui) profile over a live LLM route.
# Prints an outcome summary only — never tokens, never session logs.
#
# Thin wrapper around scripts/smoke-headless.mjs (`node scripts/smoke-headless.mjs`
# on Windows). This file stays so `bash scripts/smoke-headless.sh` keeps working.
#
# Usage:
#   bash scripts/smoke-headless.sh [profile]
#     profile   default: headless (or $DSH_TUI_SMOKE_PROFILE)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "${REPO_DIR}/scripts/smoke-headless.mjs" "$@"
