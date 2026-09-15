/**
 * Friendly display names for background jobs.
 *
 * `job_*` cards otherwise read as the raw tool vocabulary (`job_output`,
 * `job_id: bash-1`), which is both untranslated and hard to talk about out
 * loud. Each job id instead gets a two-word alias — "蔚蓝水獭", "azure otter" —
 * derived from the id itself rather than from a random draw, so the same job
 * keeps one name across its call card, its result card, and every later
 * `job_output` / `job_kill` mention. The model-facing id stays authoritative;
 * the alias is presentation only.
 *
 * @module dsh-ssh-tui/job-label
 */

import { t } from './i18n/index.js'

/** FNV-1a over the job id: stable, dependency-free, and well spread for short ids. */
function hashJobId(id: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * One stable alias for a background job, or `undefined` when the id is empty
 * or the locale carries no vocabulary.
 * @param jobId - the native job id (`bash-1`, `pwsh-2`, …).
 * @returns the locale-formatted alias, e.g. `蔚蓝水獭` / `azure otter`.
 */
export function jobAlias(jobId: string): string | undefined {
  const id = jobId.trim()
  if (id === '') return undefined
  const adjectives = t('jobAlias.adjectives').split(',').filter(word => word !== '')
  const animals = t('jobAlias.animals').split(',').filter(word => word !== '')
  if (adjectives.length === 0 || animals.length === 0) return undefined
  const hash = hashJobId(id)
  const adjective = adjectives[hash % adjectives.length]
  const animal = animals[Math.floor(hash / adjectives.length) % animals.length]
  if (adjective === undefined || animal === undefined) return undefined
  return t('jobAlias.pattern', { adjective, animal })
}
