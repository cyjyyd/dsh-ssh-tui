/**
 * The `/mode` picker's list: which presets to show, in what order, and what to
 * say about each one.
 *
 * The dialog is a flat list of options, so the grouping a browser surface can
 * draw is carried in three cheap ways: the groups are ordered (shipped first,
 * then authored locally), every description names its group, and a preset that
 * declares a position shows it. Nothing here touches the filesystem or the
 * service — the caller passes what `list()` returned.
 * @module dsh-ssh-tui/preset-picker
 */

import type { AgentPreset, PresetTrust } from './preset-compat.js'

import { t } from './i18n/index.js'
import { presetLabel } from './preset-label.js'

/** One option as the question dialog wants it, plus the id it stands for. */
export interface PresetPickerOption {
  id: string
  label: string
  description: string
  /** Why this preset cannot run, carried so the dialog can refuse it on pick. */
  broken?: string
  /**
   * Every name this preset answers to: the id, and the name it published even
   * when the display label resolves elsewhere. `/mode <name>` matched a
   * published name before the list was grouped, and dropping that would break
   * a script that uses one.
   */
  aliases: string[]
}

/** The shipped presets, then the locally authored ones. */
export interface PresetPickerGroup {
  trust: 'system' | 'user'
  title: string
  options: PresetPickerOption[]
}

/**
 * Within a group: a declared position first, in ascending order, then the rest
 * by id. `order` is the preset's own statement about where it belongs, so a
 * deployment's curated sequence survives discovery.
 */
export function comparePresets(left: AgentPreset, right: AgentPreset): number {
  const leftOrder = left.order
  const rightOrder = right.order
  if (leftOrder !== undefined && rightOrder !== undefined && leftOrder !== rightOrder) {
    return leftOrder - rightOrder
  }
  if (leftOrder !== undefined && rightOrder === undefined) return -1
  if (leftOrder === undefined && rightOrder !== undefined) return 1
  return left.id.localeCompare(right.id)
}

/**
 * What one preset's line says underneath its name: where it sits, what it is
 * for, and why it cannot run — in that order, because a broken preset's reason
 * is the only thing the reader needs.
 */
export function presetOptionDescription(preset: AgentPreset, currentId: string): string {
  const parts: string[] = [preset.trust === 'user' ? t('mode.groupUser') : t('mode.groupSystem')]
  if (preset.id === currentId) parts.push(t('mode.currentTag'))
  if (preset.broken !== undefined && preset.broken !== '') {
    parts.push(t('mode.brokenSuffix', { reason: preset.broken }))
  } else if (preset.description !== undefined && preset.description.trim() !== '') {
    parts.push(preset.description.trim())
  }
  if (preset.order !== undefined) parts.push(t('mode.orderTag', { order: preset.order }))
  return parts.join(' · ')
}

/** One option's label: the name the roster publishes, never empty. */
export function presetOptionLabel(preset: AgentPreset): string {
  return presetLabel(preset.id, preset.name, preset.trust)
}

/**
 * Group and order the roster for the picker.
 * @param presets - what the service listed.
 * @param currentId - the preset in effect, marked in each description.
 * @returns shipped presets first, then authored ones; empty groups are omitted.
 */
export function groupPresets(
  presets: readonly AgentPreset[],
  currentId: string,
): PresetPickerGroup[] {
  const groups: PresetPickerGroup[] = []
  for (const trust of ['system', 'user'] as const) {
    // A host that lists declarative presets records no trust at all (0.1.7);
    // those are the deployment's own, so they group with the shipped ones.
    // Filtering on a missing field would drop every preset and leave `/mode`
    // empty on that line.
    const members = presets.filter(preset => (preset.trust ?? 'system') === trust).sort(comparePresets)
    if (members.length === 0) continue
    groups.push({
      trust,
      title: trust === 'user' ? t('mode.groupUser') : t('mode.groupSystem'),
      options: members.map(preset => ({
        id: preset.id,
        label: presetOptionLabel(preset),
        description: presetOptionDescription(preset, currentId),
        ...(preset.broken === undefined ? {} : { broken: preset.broken }),
        aliases: [...new Set([
          preset.id,
          ...(preset.name === undefined || preset.name.trim() === '' ? [] : [preset.name.trim()]),
          presetOptionLabel(preset),
        ])],
      })),
    })
  }
  return groups
}

/** The same list, flattened the way the dialog takes it. */
export function flattenGroups(groups: readonly PresetPickerGroup[]): PresetPickerOption[] {
  return groups.flatMap(group => group.options)
}

/** Whether a preset answers to the name a caller typed. */
export function optionMatches(option: PresetPickerOption, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return needle !== '' && option.aliases.some(alias => alias.toLowerCase() === needle)
}

/**
 * Narrow the roster to what a typed query matches: the id, the published name,
 * and the description, case-insensitively. An empty query keeps everything, so
 * the picker opens on the full roster.
 */
export function filterPresets(presets: readonly AgentPreset[], query: string): AgentPreset[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...presets]
  return presets.filter(preset => [preset.id, preset.name ?? '', preset.description ?? '']
    .some(field => field.toLowerCase().includes(needle)))
}
