#!/usr/bin/env bash
# Install dsh-routing-suite into a dsh profile and materialize its
# "智能路由模式" preset so the TUI /mode menu can select it.
#
# Thin wrapper around scripts/install-routing-suite.mjs
# (`node scripts/install-routing-suite.mjs` on Windows). This file stays so
# `bash scripts/install-routing-suite.sh` keeps working.
#
# Usage:
#   bash scripts/install-routing-suite.sh [profile]   # default: tui
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "${REPO_DIR}/scripts/install-routing-suite.mjs" "$@"
