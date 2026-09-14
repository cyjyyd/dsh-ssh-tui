#!/usr/bin/env bash
# Verify the dsh-ssh-tui integration for one profile.
#
# Usage:
#   bash scripts/verify.sh [profile]      # default: tui (or $DSH_TUI_PROFILE)
set -euo pipefail

PROFILE="${1:-${DSH_TUI_PROFILE:-tui}}"

echo "==> composed profile contains dsh-ssh-tui"
dsh --profile "$PROFILE" --dump-config | grep -q 'name: dsh-ssh-tui'
echo "ok: dsh-ssh-tui is composed in profile '$PROFILE'"

echo "==> CLI parses"
dsh --profile "$PROFILE" --help >/dev/null
echo "ok: dsh --profile $PROFILE --help"

echo "==> composed profile mounts the agent-preset roster"
if dsh --profile "$PROFILE" --dump-config | grep -q "@deepseek-ai/dsh-agent-presets"; then
  echo "ok: /mode can list and switch presets"
else
  echo "warn: no agent-presets row composed, so /mode reports the service missing" >&2
  echo "      fix with: bash scripts/ensure-profile-rows.sh $PROFILE" >&2
fi

echo "==> done"
