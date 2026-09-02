/**
 * Read and refresh SuperGrok / xAI OAuth tokens from disk.
 *
 * dsh-ssh-tui does not depend on dsh-llm-xai-oauth. Keep this file's wire
 * format identical to grok-bridge / that plugin: ~/.grok-bridge/auth.json
 * with access_token, refresh_token, expires_at.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { t } from './i18n/index.js'

export const SUPERGROK_AUTH_PATHS = [
  join(homedir(), '.grok-bridge', 'auth.json'),
  join(homedir(), '.grok', 'auth.json'),
] as const

export const SUPERGROK_REFRESH_SKEW_MS = 5 * 60 * 1000
const DEFAULT_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const DEFAULT_TOKEN_URL = 'https://auth.x.ai/oauth2/token'
const DEFAULT_LIFETIME_SECONDS = 3600

export interface SuperGrokStoredToken {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
  clientId: string | null
  path: string
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function expiresAtMs(record: Record<string, unknown>): number | null {
  const raw = record.expires_at ?? record.expiresAt
  if (typeof raw === 'string') return Date.parse(raw) || null
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw
  return null
}

export function parseSuperGrokAuthFile(raw: unknown, path: string): SuperGrokStoredToken | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const accessToken = stringField(record, 'access_token') ?? stringField(record, 'accessToken')
  if (accessToken === undefined) return undefined
  return {
    accessToken,
    refreshToken: stringField(record, 'refresh_token') ?? stringField(record, 'refreshToken') ?? null,
    expiresAt: expiresAtMs(record),
    clientId: stringField(record, 'oidc_client_id') ?? stringField(record, 'clientId') ?? null,
    path,
  }
}

export function superGrokTokenNeedsRefresh(
  token: SuperGrokStoredToken,
  now = Date.now(),
  skewMs = SUPERGROK_REFRESH_SKEW_MS,
): boolean {
  if (token.refreshToken === null) return false
  if (token.expiresAt === null) return false
  return token.expiresAt - now < skewMs
}

async function readTokenFile(path: string): Promise<SuperGrokStoredToken | undefined> {
  try {
    return parseSuperGrokAuthFile(JSON.parse(await readFile(path, 'utf8')) as unknown, path)
  } catch {
    return undefined
  }
}

export async function loadSuperGrokToken(paths: readonly string[] = SUPERGROK_AUTH_PATHS): Promise<SuperGrokStoredToken | undefined> {
  for (const path of paths) {
    const token = await readTokenFile(path)
    if (token !== undefined) return token
  }
  return undefined
}

async function postRefresh(refreshToken: string, clientId: string): Promise<{
  access_token: string
  refresh_token?: string
  expires_in?: number
}> {
  const response = await fetch(DEFAULT_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json() as Record<string, unknown>
  const access = stringField(body, 'access_token')
  if (!response.ok || access === undefined) {
    const error = stringField(body, 'error')
    const description = stringField(body, 'error_description')
    throw new Error(
      t('grok.refreshFail', {
        status: response.status,
        detail: error || description ? `：${[error, description].filter(Boolean).join(': ')}` : '',
      }),
    )
  }
  return {
    access_token: access,
    ...stringField(body, 'refresh_token') === undefined ? {} : { refresh_token: stringField(body, 'refresh_token') },
    ...typeof body.expires_in === 'number' ? { expires_in: body.expires_in } : {},
  }
}

export async function persistSuperGrokToken(
  path: string,
  tokenResponse: { access_token: string; refresh_token?: string; expires_in?: number },
  previousRefreshToken: string,
  now = Date.now(),
): Promise<SuperGrokStoredToken> {
  const record = {
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token ?? previousRefreshToken,
    expires_at: now + (tokenResponse.expires_in ?? DEFAULT_LIFETIME_SECONDS) * 1000,
    saved_at: new Date(now).toISOString(),
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  const stored = parseSuperGrokAuthFile(record, path)
  if (stored === undefined) throw new Error(t('grok.writeFail', { path }))
  return stored
}

export async function resolveFreshSuperGrokToken(options: {
  force?: boolean
  now?: number
  paths?: readonly string[]
} = {}): Promise<string | undefined> {
  const current = await loadSuperGrokToken(options.paths)
  if (current === undefined) return undefined
  const now = options.now ?? Date.now()
  if (options.force !== true && !superGrokTokenNeedsRefresh(current, now)) {
    return current.accessToken
  }
  if (current.refreshToken === null) {
    if (options.force === true || superGrokTokenNeedsRefresh({ ...current, refreshToken: 'x' }, now)) {
      throw new Error(t('grok.noRefresh'))
    }
    return current.accessToken
  }
  const next = await postRefresh(current.refreshToken, current.clientId ?? DEFAULT_CLIENT_ID)
  const saved = await persistSuperGrokToken(current.path, next, current.refreshToken, now)
  return saved.accessToken
}
