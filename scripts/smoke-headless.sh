#!/usr/bin/env bash
# Smoke the composed headless (or tui) profile over a live LLM route.
# Prints an outcome summary only — never tokens, never session logs.
#
# Usage:
#   bash scripts/smoke-headless.sh [profile]
#     profile   default: headless (or $DSH_TUI_SMOKE_PROFILE)
# Official headless has no --provider flag; the live default in
# $DSH_HOME/settings.yaml (agent-default-model) is what gets smoked.
set -euo pipefail

PROFILE="${1:-${DSH_TUI_SMOKE_PROFILE:-headless}}"
PROMPT="${DSH_TUI_SMOKE_PROMPT:-Reply with exactly: tui-install-ok. Do not use tools.}"
OUT_DIR="${DSH_TUI_SMOKE_DIR:-$HOME/.config/dsh-publish/smoke}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$OUT_DIR/headless-$STAMP.log"

if ! command -v dsh >/dev/null 2>&1; then
  echo "error: 'dsh' not found on PATH" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR" 2>/dev/null || true

args=(--profile "$PROFILE")

echo "==> dsh ${args[*]} (prompt redacted from argv dump)"
set +e
# Capture stdout/stderr; the prompt is the last operand, not logged as a secret.
output="$(dsh "${args[@]}" "$PROMPT" 2>&1)"
status=$?
set -e

# Drop anything that looks like a bearer/token/key before writing the record.
redacted="$(printf '%s\n' "$output" | sed -E \
  -e 's/sk-[A-Za-z0-9_-]+/[redacted-key]/g' \
  -e 's/ghp_[A-Za-z0-9]+/[redacted-github]/g' \
  -e 's/npm_[A-Za-z0-9]+/[redacted-npm]/g' \
  -e 's/Bearer [A-Za-z0-9._-]+/Bearer [redacted]/g')"

{
  echo "stamp=$STAMP"
  echo "profile=$PROFILE"
  echo "provider=settings-default"
  echo "exit=$status"
  echo "prompt=$PROMPT"
  echo "---- stdout/stderr ----"
  printf '%s\n' "$redacted"
} > "$LOG"
chmod 600 "$LOG"

summary="$(printf '%s\n' "$redacted" | tr -d '\r' | awk 'NF{last=$0} END{print last}')"
echo "exit: $status"
echo "summary: ${summary:-(empty)}"
echo "record: $LOG"
if [[ "$status" -ne 0 ]]; then
  echo "error: headless smoke failed" >&2
  exit "$status"
fi
if ! printf '%s\n' "$redacted" | grep -Fq 'tui-install-ok'; then
  echo "warn: expected marker tui-install-ok not found in output" >&2
fi
echo "ok"
