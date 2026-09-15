/**
 * Route context-window sizing for hand-declared gateways.
 *
 * A gateway whose `GET /models` discloses no capacity leaves every model on the
 * route at the harness default (262,144), so a long session compacts far
 * earlier than the endpoint requires. `/setup` closes that gap from two
 * sources, in order: the listing's own `context_length`, then the installed
 * pi-ai catalog, which sizes 1,200-odd models under its own provider ids.
 *
 * A gateway id is rarely a catalog id verbatim — `gemini-claude-sonnet-4-6`
 * proxies `claude-sonnet-4-6`, `deepseek/deepseek-v4.1-flash` is namespaced,
 * `gemini-3.6-flash-high` names its thinking level — so the lookup normalizes
 * before it matches, and reports nothing rather than guessing a window it
 * never found.
 *
 * @module dsh-ssh-tui/context-window
 */

import type { CatalogPreset } from './provider-catalog.js'

/** Trailing words a gateway uses to name a thinking level rather than a model. */
const EFFORT_SUFFIXES = [
  '-nothinking', '-no-thinking', '-thinking', '-reasoning', '-reasoner',
  '-xhigh', '-minimal', '-medium', '-high', '-low', '-max', '-fast',
] as const
/** Trailing words a gateway uses to name a tier, not a model. */
const TIER_SUFFIXES = ['-contributor', '-free', '-paid'] as const
/** Words a gateway may put in front of the model family it proxies. */
const NAMESPACE_HEADS = new Set([
  'gemini', 'vertex', 'google', 'azure', 'bedrock', 'aws', 'openai', 'anthropic', 'antigravity',
])
/** Family words that make the remainder after a namespace a model id. */
const FAMILY_HEADS = [
  'claude', 'gpt', 'gemini', 'deepseek', 'grok', 'kimi', 'glm', 'qwen', 'minimax', 'llama', 'mistral', 'command',
] as const

/** Drop one gateway namespace word when what follows is a recognizable family. */
function stripNamespace(id: string): string {
  const cut = id.indexOf('-')
  if (cut <= 0) return id
  const head = id.slice(0, cut).toLowerCase()
  const rest = id.slice(cut + 1)
  if (!NAMESPACE_HEADS.has(head)) return id
  const lower = rest.toLowerCase()
  return FAMILY_HEADS.some(family => lower.startsWith(family)) ? rest : id
}

/**
 * Catalog ids to try for one gateway model id, most specific first.
 * @param raw - the id the endpoint advertises.
 * @returns lowercased candidates, deduplicated and order-preserving.
 */
export function catalogIdCandidates(raw: string): string[] {
  const out: string[] = []
  const push = (value: string): void => {
    const id = value.trim().toLowerCase()
    if (id !== '' && !out.includes(id)) out.push(id)
  }
  const expanded = new Set<string>()
  const expand = (seed: string): void => {
    if (seed === '' || expanded.has(seed)) return
    expanded.add(seed)
    push(seed)
    // `:free` / `:batch` are listing tags, not part of the model id.
    const untagged = seed.replace(/:[a-z0-9.-]+$/u, '')
    push(untagged)
    push(stripNamespace(untagged))
    for (const suffix of [...EFFORT_SUFFIXES, ...TIER_SUFFIXES]) {
      if (!untagged.endsWith(suffix)) continue
      const trimmed = untagged.slice(0, -suffix.length)
      expand(trimmed)
      expand(stripNamespace(trimmed))
    }
    // `-20250929` release stamps.
    const undated = untagged.replace(/-\d{8}$/u, '')
    if (undated !== untagged) expand(undated)
    // The catalog carries both spellings of the major/minor separator.
    const dotted = untagged.replace(/(\d)-(\d)(?=$|-)/u, '$1.$2')
    const dashed = untagged.replace(/(\d)\.(\d)/gu, '$1-$2')
    if (dotted !== untagged) push(dotted)
    if (dashed !== untagged) push(dashed)
  }
  const input = raw.trim()
  expand(input)
  if (input.includes('/')) expand(input.slice(input.lastIndexOf('/') + 1))
  return out
}

/**
 * Every catalog window, keyed by lowercased model id. The first provider to
 * size an id wins, so a shared id keeps one stable answer.
 * @param presets - the read catalog presets.
 * @returns the lookup index.
 */
export function catalogWindowIndex(presets: readonly CatalogPreset[]): Map<string, number> {
  const index = new Map<string, number>()
  for (const preset of presets) {
    for (const [id, window] of Object.entries(preset.capacities ?? {})) {
      if (Number.isFinite(window) && window > 0 && !index.has(id)) index.set(id, window)
    }
  }
  return index
}

/**
 * The catalog window for one gateway model id.
 * @param id - the id the endpoint advertises.
 * @param index - {@link catalogWindowIndex} for the loaded catalog.
 * @returns the window, or `undefined` when no candidate names a sized model.
 */
export function catalogContextWindow(id: string, index: ReadonlyMap<string, number>): number | undefined {
  for (const candidate of catalogIdCandidates(id)) {
    const window = index.get(candidate)
    if (window !== undefined) return window
  }
  return undefined
}

/**
 * The route-level default to persist: the smallest window discovered for the
 * route's selected models. A model neither the listing nor the catalog sizes
 * then inherits a value the route already proved it serves, never more.
 * @param windows - the per-model windows discovered so far.
 * @returns the window, or `undefined` when nothing was discovered.
 */
export function suggestedRouteContextWindow(windows: Iterable<number>): number | undefined {
  let smallest: number | undefined
  for (const window of windows) {
    if (!Number.isFinite(window) || window <= 0) continue
    if (smallest === undefined || window < smallest) smallest = window
  }
  return smallest
}
