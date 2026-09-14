/**
 * The profile patch that mounts the agent-preset roster `/mode` needs.
 *
 * A terminal profile built on `dsh-base` composes no preset roster (only the
 * Web bundle does), and this plugin's own bundle patch may not mount one: DSH
 * STORE accepts additive rows with plugin-owned ids and no `@deepseek-ai/*`
 * module names. The profile's user layer is the supported home for the row, so
 * both the install script and the running TUI write the same block here — the
 * TUI needs it because `dsh plugin add dsh-ssh-tui@latest` (the in-app update
 * path) never runs `scripts/`, which npm installs do not ship.
 *
 * The roster is not cosmetic: without it `/mode` cannot switch, and the tools
 * the shipped presets own (`ask_user_question`, `present`, PTC's presentation)
 * are absent from the agent's catalog.
 * @module dsh-ssh-tui/preset-rows
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * The exact profile patch block that mounts the roster and the two host
 * services the shipped presets need. `scripts/ensure-profile-rows.sh` carries
 * the same text; a test compares the two so they cannot drift.
 */
export const ROSTER_PATCH_BLOCK = `# dsh-ssh-tui /mode: the agent-preset roster (standard / minimal / PTC /
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

/** The profile patch file the roster block belongs in. */
export function rosterPatchPath(home: string, profile: string): string {
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/**
 * The patch text with the roster block appended, or `undefined` when the file
 * already names the roster row.
 *
 * A file that is exactly `[]` (the profile template) is replaced, so the result
 * stays a valid top-level patch list; anything else keeps its content and the
 * block is appended after a blank line.
 * @param existing - the patch file's current text.
 * @returns the new text, or `undefined` when nothing has to change.
 */
export function rosterPatchText(existing: string): string | undefined {
  if (/name:\s*'@deepseek-ai\/dsh-agent-presets'/.test(existing)) return undefined
  if (/^\s*\[\s*\]\s*$/m.test(existing)) return existing.replace(/^\s*\[\s*\]\s*$/m, ROSTER_PATCH_BLOCK.trimEnd() + '\n')
  return `${existing.endsWith('\n') ? existing : `${existing}\n`}\n${ROSTER_PATCH_BLOCK}`
}

/** The template a missing profile patch starts from. */
const PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]

`

/**
 * Mount the roster in one profile, unless it is already composed.
 *
 * Idempotent: a profile whose patch already names the roster row (one bundling
 * `@deepseek-ai/dsh-web-app`, for example) is left untouched. The write is a
 * plain whole-file replace because the file is small and read once at boot; a
 * half-written patch would only be seen by the next launch.
 * @param home - the harness home carrying `profiles/`.
 * @param profile - the profile to patch.
 * @returns `present` when the row already exists, else `written`.
 */
export async function ensureRosterRows(home: string, profile: string): Promise<'present' | 'written'> {
  const path = rosterPatchPath(home, profile)
  let existing = PATCH_TEMPLATE
  try {
    existing = await readFile(path, 'utf8')
  } catch {
    // Missing file: start from the template the launcher would have written.
  }
  const next = rosterPatchText(existing)
  if (next === undefined) return 'present'
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, next, 'utf8')
  return 'written'
}
