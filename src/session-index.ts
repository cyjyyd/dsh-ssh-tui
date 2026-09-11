/**
 * Disk cache of picker labels so listing history does not inspect every
 * session.jsonl.zstd on each launch. Invalidated by file mtime/size.
 */

import { resolveDshHome } from './display-sock.js'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { statSync } from 'node:fs'
import { persistenceLocate } from './dsh-compat.js'

/** One cached picker row for a stored session. */
export interface SessionIndexEntry {
  id: string
  label: string
  updatedAt: number
  cwd: string
  hasUserInput: boolean
  hasReply: boolean
  unreadable?: boolean
  mtimeMs: number
  size: number
}

interface SessionIndexFile {
  version: number
  entries: Record<string, SessionIndexEntry>
}

// 2: `hasUserInput` now counts plugin-authored user messages too, so entries
// written by version 1 would keep those sessions hidden (and, before the blank
// rule changed, deletable).
const INDEX_VERSION = 2

/** First page of recent sessions inspected after the header sketch paints. */
export const PICKER_PRIORITY_COUNT = 9

export function sessionIndexPath(dshHome = resolveDshHome()): string {
  return join(dshHome, 'tui-session-index.json')
}

/** Artifact fingerprint used as the cache key. Missing files return zeros. */
export function sessionArtifactStat(
  persistence: object,
  meta: object,
): { mtimeMs: number; size: number } {
  try {
    const location = persistenceLocate(persistence, meta)
    if (location?.path === undefined || location.path === '') return { mtimeMs: 0, size: 0 }
    const info = statSync(location.path)
    return { mtimeMs: Math.round(info.mtimeMs), size: info.size }
  } catch {
    return { mtimeMs: 0, size: 0 }
  }
}

export function indexEntryMatchesStat(
  entry: SessionIndexEntry | undefined,
  stat: { mtimeMs: number; size: number },
): boolean {
  if (entry === undefined) return false
  return entry.mtimeMs === stat.mtimeMs && entry.size === stat.size && entry.id !== ''
}

export async function loadSessionIndex(
  path: string,
): Promise<Map<string, SessionIndexEntry>> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as SessionIndexFile
    if (parsed.version !== INDEX_VERSION || parsed.entries === null || typeof parsed.entries !== 'object') {
      return new Map()
    }
    const map = new Map<string, SessionIndexEntry>()
    for (const [id, entry] of Object.entries(parsed.entries)) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.id !== 'string' || entry.id === '') continue
      map.set(id, entry)
    }
    return map
  } catch {
    return new Map()
  }
}

export async function saveSessionIndex(
  path: string,
  entries: ReadonlyMap<string, SessionIndexEntry>,
): Promise<void> {
  const payload: SessionIndexFile = {
    version: INDEX_VERSION,
    entries: Object.fromEntries(entries),
  }
  const body = `${JSON.stringify(payload)}\n`
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
  } catch {
    try { await writeFile(path, body, { encoding: 'utf8', mode: 0o600 }) } catch { /* best-effort */ }
  }
}

/** Drop ids that are no longer in the store so the file cannot grow forever. */
export function pruneSessionIndex(
  entries: Map<string, SessionIndexEntry>,
  keepIds: ReadonlySet<string>,
): void {
  for (const id of [...entries.keys()]) {
    if (!keepIds.has(id)) entries.delete(id)
  }
}
