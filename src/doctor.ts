/**
 * `/doctor`: one pass over the deployment's composition, dependencies, and
 * compatibility, each verdict carrying the row, line, or path behind it.
 *
 * `/diag` answers "why can't I get in?" about one session's channel, lock, and
 * Host. `/doctor` answers the other half — "is this install composed the way
 * the plugin needs?" — which is where 0.6.3's regression lived: 0.5.1 dropped
 * the roster rows to pass a store check, and the only symptom was `/mode`
 * reporting a missing service months later. Every check therefore reports the
 * concrete row (with its line) or path, plus the command that acts on it.
 *
 * The verdicts are a pure function of collected facts, so they are testable
 * without a Host, a profile, or a filesystem; collection lives in
 * `collectDoctor` and every probe is best-effort. Nothing leaves the machine.
 * @module dsh-ssh-tui/doctor
 */

import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { t } from './i18n/index.js'
import {
  analyzePatch,
  duplicatePatchRows,
  missingRosterRows,
  patchNamesRow,
  rosterPatchPath,
  ROSTER_ROWS,
  type PatchAnalysis,
  type PatchRowRef,
  type RosterRow,
} from './preset-rows.js'
import { subagentModelMatchesProvider } from './subagent-model.js'

export type DoctorStatus = 'ok' | 'warn' | 'fail'

export interface DoctorCheck {
  id: string
  status: DoctorStatus
  /** One line: the conclusion. */
  summary: string
  /** The rows, lines, and paths behind the conclusion. */
  details: string[]
  /** Whether `/doctor --fix` (or `/fix <row>`) can act on this check. */
  fixable?: boolean
}

/** One route's model list, for the routing self-consistency check. */
export interface DoctorRouting {
  provider?: string
  model?: string
  /** Every provider id the llm-pi-ai section configures. */
  routes: readonly string[]
  /** Model ids the selected provider's route lists. */
  routeModels: readonly string[]
  subProvider?: string
  subModel?: string
}

export interface DoctorFacts {
  pluginVersion: string
  hostVersion: string
  nodeVersion: string
  profile: string
  dshHome: string
  patchPath: string
  /** Services the running composition actually registered. */
  services: {
    /** `agentPresets` — the roster `/mode` lists. */
    roster: boolean
    /** `codeRuntime` — what the PTC preset mounts. */
    codeRuntime: boolean
  }
  /** The profile patch. `readable` is false when it does not exist yet. */
  patch: { readable: boolean; text: string; analysis: PatchAnalysis }
  /** Rows the plugin's own bundle patch mounts. */
  bundleRows: readonly PatchRowRef[]
  /** The manifest's compatibility declaration, when the package is readable. */
  compatibility?: { range?: string; releases: Record<string, string> }
  /** Distinct installs of `@deepseek-ai/dsh-scope` found from the anchors. */
  scopeCopies: readonly string[]
  /** Absent when routing could not be read (no settings service). */
  routing?: DoctorRouting
}

/** Where a row was found, as one detail line. */
function rowDetail(row: { id: string; line: number }): string {
  return t('doctor.detail.row', { id: row.id, line: String(row.line) })
}

/**
 * Every check, in report order. Pure: same facts in, same verdicts out.
 * @param facts - one collected snapshot.
 * @returns the checks, each with its conclusion and evidence.
 */
export function doctorChecks(facts: DoctorFacts): DoctorCheck[] {
  const { analysis } = facts.patch
  const rosterRow = ROSTER_ROWS[0]
  const codeRuntimeRow = ROSTER_ROWS[1]
  const subagentRow = ROSTER_ROWS[2]
  const checks: DoctorCheck[] = []

  // 1. The patch file itself: everything else reads from it.
  if (!facts.patch.readable) {
    checks.push({
      id: 'patch',
      status: 'fail',
      summary: t('doctor.patch.missing', { path: facts.patchPath }),
      details: [t('doctor.patch.missingHint')],
      fixable: true,
    })
  } else if (!analysis.parseable) {
    checks.push({
      id: 'patch',
      status: 'fail',
      summary: t('doctor.patch.broken', { error: analysis.error ?? '' }),
      details: [facts.patchPath, t('doctor.patch.brokenHint')],
    })
  } else {
    checks.push({
      id: 'patch',
      status: 'ok',
      summary: t('doctor.patch.ok', { rows: String(analysis.rows.length) }),
      details: [facts.patchPath],
    })
  }

  // 2. The roster service: without it /mode cannot switch and the preset-owned
  //    tools are absent from the catalog.
  if (facts.services.roster) {
    checks.push({ id: 'roster', status: 'ok', summary: t('doctor.roster.ok'), details: [] })
  } else {
    const declared = rosterRow !== undefined && analysis.parseable && patchNamesRow(analysis.rows, rosterRow)
    checks.push({
      id: 'roster',
      status: 'fail',
      summary: t('doctor.roster.fail'),
      details: rosterRow === undefined
        ? []
        : declared
          ? [t('doctor.detail.declaredNoService', { id: rosterRow.id })]
          : [t('doctor.detail.missingRow', { id: rosterRow.id })],
      fixable: !declared,
    })
  }

  // 3. code-runtime: the PTC preset mounts it, so its absence is the second
  //    half of the same regression.
  if (facts.services.codeRuntime) {
    checks.push({ id: 'code-runtime', status: 'ok', summary: t('doctor.codeRuntime.ok'), details: [] })
  } else {
    const declared = codeRuntimeRow !== undefined && analysis.parseable && patchNamesRow(analysis.rows, codeRuntimeRow)
    checks.push({
      id: 'code-runtime',
      status: 'fail',
      summary: t('doctor.codeRuntime.fail'),
      details: codeRuntimeRow === undefined
        ? []
        : declared
          ? [t('doctor.detail.declaredNoService', { id: codeRuntimeRow.id })]
          : [t('doctor.detail.missingRow', { id: codeRuntimeRow.id })],
      fixable: !declared,
    })
  }

  // 4. The subagent settings row has no runtime service to probe, so the patch
  //    text is the only evidence.
  if (!analysis.parseable) {
    checks.push({ id: 'subagent-settings', status: 'warn', summary: t('doctor.subagentSettings.unknown'), details: [] })
  } else if (subagentRow === undefined || patchNamesRow(analysis.rows, subagentRow)) {
    checks.push({ id: 'subagent-settings', status: 'ok', summary: t('doctor.subagentSettings.ok'), details: [] })
  } else {
    checks.push({
      id: 'subagent-settings',
      status: 'warn',
      summary: t('doctor.subagentSettings.warn'),
      details: [t('doctor.detail.missingRow', { id: subagentRow.id })],
      fixable: true,
    })
  }

  // 5. Duplicate inserts fail at load time with "service has been registered".
  const duplicates = duplicatePatchRows(analysis.rows)
  if (duplicates.length === 0) {
    checks.push({ id: 'duplicates', status: 'ok', summary: t('doctor.duplicates.ok'), details: [] })
  } else {
    checks.push({
      id: 'duplicates',
      status: 'fail',
      summary: t('doctor.duplicates.fail', { count: String(duplicates.length) }),
      details: duplicates.map(rowDetail),
      fixable: true,
    })
  }

  // 6. A row mounted by both the profile layer and this plugin's bundle layer.
  const conflicts = facts.bundleRows.filter(bundle =>
    analysis.rows.some(row => row.kind === 'insert' && (row.id === bundle.id || (row.name !== undefined && row.name === bundle.name))))
  if (conflicts.length === 0) {
    checks.push({ id: 'bundle-conflicts', status: 'ok', summary: t('doctor.bundle.ok'), details: [] })
  } else {
    checks.push({
      id: 'bundle-conflicts',
      status: 'fail',
      summary: t('doctor.bundle.fail', { count: String(conflicts.length) }),
      details: conflicts.map(row => t('doctor.detail.missingRow', { id: row.id })),
    })
  }

  // 7. The host version against the manifest's declared window.
  const releases = facts.compatibility?.releases ?? {}
  const declared = Object.keys(releases)
  const status = releases[facts.hostVersion]
  if (status === 'compatible') {
    checks.push({
      id: 'version',
      status: 'ok',
      summary: t('doctor.version.ok', { version: facts.hostVersion }),
      details: facts.compatibility?.range === undefined ? [] : [t('doctor.detail.range', { range: facts.compatibility.range })],
    })
  } else if (status !== undefined) {
    checks.push({
      id: 'version',
      status: 'warn',
      summary: t('doctor.version.unknown', { version: facts.hostVersion, status }),
      details: [t('doctor.detail.declared', { versions: declared.join(', ') })],
    })
  } else {
    checks.push({
      id: 'version',
      status: 'warn',
      summary: t('doctor.version.absent', { version: facts.hostVersion }),
      details: declared.length === 0 ? [] : [t('doctor.detail.declared', { versions: declared.join(', ') })],
    })
  }

  // 8. Two copies of dsh-scope make preset composition refuse an unscoped
  //    context; npm's nested install is the usual source.
  if (facts.scopeCopies.length === 1) {
    checks.push({
      id: 'scope-copies',
      status: 'ok',
      summary: t('doctor.scope.ok'),
      details: [...facts.scopeCopies],
    })
  } else if (facts.scopeCopies.length === 0) {
    checks.push({ id: 'scope-copies', status: 'warn', summary: t('doctor.scope.unknown'), details: [] })
  } else {
    checks.push({
      id: 'scope-copies',
      status: 'fail',
      summary: t('doctor.scope.fail', { count: String(facts.scopeCopies.length) }),
      details: [...facts.scopeCopies],
    })
  }

  // 9. Routing self-consistency, when settings could be read.
  if (facts.routing !== undefined) {
    checks.push(routingCheck(facts.routing))
  }
  return checks
}

/** The selected provider, its model list, and the subagent selection, compared. */
function routingCheck(routing: DoctorRouting): DoctorCheck {
  const problems: string[] = []
  const provider = routing.provider
  if (provider !== undefined && !routing.routes.includes(provider)) {
    problems.push(t('doctor.routing.providerMissing', { provider, routes: routing.routes.join(', ') || '—' }))
  }
  if (provider !== undefined && routing.model !== undefined && routing.routeModels.length > 0
    && !routing.routeModels.includes(routing.model)) {
    problems.push(t('doctor.routing.modelMissing', { model: routing.model, provider }))
  }
  const subProvider = routing.subProvider ?? provider
  if (subProvider !== undefined && routing.subModel !== undefined
    && !subagentModelMatchesProvider(subProvider, routing.subModel)) {
    problems.push(t('doctor.routing.subMismatch', { model: routing.subModel, provider: subProvider }))
  }
  if (problems.length === 0) {
    return { id: 'routing', status: 'ok', summary: t('doctor.routing.ok'), details: [] }
  }
  return {
    id: 'routing',
    status: 'warn',
    summary: t('doctor.routing.warn', { count: String(problems.length) }),
    details: problems,
  }
}

/** `[ok]` / `⚠` / `✖`, in the same vocabulary the tool cards use. */
function statusMark(status: DoctorStatus): string {
  return status === 'ok' ? '●' : status === 'warn' ? '⚠' : '✖'
}

/** The whole report as transcript lines. Pure. */
export function formatDoctorReport(facts: DoctorFacts, checks: readonly DoctorCheck[]): string[] {
  const lines: string[] = []
  lines.push(t('doctor.title'))
  lines.push(t('doctor.rowContext', {
    profile: facts.profile,
    plugin: facts.pluginVersion,
    dsh: facts.hostVersion,
    node: facts.nodeVersion,
  }))
  lines.push(t('doctor.rowPatch', { path: facts.patchPath }))
  const counts = {
    ok: checks.filter(check => check.status === 'ok').length,
    warn: checks.filter(check => check.status === 'warn').length,
    fail: checks.filter(check => check.status === 'fail').length,
  }
  lines.push(t('doctor.rowSummary', { ok: String(counts.ok), warn: String(counts.warn), fail: String(counts.fail) }))
  lines.push('')
  for (const check of checks) {
    lines.push(`${statusMark(check.status)} ${check.summary}`)
    for (const detail of check.details) lines.push(`    ${detail}`)
    if (check.fixable === true && check.status !== 'ok') lines.push(`    ${t('doctor.fixHint')}`)
  }
  return lines
}

/**
 * Distinct installs of `@deepseek-ai/dsh-scope` reachable from the anchors.
 *
 * Anchors are the running CLI entry and the plugin's module base, the same two
 * the provider catalog walks: a nested npm install puts a second copy under one
 * of them, and preset composition then fails with "refusing to compose an
 * unscoped context".
 * @param anchors - file or directory paths that plausibly sit inside the install.
 * @returns real paths, deduplicated; empty when none was found.
 */
export function findScopeCopies(anchors: ReadonlyArray<string | undefined>): string[] {
  const found = new Set<string>()
  for (const anchor of anchors) {
    if (anchor === undefined || anchor === '') continue
    let current = anchor.startsWith('file:') ? fileURLToPath(anchor) : anchor
    for (let depth = 0; depth < 10; depth += 1) {
      const candidate = join(current, 'node_modules', '@deepseek-ai', 'dsh-scope', 'package.json')
      if (existsSync(candidate)) {
        try {
          found.add(realpathSync(dirname(candidate)))
        } catch {
          found.add(dirname(candidate))
        }
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return [...found]
}

/** The plugin's own manifest, read once for the compatibility declaration. */
function readManifest(): {
  version?: string
  dsh?: { compatibility?: { dsh?: string; dshReleases?: Record<string, string> } }
} {
  try {
    const require = createRequire(import.meta.url)
    return require('../package.json') as ReturnType<typeof readManifest>
  } catch {
    return {}
  }
}

/** The bundle patch this package ships, if it is readable. */
async function readBundleRows(): Promise<PatchRowRef[]> {
  try {
    const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    return analyzePatch(text).rows
  } catch {
    return []
  }
}

/**
 * Gather one snapshot. Every probe is best-effort: a failure is reported by the
 * check that needed it, never thrown.
 * @param options - identity, services, and the already-read routing facts.
 * @returns the facts {@link doctorChecks} turns into verdicts.
 */
export async function collectDoctor(options: {
  profile: string
  dshHome: string
  hostVersion: string
  services: DoctorFacts['services']
  anchors: ReadonlyArray<string | undefined>
  routing?: DoctorRouting
}): Promise<DoctorFacts> {
  const manifest = readManifest()
  const patchPath = rosterPatchPath(options.dshHome, options.profile)
  let readable = true
  let text = ''
  try {
    text = await readFile(patchPath, 'utf8')
  } catch {
    readable = false
  }
  const compatibility = manifest.dsh?.compatibility
  const releases = compatibility?.dshReleases ?? {}
  return {
    pluginVersion: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
    hostVersion: options.hostVersion,
    nodeVersion: process.version,
    profile: options.profile,
    dshHome: options.dshHome,
    patchPath,
    services: options.services,
    patch: { readable, text, analysis: readable ? analyzePatch(text) : { parseable: true, rows: [] } },
    bundleRows: await readBundleRows(),
    ...(compatibility === undefined
      ? {}
      : {
          compatibility: {
            ...(compatibility.dsh === undefined ? {} : { range: compatibility.dsh }),
            releases,
          },
        }),
    scopeCopies: findScopeCopies(options.anchors),
    ...(options.routing === undefined ? {} : { routing: options.routing }),
  }
}

/** Rows `/doctor --fix` would mount, given the services the composition registered. */
export function rowsToRepair(facts: DoctorFacts): RosterRow[] {
  if (!facts.patch.analysis.parseable) return []
  const missing = missingRosterRows(facts.patch.analysis.rows)
  return missing.filter(row => (row.id === ROSTER_ROWS[0]?.id && !facts.services.roster)
    || (row.id === ROSTER_ROWS[1]?.id && !facts.services.codeRuntime)
    || row.id === ROSTER_ROWS[2]?.id)
}
