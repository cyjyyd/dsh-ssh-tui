/**
 * Best-effort npm latest check. Failures stay quiet. The TUI may offer to
 * run `dsh plugin --profile <name> add dsh-ssh-tui@latest` — pnpm otherwise
 * keeps the lockfile pin (e.g. 0.3.7) when the spec is a bare package name.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { t } from './i18n/index.js'

const NPM_REGISTRY = 'https://registry.npmjs.org/dsh-ssh-tui/latest'
const CHECK_TIMEOUT_MS = 4000
export const PLUGIN_PACKAGE = 'dsh-ssh-tui'

export function compareSemver(a: string, b: string): number {
  const parse = (value: string): number[] => {
    const core = value.trim().replace(/^v/u, '').split('-')[0] ?? '0'
    const parts = core.split('.').map(part => Number.parseInt(part, 10))
    return [0, 1, 2].map(i => Number.isFinite(parts[i]) ? parts[i]! : 0)
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i++) {
    if (left[i]! !== right[i]!) return left[i]! - right[i]!
  }
  return 0
}

export function resolvePluginProfileName(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_TUI_PROFILE?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const arg = env.DSH_PROFILE?.trim()
  if (arg !== undefined && arg !== '') return arg
  return 'tui'
}

export function pluginUpgradeCommand(profile = resolvePluginProfileName()): string {
  return `dsh plugin --profile ${profile} add ${PLUGIN_PACKAGE}@latest`
}

export function formatUpdateNotice(current: string, latest: string, profile = resolvePluginProfileName()): string {
  return t('update.notice', { latest, current, command: pluginUpgradeCommand(profile) })
}

export async function fetchLatestNpmVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(NPM_REGISTRY, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const body = await response.json() as { version?: unknown }
    return typeof body.version === 'string' && body.version.trim() !== '' ? body.version.trim() : undefined
  } catch {
    return undefined
  }
}

export interface PluginUpdateInfo {
  current: string
  latest: string
  profile: string
  command: string
  notice: string
}

export async function checkForPluginUpdate(current: string): Promise<PluginUpdateInfo | undefined> {
  if (process.env.DSH_TUI_NO_UPDATE_CHECK === '1' || process.env.DSH_TUI_NO_UPDATE_CHECK === 'true') {
    return undefined
  }
  const latest = await fetchLatestNpmVersion()
  if (latest === undefined) return undefined
  if (compareSemver(latest, current) <= 0) return undefined
  const profile = resolvePluginProfileName()
  return {
    current,
    latest,
    profile,
    command: pluginUpgradeCommand(profile),
    notice: formatUpdateNotice(current, latest, profile),
  }
}

/**
 * How to re-run the dsh CLI that hosts this process.
 *
 * `spawn('dsh', …)` works on POSIX and fails on Windows with
 * `spawn dsh ENOENT`: a global install there is a `dsh.cmd` shim, and
 * CreateProcess does not apply `PATHEXT` to a bare name. Re-running the CLI we
 * are already inside — the same node binary and the same entry script — needs no
 * PATH lookup and no shell at all. The shell fallback is for the case where our
 * own entry is not visible (a bundled CLI), where Windows *does* need a shell for
 * the `.cmd` shim to resolve.
 */
export interface DshInvocation {
  command: string
  /** Arguments that must precede the subcommand (node needs its entry script). */
  prefix: string[]
  shell: boolean
}

export function resolveDshInvocation(options: {
  execPath?: string
  argv?: readonly string[]
  platform?: NodeJS.Platform
  exists?: (path: string) => boolean
} = {}): DshInvocation {
  const execPath = options.execPath ?? process.execPath
  const argv = options.argv ?? process.argv
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? existsSync
  const entry = argv[1]
  if (typeof entry === 'string' && entry !== '' && exists(entry)) {
    return { command: execPath, prefix: [entry], shell: false }
  }
  return { command: 'dsh', prefix: [], shell: platform === 'win32' }
}

export async function installPluginLatest(
  profile = resolvePluginProfileName(),
  deps: { invocation?: DshInvocation; spawnFn?: typeof spawn } = {},
): Promise<{
  ok: boolean
  output: string
}> {
  const invocation = deps.invocation ?? resolveDshInvocation()
  const spawnFn = deps.spawnFn ?? spawn
  return await new Promise(resolve => {
    const child = spawnFn(
      invocation.command,
      [...invocation.prefix, 'plugin', '--profile', profile, 'add', `${PLUGIN_PACKAGE}@latest`],
      {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: invocation.shell,
        // No console window flashing over the TUI on Windows.
        windowsHide: true,
      },
    )
    const chunks: Buffer[] = []
    child.stdout?.on('data', chunk => chunks.push(Buffer.from(chunk)))
    child.stderr?.on('data', chunk => chunks.push(Buffer.from(chunk)))
    child.on('error', error => {
      resolve({ ok: false, output: error instanceof Error ? error.message : String(error) })
    })
    child.on('close', code => {
      const output = Buffer.concat(chunks).toString('utf8').trim()
      resolve({ ok: code === 0, output })
    })
  })
}
