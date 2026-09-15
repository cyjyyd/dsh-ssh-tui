/**
 * Rebindable keys: a small set of high-frequency actions, and the rules for
 * applying a user's overrides without breaking the defaults.
 *
 * The TUI dispatches on raw byte sequences (`\x1b[5~` for PageUp, `\x1b` for
 * Esc), which is fine until someone's terminal sends something else for a key,
 * or their hands want the action elsewhere. Only actions are rebindable — never
 * arbitrary bytes — so a typo cannot invent a key that does nothing, and a key
 * that two actions claim is refused rather than silently winning by order.
 * @module dsh-ssh-tui/keymap
 */

/** The actions a user may move. */
export type KeyAction = 'pageUp' | 'pageDown' | 'toggleCard' | 'copy' | 'cancel'

/** Every action, in the order reports list them. */
export const KEY_ACTIONS: readonly KeyAction[] = ['pageUp', 'pageDown', 'toggleCard', 'copy', 'cancel']

/** The key each action answers to out of the box. */
export const DEFAULT_KEYMAP: Readonly<Record<KeyAction, string>> = {
  pageUp: 'pgup',
  pageDown: 'pgdn',
  toggleCard: 'enter',
  copy: 'ctrl+shift+c',
  cancel: 'esc',
}

/** Named keys to the bytes a terminal sends for them. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  esc: '\x1b',
  escape: '\x1b',
  enter: '\r',
  return: '\r',
  tab: '\t',
  space: ' ',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pgup: '\x1b[5~',
  pageup: '\x1b[5~',
  pgdn: '\x1b[6~',
  pagedown: '\x1b[6~',
  insert: '\x1b[2~',
  delete: '\x1b[3~',
  // What the TUI already watches for: the kitty protocol's Ctrl+Shift+C. The
  // plain 0x03 is Ctrl+C, which cancels — the two must not be confused.
  'ctrl+shift+c': '\x1b[99;6u',
}

/**
 * The bytes one key name stands for, or undefined when the name means nothing.
 *
 * Accepts the named keys above, `ctrl+<letter>`, and a single character.
 * @param name - the name from the config or the default table.
 * @returns the sequence, or undefined for an unknown name.
 */
export function keySequence(name: string): string | undefined {
  const key = name.trim().toLowerCase()
  if (key === '') return undefined
  const named = NAMED_KEYS[key]
  if (named !== undefined) return named
  const ctrl = /^ctrl\+([a-z])$/u.exec(key)
  if (ctrl !== null) {
    const letter = ctrl[1] ?? ''
    // Ctrl+A is 0x01, so the letter's own code minus 'a' plus one.
    return String.fromCharCode(letter.charCodeAt(0) - 96)
  }
  if ([...key].length === 1) return key
  return undefined
}

/** What a config's `keys` section asked for, and what was wrong with it. */
export interface ResolvedKeymap {
  /** Sequence to action, for the keys that survived. */
  sequences: Map<string, KeyAction>
  /** Names the config used that no action has. */
  unknownActions: string[]
  /** Keys the config asked for that are not keys this TUI knows. */
  unknownKeys: string[]
  /** Keys two actions claim; the first (default order) keeps it. */
  conflicts: Array<{ key: string; actions: KeyAction[] }>
  /**
   * Actions the config actually moved. Only these are dispatched through the
   * keymap, so a key the user did not touch keeps the handling it always had —
   * Enter in the input box still submits, Esc still closes a dialog.
   */
  overridden: Set<KeyAction>
  /**
   * Sequences that used to be a default and are now unclaimed. Pressing one
   * does nothing instead of falling through to the old hard-coded branch.
   */
  suppressed: Set<string>
}

/**
 * Apply a user's overrides to the defaults.
 *
 * Order matters and is deliberate: the defaults are laid down first, then the
 * overrides in {@link KEY_ACTIONS} order. A key that ends up claimed twice is
 * removed from the map and reported, so neither action surprises the other —
 * the user is told, and pressing that key does nothing rather than the wrong
 * thing. An action whose override is unusable keeps its default.
 * @param overrides - the config's `keys` section, action to key name.
 * @returns the keymap, plus what to tell the user about it.
 */
export function resolveKeymap(overrides: Readonly<Record<string, unknown>> = {}): ResolvedKeymap {
  const sequences = new Map<string, KeyAction>()
  const unknownActions: string[] = []
  const unknownKeys: string[] = []
  for (const action of KEY_ACTIONS) {
    const sequence = keySequence(DEFAULT_KEYMAP[action])
    if (sequence !== undefined) sequences.set(sequence, action)
  }
  for (const [rawAction, rawKey] of Object.entries(overrides)) {
    const action = rawAction.trim() as KeyAction
    if (!KEY_ACTIONS.includes(action)) {
      unknownActions.push(rawAction)
      continue
    }
    if (typeof rawKey !== 'string') {
      unknownKeys.push(`${rawAction}: ${String(rawKey)}`)
      continue
    }
    const sequence = keySequence(rawKey)
    if (sequence === undefined) {
      unknownKeys.push(rawKey)
      continue
    }
    for (const [existing, owner] of sequences) {
      if (existing === sequence && owner !== action) sequences.delete(existing)
    }
    sequences.set(sequence, action)
  }
  // A default that an override took over is re-claimed by whichever action still
  // names that key; anything claimed twice after that is a genuine conflict.
  const bySequence = new Map<string, KeyAction[]>()
  for (const action of KEY_ACTIONS) {
    const configured = typeof overrides[action] === 'string' ? (overrides[action] as string) : undefined
    const name = configured !== undefined && keySequence(configured) !== undefined ? configured : DEFAULT_KEYMAP[action]
    const sequence = keySequence(name)
    if (sequence === undefined) continue
    bySequence.set(sequence, [...(bySequence.get(sequence) ?? []), action])
  }
  const conflicts: Array<{ key: string; actions: KeyAction[] }> = []
  const final = new Map<string, KeyAction>()
  for (const [sequence, actions] of bySequence) {
    if (actions.length > 1) {
      conflicts.push({ key: actions.map(action => String(overrides[action] ?? DEFAULT_KEYMAP[action])).join(' / '), actions })
      continue
    }
    const only = actions[0]
    if (only !== undefined) final.set(sequence, only)
  }
  const overridden = new Set<KeyAction>()
  for (const action of KEY_ACTIONS) {
    const configured = overrides[action]
    if (typeof configured !== 'string') continue
    const wanted = keySequence(configured)
    if (wanted === undefined) continue
    if (wanted !== keySequence(DEFAULT_KEYMAP[action])) overridden.add(action)
  }
  const suppressed = new Set<string>()
  for (const action of KEY_ACTIONS) {
    const original = keySequence(DEFAULT_KEYMAP[action])
    if (original === undefined) continue
    // The default stays suppressed only when it no longer maps to this action.
    if (final.get(original) !== action) suppressed.add(original)
  }
  return { sequences: final, unknownActions, unknownKeys, conflicts, overridden, suppressed }
}

/**
 * One line describing what was wrong with a config's keys, or undefined when
 * there is nothing to say. Silent acceptance is how a user ends up pressing a
 * key that does nothing and blaming the TUI.
 */
export function keymapReport(resolved: ResolvedKeymap): string | undefined {
  const parts: string[] = []
  if (resolved.unknownActions.length > 0) parts.push(`unknown actions: ${resolved.unknownActions.join(', ')}`)
  if (resolved.unknownKeys.length > 0) parts.push(`unknown keys: ${resolved.unknownKeys.join(', ')}`)
  for (const conflict of resolved.conflicts) {
    parts.push(`${conflict.key} is claimed by ${conflict.actions.join(' and ')}; ignored`)
  }
  return parts.length === 0 ? undefined : parts.join(' · ')
}
