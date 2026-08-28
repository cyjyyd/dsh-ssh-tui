/**
 * Remember the last model/effort per provider so /model and /setup can switch
 * routes without wiping the previous provider's choice.
 */
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

export const ROUTE_MEMORY_NAMESPACE = settingsNamespace('ssh-tui-routes')

/** Settings schema for `$DSH_HOME/settings.yaml` under ssh-tui-routes. */
export const ROUTE_MEMORY_SCHEMA = z.object({
  providers: z.dict(z.object({
    model: z.string(),
    reasoningEffort: z.string().default(''),
  })).default({}),
})

export interface RememberedRoute {
  model: string
  reasoningEffort?: string
}

export type RouteMemoryMap = Record<string, RememberedRoute>

export function parseRouteMemory(raw: unknown): RouteMemoryMap {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: RouteMemoryMap = {}
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = provider.trim()
    if (id === '' || value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const row = value as Record<string, unknown>
    const model = typeof row.model === 'string' ? row.model.trim() : ''
    if (model === '') continue
    const effort = typeof row.reasoningEffort === 'string' ? row.reasoningEffort.trim() : ''
    out[id] = effort === '' ? { model } : { model, reasoningEffort: effort }
  }
  return out
}

export function rememberedRouteFor(memory: RouteMemoryMap, provider: string): RememberedRoute | undefined {
  return memory[provider.trim()]
}

/** Register the route-memory settings section so /model and /provider can persist. */
export function installRouteMemory(ctx: Context): void {
  installSettingsSection(ctx, ROUTE_MEMORY_NAMESPACE, ROUTE_MEMORY_SCHEMA, {
    providers: {},
  }, {
    setSource: () => {},
    onChange: () => {},
  })
}

export function upsertRememberedRoute(
  memory: RouteMemoryMap,
  provider: string,
  route: RememberedRoute,
): RouteMemoryMap {
  const id = provider.trim()
  if (id === '' || route.model.trim() === '') return memory
  return {
    ...memory,
    [id]: route.reasoningEffort === undefined || route.reasoningEffort === ''
      ? { model: route.model }
      : { model: route.model, reasoningEffort: route.reasoningEffort },
  }
}
