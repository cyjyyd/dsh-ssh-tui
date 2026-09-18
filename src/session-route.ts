/**
 * Per-session provider/model memory.
 *
 * The parent route and the subagent route used to be one global choice: `/model`
 * and `/submodel` wrote a default that every later session inherited. Once a
 * child could run on a *different* supplier that stopped being enough — resuming
 * an old conversation silently re-ran it on whatever the last conversation used,
 * and there was no way to see which supplier had paid for the earlier one.
 *
 * Each session's effective route is recorded here, next to the TUI's other
 * per-session state under `$DSH_HOME`, and applied when that session starts
 * again. A new session still starts from the global default; the record only
 * ever overrides it for the session it belongs to, and never for another one.
 *
 * The record is a cache of a decision, not a source of truth: every field is
 * parsed defensively, and a route whose provider no longer exists is still
 * applied (the launcher reports the failure the same way it would for a CLI
 * flag).
 *
 * @module dsh-ssh-tui/session-route
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from './display-sock.js'
import { adoptSessionSubagentSelection, normalizeSubagentSelection, type SubagentSelectionRef } from './subagent-model.js'

/** Subagent route as this session ran it; no provider means "follows parent". */
export interface SessionSubagentRoute {
  provider?: string
  model: string
  reasoningEffort?: string
}

/** One session's route: what `/model`, `/provider`, `/submodel` settled on. */
export interface SessionRoute {
  provider: string
  model: string
  reasoningEffort?: string
  subagent?: SessionSubagentRoute
  /** Epoch ms of the last write; the oldest records are pruned first. */
  updatedAt: number
}

interface SessionRouteFile {
  version: number
  entries: Record<string, SessionRoute>
}

/** Bumped when the stored shape changes meaning; older files are ignored. */
const ROUTE_FILE_VERSION = 1

/**
 * How many sessions keep a record. The file is a convenience cache, and a
 * hundred-odd conversations is more history than a resume picker offers.
 */
export const SESSION_ROUTE_LIMIT = 200

export function sessionRoutePath(dshHome: string = resolveDshHome()): string {
  return join(dshHome, 'tui-session-routes.json')
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseSubagentRoute(raw: unknown): SessionSubagentRoute | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  const model = trimmed(row.model)
  if (model === '') return undefined
  const provider = trimmed(row.provider)
  const effort = trimmed(row.reasoningEffort)
  return {
    ...(provider === '' ? {} : { provider }),
    model,
    ...(effort === '' ? {} : { reasoningEffort: effort }),
  }
}

/** Parse one record; anything that cannot name a route is dropped. */
export function parseSessionRoute(raw: unknown): SessionRoute | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  const provider = trimmed(row.provider)
  const model = trimmed(row.model)
  if (provider === '' || model === '') return undefined
  const effort = trimmed(row.reasoningEffort)
  const subagent = parseSubagentRoute(row.subagent)
  const updatedAt = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt)
    ? Math.max(0, row.updatedAt)
    : 0
  return {
    provider,
    model,
    ...(effort === '' ? {} : { reasoningEffort: effort }),
    ...(subagent === undefined ? {} : { subagent }),
    updatedAt,
  }
}

/** Parse the whole file; a file from another version reads as empty. */
export function parseSessionRoutes(raw: unknown): Map<string, SessionRoute> {
  const out = new Map<string, SessionRoute>()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const file = raw as Partial<SessionRouteFile>
  if (file.version !== ROUTE_FILE_VERSION) return out
  const entries = file.entries
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return out
  for (const [sessionId, value] of Object.entries(entries as Record<string, unknown>)) {
    const id = sessionId.trim()
    if (id === '') continue
    const route = parseSessionRoute(value)
    if (route !== undefined) out.set(id, route)
  }
  return out
}

export async function loadSessionRoutes(
  path: string = sessionRoutePath(),
): Promise<Map<string, SessionRoute>> {
  try {
    return parseSessionRoutes(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return new Map()
  }
}

/** The record for one session, or undefined when it never had one. */
export async function loadSessionRoute(
  sessionId: string,
  path: string = sessionRoutePath(),
): Promise<SessionRoute | undefined> {
  const id = sessionId.trim()
  if (id === '') return undefined
  return (await loadSessionRoutes(path)).get(id)
}

/** Keep the newest `limit` records, so the file cannot grow without bound. */
export function pruneSessionRoutes(
  entries: ReadonlyMap<string, SessionRoute>,
  limit: number = SESSION_ROUTE_LIMIT,
): Map<string, SessionRoute> {
  if (entries.size <= limit) return new Map(entries)
  const newest = [...entries.entries()]
    .sort((left, right) => (right[1].updatedAt ?? 0) - (left[1].updatedAt ?? 0))
    .slice(0, Math.max(0, limit))
  return new Map(newest)
}

export async function saveSessionRoutes(
  path: string,
  entries: ReadonlyMap<string, SessionRoute>,
): Promise<boolean> {
  const payload: SessionRouteFile = {
    version: ROUTE_FILE_VERSION,
    entries: Object.fromEntries(pruneSessionRoutes(entries)),
  }
  const body = `${JSON.stringify(payload)}\n`
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
    return true
  } catch {
    try {
      await writeFile(path, body, { encoding: 'utf8', mode: 0o600 })
      return true
    } catch {
      // A route that cannot be written is a session that starts from the
      // default next time, not a broken turn.
      return false
    }
  }
}

/**
 * Record one session's route, leaving every other session alone.
 *
 * Read-modify-write on purpose: two Hosts (two SSH windows) can be open at
 * once, and neither may drop the other's entry.
 */
export async function saveSessionRoute(
  sessionId: string,
  route: Omit<SessionRoute, 'updatedAt'>,
  path: string = sessionRoutePath(),
): Promise<boolean> {
  const id = sessionId.trim()
  const parsed = parseSessionRoute({ ...route, updatedAt: Date.now() })
  if (id === '' || parsed === undefined) return false
  const entries = await loadSessionRoutes(path)
  entries.set(id, parsed)
  return saveSessionRoutes(path, entries)
}

/** Whether two records describe the same route (the timestamp is ignored). */
export function sameSessionRoute(
  left: SessionRoute | undefined,
  right: Omit<SessionRoute, 'updatedAt'> | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.provider !== right.provider || left.model !== right.model) return false
  if ((left.reasoningEffort ?? '') !== (right.reasoningEffort ?? '')) return false
  const a = left.subagent
  const b = right.subagent
  if (a === undefined || b === undefined) return a === b
  return a.model === b.model
    && (a.provider ?? '') === (b.provider ?? '')
    && (a.reasoningEffort ?? '') === (b.reasoningEffort ?? '')
}

/**
 * Shape a live parent route plus the subagent selection into a record.
 *
 * Shared by the TUI (which reports what its refs hold) and the launcher (which
 * writes it), so the two cannot disagree about what a session was running on.
 * An empty provider or model yields nothing: a record that cannot name a route
 * would come back as a lie.
 */
export function sessionRouteInput(input: {
  provider: string
  model: string
  reasoningEffort?: string
  subagent?: { provider?: string; model: string; reasoningEffort?: string }
}): Omit<SessionRoute, 'updatedAt'> | undefined {
  const provider = input.provider.trim()
  const model = input.model.trim()
  if (provider === '' || model === '') return undefined
  const effort = input.reasoningEffort?.trim() ?? ''
  const subagent = input.subagent
  const subagentModel = subagent?.model.trim() ?? ''
  const subagentProvider = subagent?.provider?.trim() ?? ''
  const subagentEffort = subagent?.reasoningEffort?.trim() ?? ''
  return {
    provider,
    model,
    ...(effort === '' ? {} : { reasoningEffort: effort }),
    ...(subagent === undefined || subagentModel === ''
      ? {}
      : {
          subagent: {
            ...(subagentProvider === '' ? {} : { provider: subagentProvider }),
            model: subagentModel,
            ...(subagentEffort === '' ? {} : { reasoningEffort: subagentEffort }),
          },
        }),
  }
}

/**
 * Providers the harness ships with. They are routable in any install even when
 * the adapter list is still warming up, so a record naming one is never treated
 * as stale on that basis alone.
 */
export const BUILTIN_ROUTABLE_PROVIDERS = ['deepseek-official', 'xai', 'opencode-go', 'opencode'] as const

/**
 * Whether this install can still route to a provider.
 *
 * Deliberately permissive: the cost of wrongly *keeping* a record is an error the
 * harness already reports clearly (an unknown route, the same one a launch flag
 * would hit), while wrongly *dropping* one silently loses the session's route —
 * which is the whole feature. So a provider counts as routable when it is a
 * built-in, appears in the adapter list, has a configured `llm-pi-ai` profile, or
 * is listed by the adapter's own model catalog.
 */
export function providerIsRoutable(input: {
  provider: string
  /** Ids from `llm.listProviders()`. */
  listed?: readonly string[]
  /** Ids with an `llm-pi-ai.providers.<id>` section. */
  configured?: readonly string[]
}): boolean {
  const id = input.provider.trim()
  if (id === '') return false
  if ((BUILTIN_ROUTABLE_PROVIDERS as readonly string[]).includes(id)) return true
  if ((input.listed ?? []).some(entry => entry.trim() === id)) return true
  return (input.configured ?? []).some(entry => entry.trim() === id)
}

/** What a resumed session's record is worth in this install. */
export interface RouteAvailabilityPlan {
  /** The parent route, when the provider it names can still be routed to. */
  route?: SessionRoute
  /** The subagent route, when its own pin can be routed to as well. */
  subagent?: SessionSubagentRoute
  /** Recorded parent provider that is gone; the caller says so on screen. */
  droppedProvider?: string
  /** Recorded subagent pin that is gone; the app-level setting takes over. */
  droppedSubagentProvider?: string
}

/**
 * Decide what of a recorded route still applies.
 *
 * A provider that no longer exists takes its whole record with it: the session
 * was configured around that supplier (its model, its effort, and the children
 * it pinned), so the honest answer is the app-level default for all of it rather
 * than a half-restored route. A pinned *child* provider that is gone is narrower:
 * the parent route is kept and the children fall back to the app-level subagent
 * setting. An inherited child route has no pin to check — it follows the parent,
 * which was just found routable.
 */
export function routeAvailabilityPlan(input: {
  recorded?: SessionRoute
  routable: (provider: string) => boolean
}): RouteAvailabilityPlan {
  const recorded = input.recorded
  if (recorded === undefined) return {}
  if (!input.routable(recorded.provider)) return { droppedProvider: recorded.provider }
  const subagent = recorded.subagent
  if (subagent === undefined) return { route: recorded }
  if (subagent.provider !== undefined && !input.routable(subagent.provider)) {
    return { route: recorded, droppedSubagentProvider: subagent.provider }
  }
  return { route: recorded, subagent }
}

/**
 * Apply a resumed session's record to the live selection.
 *
 * Returns what the record was worth (see `routeAvailabilityPlan`) so the
 * launcher can say which route the session came back on — and, when a supplier
 * has been removed since, which one it fell back from. A new session is left
 * alone, and so is a resumed one that never had a record: both start from the
 * app-level defaults, which is the behaviour before any of this existed.
 *
 * The subagent route is applied in memory only: it belongs to the conversation
 * being resumed, and writing it back to the settings would make one session's
 * pin the default for every later session.
 */
export async function restoreSessionRoute(input: {
  sessionId: string
  resume: boolean
  subagentSelection: SubagentSelectionRef
  path?: string
  /** Availability test; omitted means "everything is routable". */
  routable?: (provider: string) => boolean
}): Promise<RouteAvailabilityPlan> {
  if (!input.resume) return {}
  const recorded = await loadSessionRoute(input.sessionId, input.path ?? sessionRoutePath())
  const plan = routeAvailabilityPlan({
    ...(recorded === undefined ? {} : { recorded }),
    routable: input.routable ?? (() => true),
  })
  if (plan.subagent !== undefined) {
    adoptSessionSubagentSelection(input.subagentSelection, normalizeSubagentSelection(plan.subagent))
  }
  return plan
}

/** One remembered route as the launch waterfall sees it. */
export interface LaunchRouteSource {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface LaunchRouteInput {
  /** In-process change from `/model` or `/setup` earlier in this process. */
  live?: LaunchRouteSource
  /** Launch flags (`--provider` / `--model`). */
  cli?: { provider?: string; model?: string }
  /** This session's own record, when the launch resumes it. */
  session?: SessionRoute
  /** Global default (the settings file, or `agent-default-model`). */
  saved?: LaunchRouteSource
  /** Last model per provider, used only when no user default section exists. */
  remembered?: LaunchRouteSource
}

export interface LaunchRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * The route a launch should run on, in one place.
 *
 * Precedence: an in-process change, then launch flags, then the session's own
 * record, then the global default, then the last remembered route. A resumed
 * conversation therefore comes back on the supplier it was actually using, while
 * a new one still starts from the default — and an explicit flag still wins,
 * because that is this launch's ask.
 *
 * The reasoning effort travels with the route it was chosen for: it is taken
 * from whichever source supplied the provider/model, and only when the flags did
 * not move the route away from it. A CLI that changes either half must not
 * inherit the saved effort of a different model.
 */
export function resolveLaunchRoute(input: LaunchRouteInput): LaunchRoute {
  const provider = input.live?.provider
    ?? input.cli?.provider
    ?? input.session?.provider
    ?? input.saved?.provider
    ?? input.remembered?.provider
    ?? 'deepseek-official'
  const model = input.live?.model
    ?? input.cli?.model
    ?? input.session?.model
    ?? input.saved?.model
    ?? input.remembered?.model
    ?? 'deepseek-v4-flash'
  // An in-process selection decides on its own: a `/model` that picked "provider
  // default" means no effort, not "the effort this route happened to carry".
  const effort = input.live !== undefined
    ? input.live.reasoningEffort
    : input.session !== undefined && input.session.provider === provider && input.session.model === model
      ? input.session.reasoningEffort
      : input.saved !== undefined && input.saved.provider === provider && input.saved.model === model
        ? input.saved.reasoningEffort
        : input.remembered !== undefined && input.remembered.provider === provider && input.remembered.model === model
          ? input.remembered.reasoningEffort
          : undefined
  return {
    provider,
    model,
    ...(effort === undefined || effort === '' ? {} : { reasoningEffort: effort }),
  }
}
