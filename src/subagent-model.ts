/**
 * Subagent model defaults and the settings section the TUI edits with
 * `/submodel` and `/subeffort`.
 *
 * The provider is deliberately inherited from the running parent session:
 * the subagent selection only overrides the provider when the user stored an
 * explicit route. When the parent provider changes, the TUI picks a
 * same-family default (DeepSeek flash, Grok 4.5, otherwise the first listed
 * lightweight model) unless `/submodel` stored an explicit model.
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type ReasoningEffortId as ReasoningEffort } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { t } from './i18n/index.js'

/** Settings namespace carrying the TUI's subagent model selection. */
export const SUBAGENT_SETTINGS_NAMESPACE = settingsNamespace('ssh-tui-subagent')

/** Lightweight default model used for DeepSeek-family subagent children. */
export const DEFAULT_SUBAGENT_MODEL = 'deepseek-v4-flash'

/** Preferred subagent default when the parent route is SuperGrok / xAI. */
export const DEFAULT_XAI_SUBAGENT_MODEL = 'grok-4.5'

/** Tokens that mark a DeepSeek-family model id. */
const DEEPSEEK_MODEL_MARKERS = ['deepseek', 'v4-flash', 'v4-pro'] as const

/** Tokens that mark a Grok / xAI model id. */
const GROK_MODEL_MARKERS = ['grok', 'xai'] as const

function providerFamily(provider: string): 'deepseek' | 'xai' | 'other' {
  const id = provider.trim().toLowerCase()
  if (id === 'deepseek-official' || id === 'deepseek' || id.startsWith('deepseek-')) return 'deepseek'
  if (id === 'xai' || id === 'grok' || id.startsWith('xai-') || id.startsWith('grok-')) return 'xai'
  return 'other'
}

function modelLooksLike(model: string, markers: readonly string[]): boolean {
  const id = model.trim().toLowerCase()
  return markers.some(marker => id.includes(marker))
}

/** Length of the shared leading characters between two model ids. */
function commonPrefixLength(a: string, b: string): number {
  let index = 0
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1
  return index
}

function isFlashLike(id: string): boolean {
  return id.endsWith('flash') || /[-_]flash(?:[-_]|$)/u.test(id)
}

/**
 * Rank a listed model for automatic subagent selection. Lower is better:
 * exact provider default first, then the parent-selected model, then a
 * flash-like id close to the parent's name (same series), then the rest.
 */
function scoreSubagentCandidate(
  model: string,
  preferred: readonly string[],
  parentModel: string | undefined,
): number {
  const id = model.trim().toLowerCase()
  const parent = parentModel?.trim().toLowerCase() ?? ''
  const exactPreferred = preferred.findIndex(item => item.toLowerCase() === id)
  if (exactPreferred >= 0) return -100 + exactPreferred
  if (parent !== '' && id === parent) return -88
  let score = isFlashLike(id) ? -70 : -50
  if (parent !== '') {
    const shared = commonPrefixLength(id, parent)
    if (shared >= 12) score -= 10
    else if (shared >= 8) score -= 4
  }
  if (id.includes('vision')) score += 6
  if (id.includes('pro') || id.includes('max') || id.includes('4.6')) score += 12
  return score
}

/**
 * Choose the default subagent model for a parent provider, preferring a
 * same-family listed model over a leftover DeepSeek flash id. When the
 * parent's own model id is supplied, candidates closest to that name win,
 * with flash-like ids ranked first.
 */
export function defaultSubagentModelForProvider(
  provider: string,
  listed: readonly string[] = [],
  parentModel?: string,
): string {
  const family = providerFamily(provider)
  const preferred = family === 'xai'
    ? [DEFAULT_XAI_SUBAGENT_MODEL, 'grok-4.5', 'grok-4.3', 'grok-4.6']
    : family === 'deepseek'
      ? [DEFAULT_SUBAGENT_MODEL, 'deepseek-v4-flash-vision-exp', 'deepseek-v4-flash']
      : []
  const unique = [...new Set(listed.map(id => id.trim()).filter(id => id !== ''))]
  if (unique.length > 0) {
    const sameFamily = unique.filter(id =>
      family === 'xai' ? modelLooksLike(id, GROK_MODEL_MARKERS)
        : family === 'deepseek' ? modelLooksLike(id, DEEPSEEK_MODEL_MARKERS)
          : true)
    const pool = sameFamily.length > 0 ? sameFamily : unique
    return [...pool].sort((a, b) => {
      const delta = scoreSubagentCandidate(a, preferred, parentModel)
        - scoreSubagentCandidate(b, preferred, parentModel)
      return delta !== 0 ? delta : a.localeCompare(b)
    })[0] ?? (preferred[0] ?? unique[0] ?? DEFAULT_SUBAGENT_MODEL)
  }
  return preferred[0] ?? DEFAULT_SUBAGENT_MODEL
}

/**
 * True when the stored subagent model still belongs to the parent provider
 * family. An explicit leftover DeepSeek flash id after switching to xAI is
 * treated as stale so the TUI can pick a same-family default.
 *
 * A non-empty `listed` catalog is an extra constraint, not a bypass: a dirty
 * directory that still contains `deepseek-v4-flash` must not keep that id on
 * an xAI parent.
 */
export function subagentModelMatchesProvider(
  provider: string,
  model: string,
  listed: readonly string[] = [],
): boolean {
  const id = model.trim()
  if (id === '') return false
  if (listed.length > 0 && !listed.includes(id)) return false
  const family = providerFamily(provider)
  if (family === 'xai') return modelLooksLike(id, GROK_MODEL_MARKERS)
  if (family === 'deepseek') return modelLooksLike(id, DEEPSEEK_MODEL_MARKERS)
  // Unknown catalog: a leftover Grok id is stale on a non-xAI route.
  if (modelLooksLike(id, GROK_MODEL_MARKERS)) return false
  return true
}

/** Cheap vs expensive hint for the automatic subagent default. */
export type SubagentCostClass = 'light' | 'heavy' | 'other'

/**
 * Classify a model id for the subagent default. Flash / lite / mini / small
 * and Grok 4.5 / 4.3 count as light; pro / max / 4.6 count as heavy so
 * `/status` can show when the catalog had nothing cheaper.
 */
export function subagentCostClass(model: string): SubagentCostClass {
  const id = model.trim().toLowerCase()
  if (id === '') return 'other'
  if (isFlashLike(id) || id.includes('lite') || id.includes('mini') || id.includes('small')) return 'light'
  if (modelLooksLike(id, GROK_MODEL_MARKERS) && (id.includes('4.5') || id.includes('4.3'))) return 'light'
  if (id.includes('pro') || id.includes('max') || id.includes('4.6')) return 'heavy'
  return 'other'
}

/** One `/status` line describing the live subagent route vs the parent. */
export function describeSubagentFit(input: {
  parentProvider: string
  parentModel?: string
  subProvider?: string
  subModel: string
}): { line: string; sameFamily: boolean; expensive: boolean; following: boolean } {
  const following = input.subProvider === undefined
  const sameFamily = subagentModelMatchesProvider(input.parentProvider, input.subModel)
  const cost = subagentCostClass(input.subModel)
  const followLabel = following ? t('sub.followParent') : t('sub.pinned', { provider: input.subProvider ?? '' })
  const familyLabel = sameFamily ? t('sub.sameFamily') : t('sub.crossFamily')
  const costLabel = cost === 'light'
    ? t('sub.light')
    : cost === 'heavy'
      ? (following ? t('sub.expensiveNoLight') : t('sub.expensive'))
      : ''
  const familyCost = costLabel === '' ? familyLabel : `${familyLabel} · ${costLabel}`
  return {
    line: t('sub.line', { model: input.subModel, follow: followLabel, fit: familyCost }),
    sameFamily,
    expensive: cost === 'heavy',
    following,
  }
}

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
