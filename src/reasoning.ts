/**
 * Shared reasoning-effort defaults for the SSH TUI.
 *
 * OpenCode / third-party (llm-pi-ai) routes carry no adapter-level reasoning
 * default (unlike `llm-deepseek`, whose row declares `reasoningEffort: max`).
 * Without an explicit effort the model streams its thinking as plain `text`
 * chunks instead of `reasoning` blocks, so the TUI never receives the data
 * needed to render the collapsible `思考中` block. This helper picks a
 * supported default so the fold has data to show.
 */

import { type LlmRuntime, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/**
 * Pick a default reasoning effort for a provider/model when none is selected.
 *
 * Prefers the model's own `defaultEffort`, then `max` (matching the
 * `llm-deepseek` default), then the adapter's first supported non-`off` level.
 * Returns `undefined` when the route is unknown or the model reports no
 * reasoning support, preserving current behavior in those cases.
 */
export async function defaultReasoningEffort(
  llm: LlmRuntime,
  provider: string,
  model: string,
): Promise<ReasoningEffortId | undefined> {
  try {
    const info = await llm.resolveModelInfo(provider, model)
    const efforts = info?.reasoning?.efforts ?? []
    if (info?.reasoning?.defaultEffort !== undefined) return info.reasoning.defaultEffort
    const nonOff = efforts.filter(effort => effort.id !== 'off')
    if (nonOff.length === 0) return undefined
    const preferred = nonOff.find(effort => effort.id === 'max')
      ?? nonOff.find(effort => effort.id === 'xhigh')
      ?? nonOff.find(effort => effort.id === 'high')
      ?? nonOff[0]
    return preferred?.id
  } catch {
    return undefined
  }
}
