/**
 * `/preset`: the terminal's authoring surface for agent presets.
 *
 * A preset is a directory — an id, a composition file, and optional display
 * metadata — and the web client reaches the same four operations the plugin
 * exposes to it: list, read, copy, delete. This module mirrors that surface and
 * adds display-name/description edits, which are the one authoring write the
 * upstream service does not offer; it stays pure so every refusal is testable
 * without a host, and `tui.ts` performs the two calls that touch the disk.
 *
 * The rules are the upstream ones, re-stated here so a command refuses before
 * it calls out:
 *
 * - only `user` presets are writable; a shipped preset is refused by the
 *   service as well (`agent-preset/read-only`);
 * - a copy never overwrites: the destination id must be free;
 * - ids match `/^[a-z0-9][a-z0-9-]*$/`;
 * - deleting the preset the session is running is refused here, even though the
 *   service allows it — the running session would keep its composition while
 *   every later launch falls back to the default.
 * @module dsh-ssh-tui/preset-authoring
 */

import { dirname } from 'node:path'
import {
  renderPresetMetadata,
  type AgentPreset,
  type PresetMetadata,
} from '@deepseek-ai/dsh-agent-presets'

/** The id shape discovery accepts; a directory that fails it is skipped. */
export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

/** Whether an id would be discovered at all. */
export function validatePresetId(id: string): boolean {
  return PRESET_ID_PATTERN.test(id)
}

/**
 * The directory a preset owns.
 *
 * `AgentPreset.path` is the composition file the preset publishes, not the
 * directory, so anything that writes beside it (display metadata) starts here.
 * @param preset - a discovered preset.
 * @returns the absolute preset directory.
 */
export function presetDirectory(preset: AgentPreset): string {
  return dirname(preset.path)
}

export type PresetRefusalCode =
  | 'invalid-id'
  | 'exists'
  | 'not-found'
  | 'read-only'
  | 'system'
  | 'running'
  | 'empty-metadata'

export interface PresetRefusal {
  error: PresetRefusalCode
  /** The id the refusal is about, when it names one. */
  id?: string
  /** The name that collided, for `exists`. */
  name?: string
}

export interface PresetCopyPlan {
  kind: 'copy'
  from: string
  id: string
  name?: string
}

export interface PresetMetadataPlan {
  kind: 'metadata'
  id: string
  directory: string
  /** The `preset.yml` document to write, already rendered by upstream. */
  text: string
}

export interface PresetDeletePlan {
  kind: 'delete'
  id: string
}

export type PresetPlan = PresetCopyPlan | PresetMetadataPlan | PresetDeletePlan

export function isRefusal(value: PresetPlan | PresetRefusal): value is PresetRefusal {
  return 'error' in value
}

/** One composition row as `/preset show` renders it. */
export interface PresetRowView {
  entryId: string | null
  moduleName: string
  enabled: boolean | 'conditional'
  condition?: string
}

/** One preset's composition as `/preset show` renders it. */
export interface PresetCompositionView {
  id: string
  name?: string
  isDefault: boolean
  broken?: string
  rows: readonly PresetRowView[]
}

/**
 * The authoring subset of the service, feature-detected rather than assumed:
 * the plugin still supports 0.1.2-rc.1, whose `agentPresets` may predate
 * `copy`, `remove`, `read`, and `compositionInventory`. A missing member turns
 * into a clear message instead of a crash.
 */
export interface PresetAuthoringApi {
  readonly authorable?: boolean
  copy?(from: string, id: string, name?: string): Promise<void>
  remove?(id: string): Promise<void>
  read?(id: string): Promise<string>
  compositionInventory?(): Promise<readonly PresetCompositionView[]>
}

/**
 * Plan a copy of an existing preset under a new id.
 *
 * Copy is the only way to create one (upstream has no create or rename), and it
 * carries the whole directory — composition, display metadata, and any scripts
 * a preset ships beside them.
 * @param input - the roster, whether authoring is possible, and the request.
 * @returns the call to make, or why it must be refused.
 */
export function planCopy(input: {
  presets: readonly AgentPreset[]
  authorable: boolean
  from: string
  id: string
  name?: string | undefined
}): PresetCopyPlan | PresetRefusal {
  if (!input.authorable) return { error: 'read-only' }
  if (!validatePresetId(input.id)) return { error: 'invalid-id', id: input.id }
  if (!input.presets.some(preset => preset.id === input.from)) return { error: 'not-found', id: input.from }
  const taken = input.presets.find(preset => preset.id === input.id)
  if (taken !== undefined) return { error: 'exists', id: input.id, name: taken.name ?? taken.id }
  return {
    kind: 'copy',
    from: input.from,
    id: input.id,
    ...(input.name === undefined || input.name.trim() === '' ? {} : { name: input.name.trim() }),
  }
}

/**
 * Plan a display-metadata edit (name, description, or both).
 *
 * The current document is merged, so editing one field never drops the other,
 * and `order` survives. A shipped preset cannot be edited: its directory is
 * read-only by definition.
 * @param input - the preset, its current metadata, and the fields to change.
 * @returns the file to write, or why it must be refused.
 */
export function planMetadata(input: {
  preset: AgentPreset
  current: PresetMetadata
  patch: { name?: string | undefined; description?: string | undefined }
}): PresetMetadataPlan | PresetRefusal {
  if (input.preset.trust !== 'user') return { error: 'system', id: input.preset.id }
  const merged: PresetMetadata = {
    ...input.current,
    ...(input.patch.name === undefined ? {} : { name: input.patch.name.trim() }),
    ...(input.patch.description === undefined ? {} : { description: input.patch.description.trim() }),
  }
  const text = renderPresetMetadata(merged)
  // Upstream renders nothing when every field is empty: there is no document to
  // publish, and silently deleting the file is not this command's business.
  if (text === undefined) return { error: 'empty-metadata', id: input.preset.id }
  return { kind: 'metadata', id: input.preset.id, directory: presetDirectory(input.preset), text }
}

/**
 * Plan a deletion.
 * @param input - the preset, whether authoring is possible, and which preset
 *   this session is running.
 * @returns the call to make, or why it must be refused.
 */
export function planDelete(input: {
  preset: AgentPreset
  authorable: boolean
  current: boolean
}): PresetDeletePlan | PresetRefusal {
  if (!input.authorable) return { error: 'read-only' }
  if (input.preset.trust !== 'user') return { error: 'system', id: input.preset.id }
  if (input.current) return { error: 'running', id: input.preset.id }
  return { kind: 'delete', id: input.preset.id }
}
