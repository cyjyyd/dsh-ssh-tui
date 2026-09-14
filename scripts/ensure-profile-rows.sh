#!/usr/bin/env bash
# Mount the agent-preset roster the TUI's /mode needs into a dsh profile.
#
# `dsh-base` composes no preset roster in a terminal profile, and this plugin's
# own bundle patch may not mount one: DSH STORE accepts additive rows with
# plugin-owned ids and no @deepseek-ai/* module names. The profile's user patch
# layer is the supported home for them, so this script materializes:
#
#   agent-presets                     the roster /mode lists and switches
#   code-runtime                      the TypeScript runtime the ptc preset needs
#   subagent-model-selection-settings the host-owned subagent delegation setting
#
# Idempotent: a profile that already composes @deepseek-ai/dsh-agent-presets
# (one bundling @deepseek-ai/dsh-web-app, for example) is left untouched.
# Adding such a bundle to a profile that ALREADY has this block would list the
# roster row twice, and the second mount fails ("service ... has been
# registered"): remove the block below from the profile patch first.
#
# Usage:
#   bash scripts/ensure-profile-rows.sh [profile]   # default: tui (or $DSH_TUI_PROFILE)
set -euo pipefail

PROFILE="${1:-${DSH_TUI_PROFILE:-tui}}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PATCH_FILE="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"

if ! command -v dsh >/dev/null 2>&1; then
  echo "error: 'dsh' not found on PATH (install @deepseek-ai/dsh first)" >&2
  exit 1
fi

if dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -q "@deepseek-ai/dsh-agent-presets"; then
  echo "==> profile '$PROFILE' already composes the agent-preset roster"
  exit 0
fi

if [ ! -f "$PATCH_FILE" ]; then
  echo "==> creating profile patch file at $PATCH_FILE"
  mkdir -p "$(dirname "$PATCH_FILE")"
  printf '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n' > "$PATCH_FILE"
fi

echo "==> mounting the agent-preset roster in profile '$PROFILE'"
PATCH_FILE="$PATCH_FILE" node <<'NODE'
const fs = require('node:fs')

const file = process.env.PATCH_FILE
let text = fs.readFileSync(file, 'utf8')
if (/name:\s*'@deepseek-ai\/dsh-agent-presets'/.test(text)) {
  console.log('    patch already names the roster row; leaving it as it is')
  process.exit(0)
}
const block = `# dsh-ssh-tui /mode: the agent-preset roster (standard / minimal / PTC /
# cordis, plus every preset under $DSH_HOME/.agent-presets) and the two host
# services the shipped presets need. dsh-base composes no roster in a terminal
# profile, and a third-party bundle patch may not mount an @deepseek-ai row, so
# the profile's user layer owns them.
- insert:
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard

    - id: code-runtime
      name: '@deepseek-ai/dsh-code-runtime-worker-thread'

    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
`

if (/^\s*\[\s*\]\s*$/m.test(text)) {
  text = text.replace(/^\s*\[\s*\]\s*$/m, block.trimEnd() + '\n')
} else {
  if (!text.endsWith('\n')) text += '\n'
  text += '\n' + block
}
fs.writeFileSync(file, text)
NODE

echo "==> done"
echo "restart the TUI for /mode to pick up the roster: dsh --profile $PROFILE"
