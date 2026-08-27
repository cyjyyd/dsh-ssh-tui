/**
 * Best-effort npm latest check. Never auto-upgrades; failures stay quiet.
 */
const NPM_REGISTRY = 'https://registry.npmjs.org/dsh-ssh-tui/latest'
const CHECK_TIMEOUT_MS = 4000

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

export function formatUpdateNotice(current: string, latest: string): string {
  return `发现新版本 dsh-ssh-tui ${latest}（当前 ${current}）。更新：dsh plugin --profile tui add dsh-ssh-tui`
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

export async function checkForPluginUpdate(current: string): Promise<string | undefined> {
  if (process.env.DSH_TUI_NO_UPDATE_CHECK === '1' || process.env.DSH_TUI_NO_UPDATE_CHECK === 'true') {
    return undefined
  }
  const latest = await fetchLatestNpmVersion()
  if (latest === undefined) return undefined
  if (compareSemver(latest, current) <= 0) return undefined
  return formatUpdateNotice(current, latest)
}
