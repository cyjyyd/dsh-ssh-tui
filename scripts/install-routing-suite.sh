#!/usr/bin/env bash
# Install dsh-routing-suite into a dsh profile and materialize its
# "智能路由模式" preset so the TUI /mode menu can select it.
#
# Prerequisite: DeepSeek Harness CLI (`npm i -g @deepseek-ai/dsh`) and pnpm.
#
# Usage:
#   bash scripts/install-routing-suite.sh [profile]   # default: tui
set -euo pipefail

PROFILE="${1:-${DSH_TUI_PROFILE:-tui}}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

if ! command -v dsh >/dev/null 2>&1; then
  echo "error: 'dsh' not found on PATH (install @deepseek-ai/dsh first)" >&2
  exit 1
fi

echo "==> adding dsh-routing-suite into dsh profile '$PROFILE'"
dsh plugin --profile "$PROFILE" add dsh-routing-suite

PKG_DIR="$DSH_HOME/profiles/$PROFILE/node_modules/dsh-routing-suite"
if [ ! -d "$PKG_DIR/preset/routing-suite" ]; then
  echo "error: cannot find dsh-routing-suite preset at $PKG_DIR/preset/routing-suite" >&2
  exit 1
fi

DEST="$DSH_HOME/.agent-presets/routing-suite"
mkdir -p "$DSH_HOME/.agent-presets"
rm -rf "$DEST"
cp -R "$PKG_DIR/preset/routing-suite" "$DEST"

# dsh-routing-suite injects the host `webServer` service to expose its
# read-only status API. dsh-base does not provide that service in a terminal
# profile, so mount the in-box loopback webserver on an OS-assigned port.
PATCH_FILE="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
if ! grep -q -- "name: '@deepseek-ai/dsh-host-webserver'" "$PATCH_FILE" 2>/dev/null; then
  echo "==> adding loopback webServer service for dsh-routing-suite"
  PATCH_FILE="$PATCH_FILE" node <<'NODE'
const fs = require('node:fs')

const file = process.env.PATCH_FILE
let text = fs.readFileSync(file, 'utf8')
const block = `# dsh-routing-suite injects the host webServer service to expose its
# read-only status API. dsh-base does not provide that service in a terminal
# profile, so mount the in-box loopback webserver on an OS-assigned port.
- insert:
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        host: '127.0.0.1'
        port: 0
`

if (/name:\s*'@deepseek-ai\/dsh-host-webserver'/.test(text)) process.exit(0)
if (/^\s*\[\s*\]\s*$/m.test(text)) {
  text = text.replace(/^\s*\[\s*\]\s*$/m, block.trimEnd() + '\n')
} else {
  if (!text.endsWith('\n')) text += '\n'
  text += '\n' + block
}
fs.writeFileSync(file, text)
NODE
fi

echo "==> done"
echo "start with: dsh --profile $PROFILE"
echo "then use /mode and select 智能路由模式 (routing-suite)"
