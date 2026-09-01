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
    updatedAt: z.number(),
  })).default({}),
})

export interface RememberedRoute {
  model: string
  reasoningEffort?: string
  /** Epoch ms of the last time this route was persisted (0 for legacy entries). */
  updatedAt?: number
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
    const updatedAt = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0
    out[id] = {
      model,
      ...(effort === '' ? {} : { reasoningEffort: effort }),
      ...(updatedAt > 0 ? { updatedAt } : {}),
    }
  }
  return out
}

export function rememberedRouteFor(memory: RouteMemoryMap, provider: string): RememberedRoute | undefined {
  return memory[provider.trim()]
}

/** The most recently persisted route (highest updatedAt), or undefined. */
export function latestRememberedRoute(
  memory: RouteMemoryMap,
): (RememberedRoute & { provider: string }) | undefined {
  let best: (RememberedRoute & { provider: string }) | undefined
  for (const [provider, route] of Object.entries(memory)) {
    if (best === undefined || (route.updatedAt ?? 0) > (best.updatedAt ?? 0)) {
      best = { ...route, provider }
    }
  }
  return best
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
    [id]: {
      ...(route.reasoningEffort === undefined || route.reasoningEffort === ''
        ? { model: route.model }
        : { model: route.model, reasoningEffort: route.reasoningEffort }),
      updatedAt: Date.now(),
    },
  }
}
