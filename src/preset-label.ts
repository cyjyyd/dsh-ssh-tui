/**
 * Agent-preset display names, and the profile row the terminal `/mode` needs.
 *
 * A shipped preset's name resolves through the id-keyed dictionary this module
 * owns — the same rule `@deepseek-ai/dsh-agent-presets/display` applies on the
 * browser surface — so `/language` reaches the picker, the banner, and
 * `/status`. A user-authored preset keeps the name its own `preset.yml`
 * published: that metadata is never translated.
 *
 * A terminal profile built on `dsh-base` composes no preset roster, and this
 * plugin's own bundle patch may not mount one (DSH STORE accepts additive
 * plugin-owned rows only), so the profile's user layer owns the row. When it is
 * absent `/mode` reports the exact repair instead of a dead end.
 * @module dsh-ssh-tui/preset-label
 */

import { t } from './i18n/index.js'

/** i18n key carrying one shipped preset's name. */
const SHIPPED_PRESET_KEYS: Readonly<Record<string, string>> = {
  standard: 'mode.preset.standard',
  minimal: 'mode.preset.minimal',
  ptc: 'mode.preset.ptc',
  cordis: 'mode.preset.cordis',
}

/** Whether this id belongs to the shipped, translatable roster. */
export function isShippedPreset(id: string): boolean {
  return SHIPPED_PRESET_KEYS[id] !== undefined
}

/**
 * Resolve the name a picker, banner, or report renders for one preset.
 *
 * A published name equal to the id is the roster's own "no metadata" answer,
 * not a name, so it falls through to the dictionary or back to the id.
 * @param id - the preset id, also the last-resort label.
 * @param name - display name the preset published, when it published one.
 * @param trust - `user` keeps published metadata; anything else (including an
 *   unknown trust) resolves a shipped id through the dictionary.
 * @returns the localized or published name, never empty.
 */
export function presetLabel(id: string, name?: string, trust?: string): string {
  const published = name?.trim()
  const own = published === undefined || published === '' || published === id ? undefined : published
  if (trust !== 'user') {
    const key = SHIPPED_PRESET_KEYS[id]
    if (key !== undefined) return t(key)
  }
  return own ?? id
}

/**
 * The profile this process booted, from `--profile <name>` / `--profile=<name>`.
 *
 * The launcher passes the same arguments to the front end and to the Host it
 * spawns (only `--resume`/`--new` are rewritten), so both report one profile.
 * @param argv - the argument list to read.
 * @returns the profile name, or the TUI's own default when none was named.
 */
export function profileFromArgv(argv: readonly string[] = process.argv): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '--profile') {
      const next = argv[index + 1]
      if (next !== undefined && next !== '' && !next.startsWith('-')) return next
    } else if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length)
      if (value !== '') return value
    }
  }
  return 'tui'
}
