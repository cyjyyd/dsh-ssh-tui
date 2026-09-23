/**
 * The profile patch that mounts the agent-preset roster `/mode` needs, plus the
 * repair planner `/doctor` uses to fix a profile patch.
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
 *
 * Everything in this module is either a pure text function or a file write that
 * takes a backup first: `/doctor` may repair a user's profile patch, and that
 * must never lose the previous content or touch a row the user wrote.
 * @module dsh-ssh-tui/preset-rows
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'
import type { SettingsGeneration } from './dsh-compat.js'

/** Which host line the profile being repaired boots on. */
export type HostGeneration = SettingsGeneration

/** One host row the roster block mounts. */
export interface RosterRow {
  id: string
  name: string
  /** Lines below `config:`, written one level deeper than `config:`. */
  config?: readonly string[]
}

/**
 * The rows a 0.1.5 terminal profile has to mount itself: the roster `/mode`
 * lists, the TypeScript runtime the PTC preset needs, and the host-owned
 * subagent delegation setting.
 */
export const ROSTER_ROWS: readonly RosterRow[] = [
  { id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: ['default: standard'] },
  { id: 'code-runtime', name: '@deepseek-ai/dsh-code-runtime-worker-thread' },
  { id: 'subagent-model-selection-settings', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings' },
]

/**
 * The rows a 0.1.7 terminal profile mounts for itself.
 *
 * 0.1.7 deleted the roster this plugin used to list and switch: presets became
 * per-session declarations a surface mounts (`@deepseek-ai/dsh-agent-preset`
 * rows over the `agent-preset-registry` service), and `dsh-base` keeps the
 * agent-plane rows enabled for the TUI, which is single-session and composes
 * its agent process-wide. What the base does *not* mount are the three rows the
 * shipped standard preset owns beyond it — the persona prompt, and the
 * `ask_user_question` / `present` tools — so those are what a TUI profile adds.
 * Written verbatim as upstream's own `dsh-web-app/presets/standard.patch.yml`
 * declares them, minus the rows the base already carries.
 */
export const FORMS_ROWS: readonly RosterRow[] = [
  {
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: [
      'suffix: Your working directory is {{cwd}}.',
      'prefix: You are a coding agent powered by the {{model}} model.',
    ],
  },
  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
  { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
]

/** The rows one host line's profile has to mount. */
export function rosterRows(generation: HostGeneration): readonly RosterRow[] {
  return generation === 'forms' ? FORMS_ROWS : ROSTER_ROWS
}

/** Every row either line knows about, for name-to-row lookups. */
export const ALL_ROSTER_ROWS: readonly RosterRow[] = [...ROSTER_ROWS, ...FORMS_ROWS]

/** The comment header the block introduces itself with, in both writers. */
export const ROSTER_PATCH_HEADER = `# dsh-ssh-tui /mode: the agent-preset roster (standard / minimal / PTC /
# cordis, plus every preset under $DSH_HOME/.agent-presets) and the two host
# services the shipped presets need. dsh-base composes no roster in a terminal
# profile, and a third-party bundle patch may not mount an @deepseek-ai row, so
# the profile's user layer owns them.
`

/** The same header on a host that composes its agent process-wide. */
export const FORMS_PATCH_HEADER = `# dsh-ssh-tui: the agent-plane rows a 0.1.7 terminal profile mounts for itself.
# That line composes the agent process-wide (presets are a per-session Web
# feature now), and dsh-base already carries every row the standard preset
# needs except these three: the persona prompt and the ask_user_question /
# present tools. The profile's user layer owns them.
`

/** The header for one host line. */
export function rosterPatchHeader(generation: HostGeneration): string {
  return generation === 'forms' ? FORMS_PATCH_HEADER : ROSTER_PATCH_HEADER
}

/** One item of an `insert:` list, indented as the block writes it. */
function rosterItemText(row: RosterRow): string {
  const lines = [`    - id: ${row.id}`, `      name: '${row.name}'`]
  if (row.config !== undefined && row.config.length > 0) {
    lines.push('      config:')
    for (const line of row.config) lines.push(`        ${line}`)
  }
  return `${lines.join('\n')}\n`
}

/** One top-level `- insert:` entry mounting exactly these rows. */
export function rosterInsertEntry(rows: readonly RosterRow[]): string {
  return `- insert:\n${rows.map(rosterItemText).join('\n')}`
}

/**
 * The exact profile patch block that mounts the roster and the two host
 * services the shipped presets need. `scripts/ensure-profile-rows.sh` carries
 * the same text; a test compares the two so they cannot drift.
 */
export const ROSTER_PATCH_BLOCK = `${ROSTER_PATCH_HEADER}${rosterInsertEntry(ROSTER_ROWS)}`

/** The 0.1.7 block, the same way. */
export const FORMS_PATCH_BLOCK = `${FORMS_PATCH_HEADER}${rosterInsertEntry(FORMS_ROWS)}`

/** The block for one host line. */
export function rosterPatchBlock(generation: HostGeneration): string {
  return generation === 'forms' ? FORMS_PATCH_BLOCK : ROSTER_PATCH_BLOCK
}

/** The profile patch file the roster block belongs in. */
export function rosterPatchPath(home: string, profile: string): string {
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/** One row a patch file declares, with enough position to point at it. */
export interface PatchRowRef {
  /** Insert id, or the target of an override/disable entry. */
  id: string
  /** Module name for an insert that mounts one. */
  name?: string
  kind: 'insert' | 'override' | 'disable' | 'other'
  /** 0-based top-level entry index. */
  entry: number
  /** 0-based index inside the entry's insert list (inserts only). */
  item?: number
  /** 1-based line the id is written on, when the text can be scanned. */
  line: number
}

export interface PatchAnalysis {
  /** The YAML parses into a top-level array of patch entries. */
  parseable: boolean
  /** What the loader would reject, when it does not parse. */
  error?: string
  rows: PatchRowRef[]
}

/** Every `id:` the raw text writes, with the 1-based line it sits on, in order. */
function idLines(text: string): Array<{ id: string; line: number }> {
  const out: Array<{ id: string; line: number }> = []
  text.split('\n').forEach((line, index) => {
    const match = /^\s*(?:-\s*)?id:\s*['"]?([^'"\s#]+)['"]?/u.exec(line)
    if (match?.[1] !== undefined) out.push({ id: match[1], line: index + 1 })
  })
  return out
}

/**
 * Read one patch file into the rows it declares.
 *
 * Unparseable YAML is reported instead of thrown: `/doctor` has to *describe*
 * a broken patch, which is exactly when the loader would refuse to boot.
 * @param text - the patch file's content.
 * @returns the rows, and whether the text parsed at all.
 */
export function analyzePatch(text: string): PatchAnalysis {
  let loaded: unknown
  try {
    loaded = yaml.load(text)
  } catch (error) {
    return { parseable: false, error: error instanceof Error ? error.message : String(error), rows: [] }
  }
  const entries = Array.isArray(loaded) ? loaded : loaded === null || loaded === undefined ? [] : [loaded]
  const lines = idLines(text)
  const used = new Map<string, number>()
  const rows: PatchRowRef[] = []
  const lineFor = (id: string): number => {
    const seen = used.get(id) ?? 0
    used.set(id, seen + 1)
    const matches = lines.filter(entry => entry.id === id)
    return matches[seen]?.line ?? matches[matches.length - 1]?.line ?? 0
  }
  entries.forEach((entry, entryIndex) => {
    if (typeof entry !== 'object' || entry === null) return
    const record = entry as Record<string, unknown>
    const insert = record.insert
    if (Array.isArray(insert)) {
      insert.forEach((item, itemIndex) => {
        if (typeof item !== 'object' || item === null) return
        const row = item as Record<string, unknown>
        if (typeof row.id !== 'string' || row.id === '') return
        rows.push({
          id: row.id,
          ...(typeof row.name === 'string' && row.name !== '' ? { name: row.name } : {}),
          kind: 'insert',
          entry: entryIndex,
          item: itemIndex,
          line: lineFor(row.id),
        })
      })
      return
    }
    if (typeof record.id !== 'string' || record.id === '') return
    const kind: PatchRowRef['kind'] = record.disable === true
      ? 'disable'
      : 'override' in record || 'config' in record ? 'override' : 'other'
    rows.push({ id: record.id, kind, entry: entryIndex, line: lineFor(record.id) })
  })
  return { parseable: true, rows }
}

/**
 * Insert rows that appear more than once, keeping the first occurrence.
 *
 * A row is duplicated when an earlier insert declares the same id, or mounts
 * the same module name — the two ways a second mount reaches the loader and
 * fails with "service … has been registered". Overrides and disables are never
 * duplicates of an insert: they target a row instead of mounting it.
 * @param rows - every row the patch declares.
 * @returns the later occurrences, in file order.
 */
export function duplicatePatchRows(rows: readonly PatchRowRef[]): PatchRowRef[] {
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  const duplicates: PatchRowRef[] = []
  for (const row of rows) {
    if (row.kind !== 'insert') continue
    const duplicate = seenIds.has(row.id) || (row.name !== undefined && seenNames.has(row.name))
    seenIds.add(row.id)
    if (row.name !== undefined) seenNames.add(row.name)
    if (duplicate) duplicates.push(row)
  }
  return duplicates
}

/** Whether a patch already declares one roster row, by id or by module name. */
export function patchNamesRow(rows: readonly PatchRowRef[], row: RosterRow): boolean {
  return rows.some(candidate =>
    (candidate.kind === 'insert' && candidate.id === row.id)
    || candidate.name === row.name)
}

/** The roster rows a patch does not declare yet. */
export function missingRosterRows(
  rows: readonly PatchRowRef[],
  candidates: readonly RosterRow[] = ROSTER_ROWS,
): RosterRow[] {
  return candidates.filter(row => !patchNamesRow(rows, row))
}

/** The template a missing profile patch starts from. */
const PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]

`

export interface PatchRepair {
  text: string
  /** Roster rows this repair adds, by id. */
  added: string[]
  /** Duplicate rows this repair removes, by id, with the line they sat on. */
  removed: Array<{ id: string; line: number }>
}

/** Text ending in exactly one newline. */
function normalizeEnd(text: string): string {
  return `${text.replace(/\n+$/u, '')}\n`
}

/**
 * The patch text with the given roster rows mounted, or `undefined` when the
 * file already declares every one of them.
 *
 * A row is matched by id or by module name, so a profile that composes the
 * roster through its own bundle is left alone. A file that is exactly `[]`
 * (the profile template) is replaced; anything else keeps its content and gains
 * a new `- insert:` entry after a blank line.
 * @param existing - the patch file's current text.
 * @param missing - the roster rows to mount; defaults to the 0.1.5 set.
 * @param generation - which host line the profile boots on.
 * @returns the new text, or `undefined` when nothing has to change.
 */
export function planRosterRepair(
  existing: string,
  missing: readonly RosterRow[] = ROSTER_ROWS,
  generation: HostGeneration = 'legacy',
): PatchRepair | undefined {
  const analysis = analyzePatch(existing)
  const toAdd = analysis.parseable
    ? missing.filter(row => !patchNamesRow(analysis.rows, row))
    : [...missing]
  if (toAdd.length === 0) return undefined
  const entry = `${rosterPatchHeader(generation)}${rosterInsertEntry(toAdd)}`
  if (/^\s*\[\s*\]\s*$/m.test(existing)) {
    return { text: existing.replace(/^\s*\[\s*\]\s*$/m, entry.trimEnd() + '\n'), added: toAdd.map(row => row.id), removed: [] }
  }
  return { text: `${normalizeEnd(existing)}\n${entry}`, added: toAdd.map(row => row.id), removed: [] }
}

/** A line range to cut: `start` is 1-based and inclusive, `end` exclusive. */
interface Cut { start: number; end: number }

/** Top-level entry ranges, each extended over directly preceding comments. */
function entryRanges(lines: readonly string[]): Array<{ start: number; end: number }> {
  const starts: number[] = []
  lines.forEach((line, index) => {
    if (/^-\s/u.test(line) || /^-$/u.test(line)) starts.push(index)
  })
  return starts.map((start, at) => {
    const end = starts[at + 1] ?? lines.length
    let head = start
    while (head > 0 && /^\s*#/u.test(lines[head - 1] ?? '') && !/^\s*$/u.test(lines[head - 1] ?? '')) head -= 1
    // A comment block that also precedes an earlier entry belongs to that one.
    if (at > 0 && head <= (starts[at - 1] ?? 0)) head = start
    return { start: head, end }
  })
}

/** Item ranges inside one entry, each extended over directly preceding comments. */
function itemRanges(lines: readonly string[], entry: { start: number; end: number }): Array<{ start: number; end: number }> {
  const starts: number[] = []
  for (let index = entry.start; index < entry.end; index += 1) {
    if (/^\s+-\s/u.test(lines[index] ?? '')) starts.push(index)
  }
  return starts.map((start, at) => ({ start, end: starts[at + 1] ?? entry.end }))
}

/**
 * The patch text with every repeated insert removed, or `undefined` when the
 * file has no duplicate.
 *
 * Only the later occurrence is cut, and only its own item when the enclosing
 * `- insert:` entry mounts other rows too. Comments directly above a removed
 * entry go with it; anything the user wrote around it stays.
 * @param existing - the patch file's current text.
 * @returns the new text and what was removed, or `undefined` when nothing is.
 */
export function planDuplicateRepair(existing: string): PatchRepair | undefined {
  const analysis = analyzePatch(existing)
  const duplicates = duplicatePatchRows(analysis.rows)
  if (duplicates.length === 0) return undefined
  const lines = existing.split('\n')
  const trailing = lines[lines.length - 1] === '' ? lines.pop() === '' : false
  const ranges = entryRanges(lines)
  const cuts: Cut[] = []
  const duplicateKeys = new Set(duplicates.map(row => `${row.entry}:${row.item}`))
  for (const duplicate of duplicates) {
    const entry = ranges[duplicate.entry]
    if (entry === undefined || duplicate.item === undefined) continue
    // An entry whose every item repeats an earlier one goes as a whole; one that
    // also mounts rows the user still needs loses only the repeated items.
    const survivors = analysis.rows.filter(row =>
      row.kind === 'insert' && row.entry === duplicate.entry && !duplicateKeys.has(`${row.entry}:${row.item}`))
    if (survivors.length === 0) {
      cuts.push(entry)
      continue
    }
    const item = itemRanges(lines, entry)[duplicate.item]
    if (item !== undefined) cuts.push(item)
  }
  if (cuts.length === 0) return undefined
  const sorted = [...cuts].sort((left, right) => left.start - right.start)
  const kept: string[] = []
  /** Indices in `kept` where a cut ended: the only places formatting may change. */
  const seams: number[] = []
  let cursor = 0
  for (const cut of sorted) {
    if (cut.start < cursor) continue
    kept.push(...lines.slice(cursor, cut.start))
    seams.push(kept.length)
    cursor = cut.end
  }
  kept.push(...lines.slice(cursor))
  // A cut can leave two blank runs facing each other; fold them to one, and
  // leave every other line of the user's file exactly as it was.
  for (const seam of seams.reverse()) {
    while (/^\s*$/u.test(kept[seam] ?? 'x') && /^\s*$/u.test(kept[seam - 1] ?? 'x')) kept.splice(seam, 1)
  }
  const text = `${kept.join('\n').replace(/\n+$/u, '')}\n`
  return text === existing ? undefined : {
    text: trailing ? text : text.replace(/\n$/u, ''),
    added: [],
    removed: duplicates.map(row => ({ id: row.id, line: row.line })),
  }
}

/**
 * Mount the roster in one profile, unless it is already composed.
 *
 * Idempotent: a profile whose patch already names the roster row (one bundling
 * `@deepseek-ai/dsh-web-app`, for example) is left untouched. The write is a
 * plain whole-file replace because the file is small and read once at boot; a
 * half-written patch would only be seen by the next launch.
 * @param home - the harness home carrying `profiles/`.
 * @param profile - the profile to patch.
 * @param missing - the rows to mount; defaults to the 0.1.5 set.
 * @param generation - which host line the profile boots on.
 * @returns `present` when the row already exists, else `written`.
 */
export async function ensureRosterRows(
  home: string,
  profile: string,
  missing: readonly RosterRow[] = ROSTER_ROWS,
  generation: HostGeneration = 'legacy',
): Promise<'present' | 'written'> {
  const path = rosterPatchPath(home, profile)
  let existing = PATCH_TEMPLATE
  try {
    existing = await readFile(path, 'utf8')
  } catch {
    // Missing file: start from the template the launcher would have written.
  }
  const repair = planRosterRepair(existing, missing, generation)
  if (repair === undefined) return 'present'
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, repair.text, 'utf8')
  return 'written'
}

/**
 * Write a repaired patch next to a copy of the previous content.
 *
 * `/doctor` changes a file the user owns, so the old text is kept beside it
 * before anything is replaced. A file that does not exist yet needs no backup.
 * @param path - the patch file to replace.
 * @param text - the new content.
 * @param stamp - filename-safe timestamp for the backup, injectable for tests.
 * @returns the backup path, or `undefined` when there was nothing to back up.
 */
export async function writePatchWithBackup(
  path: string,
  text: string,
  stamp = new Date().toISOString().replace(/[:.]/gu, '-'),
): Promise<string | undefined> {
  let backup: string | undefined
  try {
    backup = `${path}.bak-${stamp}`
    await copyFile(path, backup)
  } catch {
    backup = undefined
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
  return backup
}

/** The patch text the roster block would produce on its own, for callers that report it. */
export function rosterPatchText(existing: string, generation: HostGeneration = 'legacy'): string | undefined {
  return planRosterRepair(existing, rosterRows(generation), generation)?.text
}
