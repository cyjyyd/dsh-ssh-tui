#!/usr/bin/env node
/**
 * Accumulate a popularity baseline for this repository over time.
 *
 * GitHub serves only 14 days of traffic and npm aggregates a day a day or two
 * after the fact, so one look can say what happened this fortnight but not
 * whether the project is growing, and a release-day spike is indistinguishable
 * from a new floor. This script stores one raw snapshot per run in a JSONL
 * file, merges every snapshot's daily series into a single continuous
 * timeline (the newest snapshot wins for a day it also covers, because traffic
 * numbers settle after their first report), and prints that timeline. One run a
 * week keeps the 14-day windows overlapping, so no day is ever lost.
 *
 * The store lives outside the repo by default (`$DSH_HOME/heat/samples.jsonl`):
 * clone and referrer counts are owner-visible numbers, not something to publish
 * by accident. `--store` puts it anywhere else.
 *
 * Usage:
 *   node scripts/heat-report.mjs                  # collect, append, print
 *   node scripts/heat-report.mjs --report         # print the store, no network
 *   node scripts/heat-report.mjs --json           # the merged model as JSON
 *   node scripts/heat-report.mjs --md --days 14   # markdown, last two weeks
 *   node scripts/heat-report.mjs --store /tmp/heat.jsonl
 *
 * Traffic needs a token with `Administration: read`; it is read from
 * `$GITHUB_TOKEN` / `$GH_TOKEN`, else `<config>/dsh-publish/github.token`,
 * else the `git-credentials` store next to it. It is never printed and never
 * written into the store.
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const REPO = 'cyjyyd/dsh-ssh-tui'
export const PACKAGE_NAME = 'dsh-ssh-tui'
export const STORE_VERSION = 1

const GITHUB_API = 'https://api.github.com'
const NPM_REGISTRY = 'https://registry.npmjs.org'
const NPM_API = 'https://api.npmjs.org'
const DSHFIND_PAGE = `https://dshfind.com/zh/plugins/${REPO}`
const DSHFIND_BADGE = `https://dshfind.com/api/badge/${REPO}`
/** GitHub's own maximum: older days cannot be recovered, only sampled. */
const TRAFFIC_WINDOW_DAYS = 14
/** Wide enough that a skipped week still leaves no hole in the npm series. */
const NPM_WINDOW_DAYS = 30
/** npm keeps reporting 0 for the last day or two before it aggregates them. */
const NPM_SETTLE_DAYS = 2
/** The npm API has returned download counts in the 1e10 range for a day; nothing here is that big. */
const MAX_COUNT = 1_000_000_000
const REQUEST_TIMEOUT_MS = 20_000
const SPARK = '▁▂▃▄▅▆▇█'

/** `YYYY-MM-DD` for a Date, in UTC: every API below reports days in UTC. */
export function utcDay(date) {
  return new Date(date).toISOString().slice(0, 10)
}

/** The `YYYY-MM-DD` head of an API timestamp, or null when it is not a date. */
export function apiDay(timestamp) {
  const match = /^(\d{4}-\d{2}-\d{2})/u.exec(String(timestamp ?? ''))
  return match === null ? null : match[1]
}

/** A day shifted by whole days, staying in UTC. */
export function shiftDay(day, delta) {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + delta)
  return utcDay(date)
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function dayDistance(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * A count the store can trust. Everything here is a non-negative integer far
 * below `MAX_COUNT`; anything else (a string, a float, a missing field, the
 * occasionally absurd npm value) becomes null rather than a fake data point.
 */
export function saneCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? value : null
}

/** Strip anything token-shaped out of a message that may end up on screen or on disk. */
export function redact(text) {
  return String(text)
    .replace(/\b(?:github_pat|gh[pousr])_[A-Za-z0-9_]+/gu, '<token>')
    .replace(/(authorization["']?\s*[:=]\s*)\S+/giu, '$1<token>')
}

/** A line's token from a git credential store (`https://user:token@host`). */
export function tokenFromGitCredentials(text) {
  const match = /https:\/\/([^:@/\s]+):([^@\s]+)@/u.exec(String(text))
  return match === null ? null : { user: match[1], token: match[2] }
}

/** The first token we can find, and where it came from (the source, never the token). */
export function discoverToken({ tokenFile, env = process.env, home = homedir() } = {}) {
  if (tokenFile !== undefined) {
    const token = readFileSync(tokenFile, 'utf8').trim()
    if (token === '') throw new Error(`${tokenFile} is empty`)
    return { token, source: tokenFile }
  }
  const fromEnv = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return { token: fromEnv, source: 'the environment' }
  const dir = join(env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), 'dsh-publish')
  const file = join(dir, 'github.token')
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim()
    if (token !== '') return { token, source: file }
  }
  const credentials = join(dir, 'git-credentials')
  if (existsSync(credentials)) {
    const parsed = tokenFromGitCredentials(readFileSync(credentials, 'utf8'))
    if (parsed !== null) return { token: parsed.token, source: `${credentials} (user ${parsed.user})` }
  }
  return { token: undefined, source: undefined }
}

/** `$DSH_HOME` the way dsh resolves it (a blank value counts as unset). */
export function defaultStorePath(env = process.env, home = homedir()) {
  const dshHome = resolve(env.DSH_HOME?.trim() || join(home, '.dsh'))
  return join(dshHome, 'heat', 'samples.jsonl')
}

/** `版本 0.6.3` on dshfind's page, in either language. */
export function parseDshfindVersion(html) {
  const match = /(?:版本|Version)\s*v?(\d[0-9A-Za-z.+-]*)/u.exec(String(html))
  return match === null ? null : match[1]
}

/** `dshfind: dsh-ssh-tui — ★ 1` in dshfind's badge. */
export function parseDshfindStars(svg) {
  const match = /★\s*([0-9][0-9,]*)/u.exec(String(svg))
  return match === null ? null : Number(match[1].replaceAll(',', ''))
}

/**
 * The daily series every snapshot contributes to, merged into one row per day.
 * Snapshots are applied oldest first, so a day covered by several samples ends
 * up with the numbers from the newest one.
 */
export function mergeDailySeries(snapshots) {
  const series = new Map()
  const rowFor = day => {
    let row = series.get(day)
    if (row === undefined) {
      row = { day }
      series.set(day, row)
    }
    return row
  }
  for (const snapshot of sortSnapshots(snapshots)) {
    for (const entry of asArray(snapshot?.github?.views?.days)) {
      const row = rowFor(entry.date)
      if (saneCount(entry.count) !== null) row.views = entry.count
      if (saneCount(entry.uniques) !== null) row.uniques = entry.uniques
    }
    for (const entry of asArray(snapshot?.github?.clones?.days)) {
      const row = rowFor(entry.date)
      if (saneCount(entry.count) !== null) row.clones = entry.count
      if (saneCount(entry.uniques) !== null) row.cloneUniques = entry.uniques
    }
    for (const entry of asArray(snapshot?.npm?.days)) {
      const row = rowFor(entry.date)
      if (saneCount(entry.downloads) !== null) row.npm = entry.downloads
    }
  }
  return [...series.values()].sort((left, right) => left.day.localeCompare(right.day))
}

/** Snapshot records oldest first, ignoring anything that is not one of ours. */
export function sortSnapshots(snapshots) {
  return asArray(snapshots)
    .filter(snapshot => snapshot !== null && typeof snapshot === 'object' && snapshot.v === STORE_VERSION)
    .slice()
    .sort((left, right) => String(left.at).localeCompare(String(right.at)))
}

/**
 * Totals over an inclusive day range. Only `views` and `clones` are summed;
 * daily `uniques` are not additive (the same visitor is new on each day), so a
 * window's unique count has to come from the API's own window, not from here.
 */
export function windowTotals(series, from, to) {
  const rows = asArray(series).filter(row => row.day >= from && row.day <= to)
  const sum = key => rows.reduce((total, row) => total + (saneCount(row[key]) ?? 0), 0)
  return {
    from,
    to,
    days: dayDistance(from, to) + 1,
    views: sum('views'),
    clones: sum('clones'),
    viewsDays: rows.filter(row => row.views !== undefined).length,
    npm: sum('npm'),
    npmDays: rows.filter(row => row.npm !== undefined).length,
  }
}

/** Percent change, or null when there is no baseline to compare against. */
export function percentChange(previous, current) {
  if (!Number.isFinite(previous) || !Number.isFinite(current) || previous === 0) return null
  return Math.round(((current - previous) / previous) * 100)
}

/** One bar per value, highest value at full height; a gap is a dot. */
export function sparkline(values) {
  const known = asArray(values).filter(value => typeof value === 'number')
  const max = Math.max(1, ...known)
  return asArray(values)
    .map(value => (typeof value === 'number' ? SPARK[Math.min(SPARK.length - 1, Math.round((value / max) * (SPARK.length - 1)))] : '·'))
    .join('')
}

/** Release tags by the UTC day they were published, oldest first. */
export function releaseDayMap(releases) {
  const map = {}
  for (const release of asArray(releases)) {
    if (release?.draft === true) continue
    const day = apiDay(release?.publishedAt)
    const tag = typeof release?.tag === 'string' ? release.tag : ''
    if (day === null || tag === '') continue
    map[day] = [...(map[day] ?? []), tag]
  }
  return map
}

/** Right-align numeric columns; the last column is free text. `pipes` makes it a markdown table. */
export function renderTable(headers, rows, align = headers.map(() => 'l'), pipes = false) {
  const cells = [headers, ...rows]
  const widths = headers.map((_, column) => Math.max(...cells.map(row => String(row[column] ?? '').length)))
  const format = row =>
    row.map((cell, column) => {
      const text = String(cell ?? '')
      const padding = ' '.repeat(Math.max(0, widths[column] - text.length))
      return align[column] === 'r' ? padding + text : text + padding
    })
  if (!pipes) return cells.map(format).map(row => row.join('  ').trimEnd()).join('\n')
  const line = row => `| ${row.join(' | ')} |`
  const rule = headers.map((_, column) => (align[column] === 'r' ? '---:' : '---'))
  return [line(format(headers)), line(rule), ...rows.map(row => line(format(row)))].join('\n')
}

function asArray(value) {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

/** Read the JSONL store, tolerating a torn line from an interrupted append. */
export function readStore(path) {
  if (!existsSync(path)) return { snapshots: [], skipped: 0, missing: true }
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    return { snapshots: [], skipped: 0, unreadable: redact(error instanceof Error ? error.message : String(error)) }
  }
  const snapshots = []
  let skipped = 0
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      snapshots.push(JSON.parse(line))
    } catch {
      skipped += 1
    }
  }
  return { snapshots: sortSnapshots(snapshots), skipped }
}

function appendSnapshot(path, snapshot) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  appendFileSync(path, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 })
}

async function fetchText(url, { token, accept = 'text/plain', retries = 1 } = {}) {
  let failure = 'no response'
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const headers = { accept, 'user-agent': 'dsh-ssh-tui-heat-report' }
      // Only GitHub gets the token: a redirect target must never see it.
      if (token !== undefined && token !== '' && url.startsWith(GITHUB_API)) headers.authorization = `Bearer ${token}`
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      const text = await response.text()
      if (response.ok) return { ok: true, status: response.status, text }
      const needs = response.headers.get('x-accepted-github-permissions')
      failure = `HTTP ${response.status}${needs === null ? '' : ` (token needs ${needs})`}`
      if (response.status < 500) return { ok: false, status: response.status, error: failure }
    } catch (error) {
      failure = redact(error instanceof Error ? error.message : String(error))
    }
    if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 1500))
  }
  return { ok: false, error: failure }
}

async function fetchJson(url, options = {}) {
  const result = await fetchText(url, { accept: 'application/json', ...options })
  if (!result.ok) return { ok: false, error: result.error }
  try {
    return { ok: true, json: JSON.parse(result.text) }
  } catch {
    return { ok: false, error: 'response is not JSON' }
  }
}

/** The day entries of a traffic payload (`views` or `clones`). */
function trafficDays(entries) {
  return asArray(entries)
    .map(entry => ({ date: apiDay(entry?.timestamp), count: saneCount(entry?.count), uniques: saneCount(entry?.uniques) }))
    .filter(entry => entry.date !== null)
}

async function collectGitHub(token, errors) {
  const call = async (key, path, accept) => {
    const result = await fetchJson(`${GITHUB_API}${path}`, { token, ...(accept === undefined ? {} : { accept }) })
    if (!result.ok) {
      errors.push(`github ${key}: ${result.error}`)
      return undefined
    }
    return result.json
  }
  const github = {}
  const repo = await call('repo', `/repos/${REPO}`)
  if (repo !== undefined) {
    github.repo = {
      stars: saneCount(repo.stargazers_count),
      forks: saneCount(repo.forks_count),
      watchers: saneCount(repo.subscribers_count),
      openIssues: saneCount(repo.open_issues_count),
      createdAt: apiDay(repo.created_at),
      pushedAt: repo.pushed_at ?? null,
    }
  }
  const views = await call('views', `/repos/${REPO}/traffic/views?per=day`)
  if (views !== undefined) {
    github.views = { count: saneCount(views.count), uniques: saneCount(views.uniques), days: trafficDays(views.views) }
  }
  const clones = await call('clones', `/repos/${REPO}/traffic/clones?per=day`)
  if (clones !== undefined) {
    github.clones = { count: saneCount(clones.count), uniques: saneCount(clones.uniques), days: trafficDays(clones.clones) }
  }
  const referrers = await call('referrers', `/repos/${REPO}/traffic/popular/referrers`)
  if (referrers !== undefined) {
    github.referrers = asArray(referrers).map(entry => ({
      referrer: String(entry?.referrer ?? ''),
      count: saneCount(entry?.count),
      uniques: saneCount(entry?.uniques),
    }))
  }
  const paths = await call('paths', `/repos/${REPO}/traffic/popular/paths`)
  if (paths !== undefined) {
    github.paths = asArray(paths).map(entry => ({
      path: String(entry?.path ?? ''),
      title: String(entry?.title ?? ''),
      count: saneCount(entry?.count),
      uniques: saneCount(entry?.uniques),
    }))
  }
  const releases = await call('releases', `/repos/${REPO}/releases?per_page=100`)
  if (releases !== undefined) {
    github.releases = asArray(releases).map(entry => ({
      tag: String(entry?.tag_name ?? ''),
      publishedAt: entry?.published_at ?? null,
      prerelease: entry?.prerelease === true,
      draft: entry?.draft === true,
      downloads: asArray(entry?.assets).reduce((total, asset) => total + (saneCount(asset?.download_count) ?? 0), 0),
    }))
  }
  return Object.keys(github).length === 0 ? null : github
}

async function collectNpm(errors) {
  const call = async (key, url, accept) => {
    const result = await fetchJson(url, accept === undefined ? {} : { accept })
    if (!result.ok) {
      errors.push(`npm ${key}: ${result.error}`)
      return undefined
    }
    return result.json
  }
  const today = utcDay(new Date())
  const from = shiftDay(today, -(NPM_WINDOW_DAYS - 1))
  const npm = {}
  const distTags = await call('dist-tags', `${NPM_REGISTRY}/-/package/${PACKAGE_NAME}/dist-tags`)
  if (distTags !== undefined && typeof distTags === 'object') npm.distTags = distTags
  const week = await call('week', `${NPM_API}/downloads/point/last-week/${PACKAGE_NAME}`)
  if (week !== undefined) {
    npm.week = { from: apiDay(week.start), to: apiDay(week.end), total: saneCount(week.downloads) }
  }
  const versions = await call('versions', `${NPM_API}/versions/${PACKAGE_NAME}/last-week`)
  if (versions !== undefined && typeof versions.downloads === 'object' && versions.downloads !== null) {
    npm.versions = Object.fromEntries(
      Object.entries(versions.downloads)
        .map(([version, downloads]) => [version, saneCount(downloads)])
        .filter(([, downloads]) => downloads !== null),
    )
  }
  const range = await call('days', `${NPM_API}/downloads/range/${from}:${today}/${PACKAGE_NAME}`)
  if (range !== undefined) {
    npm.days = asArray(range.downloads)
      .map(entry => ({ date: apiDay(entry?.day), downloads: saneCount(entry?.downloads) }))
      .filter(entry => entry.date !== null && entry.downloads !== null)
  }
  // Publish times live only in the full document; the abbreviated one has no `time`.
  const registry = await call('registry', `${NPM_REGISTRY}/${PACKAGE_NAME}`)
  if (registry !== undefined && typeof registry.time === 'object' && registry.time !== null) {
    const latest = npm.distTags?.latest
    npm.latestPublishedAt = latest === undefined ? null : registry.time[latest] ?? null
    npm.modifiedAt = registry.time.modified ?? null
  }
  return Object.keys(npm).length === 0 ? null : npm
}

async function collectDirectory(errors) {
  const directory = {}
  const badge = await fetchText(DSHFIND_BADGE)
  if (badge.ok) directory.stars = parseDshfindStars(badge.text)
  else errors.push(`dshfind badge (optional): ${badge.error}`)
  const page = await fetchText(DSHFIND_PAGE)
  if (page.ok) directory.version = parseDshfindVersion(page.text)
  else errors.push(`dshfind page (optional): ${page.error}`)
  return Object.keys(directory).length === 0 ? null : { dshfind: directory }
}

/** Commits sitting on the local branch since the newest tag, when run inside the repo. */
function unreleasedCommits() {
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const count = Number(execFileSync('git', ['rev-list', '--count', `${tag}..HEAD`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
    return Number.isSafeInteger(count) ? { tag, count } : null
  } catch {
    return null
  }
}

function collectWarnings({ snapshots, series, today, lastDay, skipped }) {
  const warnings = []
  if (skipped > 0) warnings.push(`${skipped} store line(s) could not be parsed (torn append?)`)
  if (snapshots.length === 0) {
    warnings.push('the store is empty — nothing to report yet')
    return warnings
  }
  const last = snapshots.at(-1)
  const age = dayDistance(apiDay(last.at) ?? today, today)
  if (age > 7) {
    warnings.push(`last sample is ${age} days old: run weekly so GitHub's ${TRAFFIC_WINDOW_DAYS}-day windows keep overlapping`)
  }
  if (series.length > 0) {
    const seen = new Set(series.map(row => row.day))
    const missing = []
    for (let day = shiftDay(lastDay, -Math.min(59, dayDistance(series[0].day, lastDay))); day <= lastDay; day = shiftDay(day, 1)) {
      if (!seen.has(day)) missing.push(day)
    }
    if (missing.length > 0) {
      warnings.push(`no data for ${missing.join(', ')} — days missed for more than ${TRAFFIC_WINDOW_DAYS} days cannot be recovered`)
    }
  }
  const errors = asArray(last.errors)
  if (errors.length > 0) warnings.push(`last sample reported ${errors.length} failed source(s): ${errors.join(' · ')}`)
  if (!series.some(row => row.npm !== undefined)) warnings.push('no npm daily numbers in the store')
  return warnings
}

/**
 * Everything the renderers need, from the store alone: the merged daily series,
 * the trailing windows, and the newest snapshot's API-reported totals (which
 * are the only place a window's *unique* visitor count exists).
 */
export function buildReportModel({ snapshots, now = new Date(), days = 28, storePath = '', skipped = 0 }) {
  const ordered = sortSnapshots(snapshots)
  const series = mergeDailySeries(ordered)
  const today = utcDay(now)
  const lastDay = series.at(-1)?.day ?? today
  const newest = pick => {
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const value = pick(ordered[index])
      if (value !== undefined && value !== null) return value
    }
    return undefined
  }
  const last = ordered.at(-1)
  // GitHub's window ends yesterday while npm's runs to today, so anchor both
  // weekly windows on the last day that actually has traffic data: comparing a
  // six-day window with a seven-day one would read as a change that is not one.
  const lastTrafficDay = series.findLast(row => row.views !== undefined)?.day ?? lastDay
  return {
    generatedAt: new Date().toISOString(),
    repo: REPO,
    package: PACKAGE_NAME,
    store: { path: storePath, samples: ordered.length, skipped, size: series.length },
    span: { from: series.at(0)?.day ?? null, to: series.at(-1)?.day ?? null },
    capturedAt: last?.at ?? null,
    warnings: collectWarnings({ snapshots: ordered, series, today, lastDay, skipped }),
    rows: days > 0 ? series.filter(row => row.day >= shiftDay(today, -(days - 1))) : series,
    releases: releaseDayMap(newest(snapshot => snapshot.github?.releases)),
    trafficThrough: lastTrafficDay,
    trailing: windowTotals(series, shiftDay(lastTrafficDay, -6), lastTrafficDay),
    previous: windowTotals(series, shiftDay(lastTrafficDay, -13), shiftDay(lastTrafficDay, -7)),
    window: {
      capturedAt: last?.at ?? null,
      views: newest(snapshot => snapshot.github?.views?.count),
      uniqueVisitors: newest(snapshot => snapshot.github?.views?.uniques),
      clones: newest(snapshot => snapshot.github?.clones?.count),
      uniqueCloners: newest(snapshot => snapshot.github?.clones?.uniques),
      referrers: newest(snapshot => snapshot.github?.referrers),
      paths: newest(snapshot => snapshot.github?.paths),
      repo: newest(snapshot => snapshot.github?.repo),
    },
    npm: {
      distTags: newest(snapshot => snapshot.npm?.distTags),
      latestPublishedAt: newest(snapshot => snapshot.npm?.latestPublishedAt),
      week: newest(snapshot => snapshot.npm?.week),
      versions: newest(snapshot => snapshot.npm?.versions),
      days: series.filter(row => row.npm !== undefined).length,
    },
    directory: newest(snapshot => snapshot.directory?.dshfind),
  }
}

function deltaText(previous, current) {
  const change = percentChange(previous, current)
  if (change === null) return 'n/a'
  return `${change >= 0 ? '+' : ''}${change}%`
}

function dailyRows(model) {
  const today = apiDay(model.generatedAt)
  return model.rows.map(row => {
    const notes = [...(model.releases[row.day] ?? [])]
    const settling = today !== null && dayDistance(row.day, today) < NPM_SETTLE_DAYS
    // npm answers 0 for a day it has not aggregated yet — say so rather than
    // letting a pending day read as a day with no downloads.
    if (row.npm === undefined || (row.npm === 0 && settling)) {
      notes.push(settling ? 'npm pending' : 'npm missing')
    }
    const numeric = value => (value === undefined ? '-' : String(value))
    return [row.day, numeric(row.views), numeric(row.uniques), numeric(row.clones), numeric(row.cloneUniques), numeric(row.npm), notes.join(', ')]
  })
}

const DAILY_HEADERS = ['date', 'views', 'uniq', 'clones', 'cuniq', 'npm', 'notes']
const DAILY_ALIGN = ['l', 'r', 'r', 'r', 'r', 'r', 'l']

function windowLine(label, totals) {
  const coverage = totals.viewsDays === totals.days ? `${totals.days}/${totals.days} days` : `${totals.viewsDays}/${totals.days} days with data`
  return `${label}  ${totals.from} → ${totals.to}   views ${totals.views} · clones ${totals.clones}   (${coverage})`
}

function versionLine(npm) {
  const versions = Object.entries(npm.versions ?? {})
  if (versions.length === 0) return null
  versions.sort((left, right) => right[1] - left[1])
  const latest = npm.distTags?.latest
  const parts = versions.slice(0, 6).map(([version, downloads]) => `${version} ${downloads}`)
  if (latest !== undefined && !parts.some(part => part.startsWith(`${latest} `))) {
    const entry = versions.find(([version]) => version === latest)
    if (entry !== undefined) parts.push(`${entry[0]} ${entry[1]} (latest)`)
  }
  return parts.join(' · ')
}

function headerLines(model) {
  const lines = [`heat baseline — ${model.repo}`, `store ${model.store.path}`]
  lines.push(
    `${model.store.samples} sample${model.store.samples === 1 ? '' : 's'} · ${model.span.from ?? '-'} → ${model.span.to ?? '-'} · last sample ${model.capturedAt ?? '-'}`,
  )
  const local = unreleasedCommits()
  if (local !== null) lines.push(`local: ${local.count} commit${local.count === 1 ? '' : 's'} since ${local.tag}${local.count === 0 ? ' (nothing unreleased)' : ''}`)
  if (model.warnings.length > 0) lines.push(...model.warnings.map(warning => `warning: ${warning}`))
  return lines
}

/** The terminal report: one screen of numbers, with the day rows in the middle. */
export function renderText(model) {
  const lines = [...headerLines(model), '']
  lines.push(renderTable(DAILY_HEADERS, dailyRows(model), DAILY_ALIGN))
  lines.push('')
  const from = model.rows.at(0)?.day ?? ''
  const to = model.rows.at(-1)?.day ?? ''
  lines.push(`views/day  ${from} → ${to}  ${sparkline(model.rows.map(row => row.views))}`)
  lines.push(`clones/day ${from} → ${to}  ${sparkline(model.rows.map(row => row.clones))}`)
  lines.push('')
  lines.push(windowLine('trailing 7d', model.trailing))
  lines.push(windowLine('previous 7d', model.previous))
  if (model.trailing.viewsDays > 0 && model.previous.viewsDays > 0) {
    lines.push(
      `change      views ${deltaText(model.previous.views, model.trailing.views)} · clones ${deltaText(model.previous.clones, model.trailing.clones)}`,
    )
  }
  lines.push('')
  if (model.window.views !== undefined) {
    lines.push(`14-day window (${model.window.capturedAt ?? '-'})`)
    lines.push(`  views ${model.window.views} (${model.window.uniqueVisitors} unique) · clones ${model.window.clones} (${model.window.uniqueCloners} unique)`)
    const referrers = asArray(model.window.referrers).slice(0, 6).map(entry => `${entry.referrer} ${entry.count}`)
    if (referrers.length > 0) lines.push(`  referrers  ${referrers.join(' · ')}`)
    const paths = asArray(model.window.paths).slice(0, 6).map(entry => `${entry.path} ${entry.count}`)
    if (paths.length > 0) lines.push(`  paths      ${paths.join(' · ')}`)
    const repo = model.window.repo
    if (repo !== undefined && repo !== null) {
      lines.push(`  repo       ★ ${repo.stars} · forks ${repo.forks} · watchers ${repo.watchers} · open issues ${repo.openIssues} · created ${repo.createdAt}`)
    }
  }
  if (model.npm.week !== undefined) {
    const tags = Object.entries(model.npm.distTags ?? {}).map(([tag, version]) => `${tag} ${version}`).join(' · ')
    lines.push('')
    lines.push(`npm (per-day numbers settle ~${NPM_SETTLE_DAYS} days late; mirrors inflate old versions)`)
    lines.push(`  last week  ${model.npm.week.from} → ${model.npm.week.to}   ${model.npm.week.total} downloads`)
    if (tags !== '') lines.push(`  dist-tags  ${tags}${model.npm.latestPublishedAt === undefined || model.npm.latestPublishedAt === null ? '' : ` · latest published ${model.npm.latestPublishedAt}`}`)
    const versions = versionLine(model.npm)
    if (versions !== null) lines.push(`  versions   ${versions}`)
  }
  if (model.directory !== undefined && model.directory !== null) {
    const stale = model.npm.distTags?.latest !== undefined && model.directory.version !== model.npm.distTags.latest
    lines.push(
      `  dshfind    ${model.directory.version ?? '?'} · ★ ${model.directory.stars ?? '?'}${stale ? `  (registry latest is ${model.npm.distTags.latest})` : ''}`,
    )
  }
  return lines.join('\n')
}

/** The same report as markdown, for release notes or an issue comment. */
export function renderMarkdown(model) {
  const lines = [`# Heat baseline — ${apiDay(model.generatedAt)}`, '']
  lines.push(...headerLines(model).slice(1).map(line => `- ${line}`))
  lines.push('')
  lines.push(renderTable(DAILY_HEADERS, dailyRows(model), DAILY_ALIGN, true))
  lines.push('')
  lines.push(`- ${windowLine('trailing 7d', model.trailing)}`)
  lines.push(`- ${windowLine('previous 7d', model.previous)}`)
  if (model.trailing.viewsDays > 0 && model.previous.viewsDays > 0) {
    lines.push(`- change: views ${deltaText(model.previous.views, model.trailing.views)} · clones ${deltaText(model.previous.clones, model.trailing.clones)}`)
  }
  if (model.window.views !== undefined) {
    lines.push(
      `- 14-day window (${model.window.capturedAt ?? '-'}): views ${model.window.views} (${model.window.uniqueVisitors} unique) · clones ${model.window.clones} (${model.window.uniqueCloners} unique)`,
    )
  }
  if (model.npm.week !== undefined) {
    lines.push(`- npm last week (${model.npm.week.from} → ${model.npm.week.to}): ${model.npm.week.total} downloads`)
    const versions = versionLine(model.npm)
    if (versions !== null) lines.push(`- npm versions: ${versions}`)
  }
  if (model.directory !== undefined && model.directory !== null) {
    lines.push(`- dshfind: ${model.directory.version ?? '?'} · ★ ${model.directory.stars ?? '?'}`)
  }
  return lines.join('\n')
}

const USAGE = `usage: node scripts/heat-report.mjs [options]

  (no options)        collect a snapshot, append it to the store, print the report
  --report            print the store only; no network, no write
  --json              print the merged model as JSON
  --md                print the report as markdown
  --days N            days in the daily table (default 28, 0 = everything)
  --store PATH        store file (default $DSH_HOME/heat/samples.jsonl)
  --token-file PATH   read the GitHub token from PATH
  --no-directory      skip the dshfind directory lookup
  --help              this text`

function parseArgs(argv) {
  const options = { days: 28, directory: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--report') options.report = true
    else if (arg === '--json') options.json = true
    else if (arg === '--md') options.md = true
    else if (arg === '--no-directory') options.directory = false
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--days') options.days = Number(argv[++index])
    else if (arg === '--store') options.store = argv[++index]
    else if (arg === '--token-file') options.tokenFile = argv[++index]
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!Number.isSafeInteger(options.days) || options.days < 0) throw new Error('--days takes a non-negative integer')
  return options
}

function output(model, options) {
  if (options.json) console.log(JSON.stringify(model, null, 2))
  else if (options.md) console.log(renderMarkdown(model))
  else console.log(renderText(model))
}

async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(redact(error.message))
    console.error(USAGE)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const store = options.store ?? defaultStorePath()
  if (!options.report) {
    const errors = []
    let token
    let source
    try {
      ;({ token, source } = discoverToken({ tokenFile: options.tokenFile }))
    } catch (error) {
      errors.push(`token: ${redact(error.message)}`)
    }
    if (token === undefined && options.tokenFile === undefined) {
      errors.push('no GitHub token found (traffic endpoints need one): set $GITHUB_TOKEN or create ~/.config/dsh-publish/github.token')
    }
    const [github, npm] = [await collectGitHub(token, errors), await collectNpm(errors)]
    const directory = options.directory ? await collectDirectory(errors) : null
    if (github === null && npm === null) {
      console.error(`nothing collected; store left untouched (${store})`)
      for (const error of errors) console.error(`  ${error}`)
      return 1
    }
    appendSnapshot(store, {
      v: STORE_VERSION,
      at: new Date().toISOString(),
      repo: REPO,
      package: PACKAGE_NAME,
      github,
      npm,
      directory,
      errors,
    })
    console.log(
      `snapshot appended: github ${github === null ? 'FAILED' : 'ok'} · npm ${npm === null ? 'FAILED' : 'ok'} · dshfind ${directory === null ? 'skipped' : 'ok'} · token ${source ?? 'none'}`,
    )
  }
  const state = readStore(store)
  if (state.missing) {
    console.error(`no store at ${store}: run without --report to collect the first sample`)
    return 1
  }
  if (state.unreadable !== undefined) {
    console.error(`cannot read the store at ${store}: ${state.unreadable}`)
    return 1
  }
  output(buildReportModel({ snapshots: state.snapshots, days: options.days, storePath: store, skipped: state.skipped }), options)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
