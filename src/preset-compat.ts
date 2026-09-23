/**
 * The agent-preset vocabulary, kept local on purpose.
 *
 * 0.1.7-rc.1 renamed and split the package this used to come from:
 * `@deepseek-ai/dsh-agent-presets` (which stops at 0.1.6-alpha.2) became
 * `@deepseek-ai/dsh-agent-preset` (a composition row) plus
 * `@deepseek-ai/dsh-agent-preset-registry` (the `agentPresets` service). The
 * registry's `AgentPreset` also dropped `path` and `trust`: presets are
 * declarative rows there, not directories on disk.
 *
 * Importing either line's types would pin this plugin to that line, so both are
 * read through one structural shape in which `path` and `trust` are optional —
 * present on the 0.1.5 line, absent on 0.1.7. The display-metadata reader lived
 * in the package that disappeared; the ~25 lines it was are vendored here with
 * the same semantics (the file is `preset.yml`, every failure degrades to no
 * metadata, because presentation is not a capability).
 *
 * What that costs, deliberately: on 0.1.7 there is no preset directory to write
 * beside, so the authoring half of `/preset` (copy, delete, metadata edits) has
 * nothing to plan against and refuses with `managed` instead of pretending. The
 * registry carries `name`/`description` itself, so the picker still shows them.
 * @module dsh-ssh-tui/preset-compat
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'

/** The optional display-metadata file beside a preset's composition. */
export const METADATA_FILE = 'preset.yml'

/** Display text a preset may publish about itself. */
export interface PresetMetadata {
  /** Human-facing name; falls back to the preset id when absent. */
  readonly name?: string
  /** One sentence on what this preset is for. */
  readonly description?: string
  /** Position within its group; lower comes first. */
  readonly order?: number
}

/** Where a preset's composition came from, on the line that still records it. */
export type PresetTrust = 'system' | 'user'

/**
 * One preset, as much of it as this plugin reads.
 *
 * `id`/`name`/`description`/`order`/`broken` are the fields both lines agree on.
 * `path` (the composition file) and `trust` (the root it was discovered under)
 * only exist on the 0.1.5 line; every consumer here treats them as optional,
 * and the authoring paths refuse rather than guess when they are gone.
 */
export interface AgentPreset {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly broken?: string
  /** 0.1.5 line only: absolute path of the preset's agent composition file. */
  readonly path?: string
  /** 0.1.5 line only: trust recorded from the root it was discovered under. */
  readonly trust?: PresetTrust
}

/**
 * The directory a preset owns, when the host still exposes one.
 *
 * `AgentPreset.path` is the composition file the preset publishes, not the
 * directory, so anything that writes beside it (display metadata) starts here.
 * `undefined` on a host that lists declarative presets instead of directories.
 * @param preset - a discovered preset.
 * @returns the absolute preset directory, or undefined when there is none.
 */
export function presetDirectory(preset: AgentPreset): string | undefined {
  return preset.path === undefined ? undefined : dirname(preset.path)
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Read a preset's display metadata. Every failure degrades to no metadata: a
 * preset whose display text is missing, malformed, or unreadable still mounts.
 * @param directory - the preset directory to read `preset.yml` from.
 * @returns the published name/description/order, or `{}`.
 */
export async function readPresetMetadata(directory: string): Promise<PresetMetadata> {
  let raw: string
  try {
    raw = await readFile(join(directory, METADATA_FILE), 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  const name = text(record.name)
  const description = text(record.description)
  const order = typeof record.order === 'number' && Number.isFinite(record.order) ? record.order : undefined
  return {
    ...name === undefined ? {} : { name },
    ...description === undefined ? {} : { description },
    ...order === undefined ? {} : { order },
  }
}

/**
 * Render display metadata as the file's contents.
 *
 * Absent fields are omitted rather than written empty, so a preset with no
 * description does not ship a key that reads as an intentional blank.
 * @param metadata - the display text to store.
 * @returns the YAML document, or undefined when there is nothing to store.
 */
export function renderPresetMetadata(metadata: PresetMetadata): string | undefined {
  const name = text(metadata.name)
  const description = text(metadata.description)
  const { order } = metadata
  if (name === undefined && description === undefined && order === undefined) return undefined
  return yaml.dump({
    ...name === undefined ? {} : { name },
    ...description === undefined ? {} : { description },
    ...order === undefined ? {} : { order },
  }, { lineWidth: -1 })
}
