/**
 * Subagent model defaults and the settings section the TUI edits with
 * `/submodel` and `/subeffort`.
 *
 * The provider is deliberately inherited from the running parent session:
 * the subagent selection only overrides the provider when the user stored an
 * explicit route. The model defaults to the lightweight `deepseek-v4-flash`.
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type ReasoningEffortId as ReasoningEffort } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace carrying the TUI's subagent model selection. */
export const SUBAGENT_SETTINGS_NAMESPACE = settingsNamespace('ssh-tui-subagent')

/** Lightweight default model used for subagent children. */
export const DEFAULT_SUBAGENT_MODEL = 'deepseek-v4-flash'

/** Raw settings document shape. */
export interface SubagentSettings {
  /** Explicit provider override; omitted means "same provider as the parent". */
  provider?: string
  /** Subagent model id. */
  model?: string
  /** Adapter-owned reasoning effort id. */
  reasoningEffort?: string
}

/** Live, typed subagent selection. */
export interface SubagentSelection {
  /** Explicit provider override; undefined inherits the parent route. */
  provider?: string
  /** Subagent model id. */
  model: string
  /** Reasoning effort; undefined follows the provider/model default. */
  reasoningEffort?: ReasoningEffort
}

/** Mutable selection handle shared by the settings watcher and the TUI. */
export interface SubagentSelectionRef {
  current: SubagentSelection
}

/** Settings schema for `$DSH_HOME/settings.yaml`. */
export const SUBAGENT_SETTINGS_SCHEMA = z.object({
  provider: z.string(),
  model: z.string().default(DEFAULT_SUBAGENT_MODEL),
  reasoningEffort: z.string(),
})

/** Normalize a raw settings section into a live typed selection. */
export function normalizeSubagentSelection(value: unknown): SubagentSelection {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as SubagentSettings
  return {
    ...(typeof raw.provider === 'string' && raw.provider.trim() !== ''
      ? { provider: raw.provider.trim() }
      : {}),
    model: typeof raw.model === 'string' && raw.model.trim() !== ''
      ? raw.model.trim()
      : DEFAULT_SUBAGENT_MODEL,
    ...(typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim() !== ''
      ? { reasoningEffort: ReasoningEffortId(raw.reasoningEffort.trim()) }
      : {}),
  }
}

/**
 * Install the settings-backed subagent selection for one TUI plugin fiber.
 * Returns the mutable ref the request waterfall and the slash commands share.
 */
export function createSubagentSelection(ctx: Context): SubagentSelectionRef {
  let source = (): SubagentSettings => ({ model: DEFAULT_SUBAGENT_MODEL })
  const ref: SubagentSelectionRef = { current: normalizeSubagentSelection(source()) }
  installSettingsSection(ctx, SUBAGENT_SETTINGS_NAMESPACE, SUBAGENT_SETTINGS_SCHEMA, {
    model: DEFAULT_SUBAGENT_MODEL,
  }, {
    setSource: (current) => {
      source = () => current() as unknown as SubagentSettings
    },
    onChange: () => {
      ref.current = normalizeSubagentSelection(source())
    },
  })
  return ref
}

/** Serialize a live selection back into the settings document shape. */
export function subagentSettingsValue(selection: SubagentSelection): SubagentSettings {
  return {
    ...(selection.provider === undefined ? {} : { provider: selection.provider }),
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: String(selection.reasoningEffort) }),
  }
}
