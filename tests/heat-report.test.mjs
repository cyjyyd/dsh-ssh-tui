import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  apiDay,
  buildReportModel,
  dayDistance,
  defaultStorePath,
  discoverToken,
  mergeDailySeries,
  parseDshfindStars,
  parseDshfindVersion,
  percentChange,
  readStore,
  redact,
  releaseDayMap,
  renderMarkdown,
  renderText,
  saneCount,
  shiftDay,
  sortSnapshots,
  sparkline,
  tokenFromGitCredentials,
  utcDay,
  windowTotals,
  STORE_VERSION,
} from '../scripts/heat-report.mjs'

/**
 * The popularity baseline store: it has to merge overlapping samples without
 * inventing days, keep the npm noise out of the headline numbers, and never
 * mistake "not aggregated yet" for "nobody downloaded".
 */

/** A snapshot with the shape the store writes, minimal but realistic. */
function snapshot({ at, views = [], clones = [], npm = [], releases = [], repo, referrers } = {}) {
  return {
    v: STORE_VERSION,
    at,
    repo: 'cyjyyd/dsh-ssh-tui',
    package: 'dsh-ssh-tui',
    github: {
      views: { count: views.reduce((total, entry) => total + entry.count, 0), uniques: 1, days: views },
      clones: { count: clones.reduce((total, entry) => total + entry.count, 0), uniques: 1, days: clones },
      releases,
      ...(repo === undefined ? {} : { repo }),
      ...(referrers === undefined ? {} : { referrers }),
    },
    npm: { days: npm },
    errors: [],
  }
}

test('a day covered by two samples keeps the newest numbers, and old days survive', () => {
  const older = snapshot({
    at: '2026-09-16T06:00:00.000Z',
    views: [{ date: '2026-09-14', count: 10, uniques: 5 }, { date: '2026-09-15', count: 12, uniques: 6 }],
  })
  const newer = snapshot({
    at: '2026-09-17T06:00:00.000Z',
    views: [{ date: '2026-09-15', count: 40, uniques: 20 }, { date: '2026-09-16', count: 39, uniques: 16 }],
  })
  const series = mergeDailySeries([newer, older])
  assert.deepEqual(series.map(row => row.day), ['2026-09-14', '2026-09-15', '2026-09-16'])
  assert.equal(series[1].views, 40)
  assert.equal(series[1].uniques, 20)
  assert.equal(series[0].views, 10)
})

test('a record from another store version, or not a record, is not our data', () => {
  const good = snapshot({ at: '2026-09-17T00:00:00.000Z' })
  assert.equal(sortSnapshots([good, { ...good, v: 2 }, null, 'nope', { at: 'x' }]).length, 1)
  assert.deepEqual(mergeDailySeries([{ ...good, v: 2 }, null]), [])
})

test('a count no API could have returned is dropped, not stored', () => {
  assert.equal(saneCount(0), 0)
  assert.equal(saneCount(2750), 2750)
  assert.equal(saneCount(40_704_191_058), null)
  assert.equal(saneCount(-1), null)
  assert.equal(saneCount(1.5), null)
  assert.equal(saneCount('560'), null)
  assert.equal(saneCount(undefined), null)
  const series = mergeDailySeries([
    snapshot({ at: '2026-09-17T00:00:00.000Z', npm: [{ date: '2026-09-16', downloads: 560 }, { date: '2026-09-17', downloads: 40_704_191_058 }] }),
  ])
  assert.equal(series[0].npm, 560)
  assert.equal(series[1].npm, undefined)
})

test('window totals sum views and clones and never claim to sum uniques', () => {
  const series = [
    { day: '2026-09-01', views: 3, uniques: 2, clones: 10, cloneUniques: 4, npm: 5 },
    { day: '2026-09-02', views: 4, uniques: 3, clones: 20, cloneUniques: 6, npm: 0 },
    { day: '2026-09-03', views: 5, uniques: 4 },
  ]
  const totals = windowTotals(series, '2026-09-01', '2026-09-03')
  assert.equal(totals.days, 3)
  assert.equal(totals.views, 12)
  assert.equal(totals.clones, 30)
  assert.equal(totals.viewsDays, 3)
  assert.equal(totals.npm, 5)
  assert.equal(totals.npmDays, 2)
  assert.equal('uniques' in totals, false)
  assert.equal(windowTotals(series, '2026-08-01', '2026-08-31').views, 0)
})

test('percent change has no answer for a zero baseline', () => {
  assert.equal(percentChange(71, 133), 87)
  assert.equal(percentChange(133, 71), -47)
  assert.equal(percentChange(0, 12), null)
  assert.equal(percentChange(Number.NaN, 12), null)
})

test('the sparkline marks gaps and puts the peak at full height', () => {
  assert.equal(sparkline([0, 5, 10]), '▁▅█')
  assert.equal(sparkline([1, undefined, 2]), '▅·█')
  assert.equal(sparkline([]), '')
})

test('release tags group by day and drafts are not releases', () => {
  const map = releaseDayMap([
    { tag: 'v0.7.1', publishedAt: '2026-09-16T06:23:20Z' },
    { tag: 'v0.7.0', publishedAt: '2026-09-16T04:00:00Z' },
    { tag: 'v0.8.0', publishedAt: '2026-09-20T00:00:00Z', draft: true },
    { tag: '', publishedAt: '2026-09-19T00:00:00Z' },
  ])
  assert.deepEqual(map, { '2026-09-16': ['v0.7.1', 'v0.7.0'] })
})

test('the weekly windows compare seven days with seven days', () => {
  const views = []
  for (let index = 0; index < 14; index += 1) {
    const day = shiftDay('2026-09-04', index)
    views.push({ date: day, count: index + 1, uniques: 1 })
  }
  // npm runs a day past GitHub's last traffic day, as it does in practice.
  const npm = views.map(entry => ({ date: entry.date, downloads: 100 }))
  npm.push({ date: '2026-09-18', downloads: 0 })
  const model = buildReportModel({
    snapshots: [snapshot({ at: '2026-09-18T06:00:00.000Z', views, npm })],
    now: new Date('2026-09-18T12:00:00Z'),
    days: 28,
  })
  assert.equal(model.trafficThrough, '2026-09-17')
  assert.deepEqual([model.trailing.from, model.trailing.to], ['2026-09-11', '2026-09-17'])
  assert.equal(model.trailing.viewsDays, 7)
  assert.equal(model.trailing.days, 7)
  assert.equal(model.previous.viewsDays, 7)
  assert.equal(model.trailing.views, 11 + 12 + 13 + 14 + 8 + 9 + 10)
  assert.equal(model.previous.views, 1 + 2 + 3 + 4 + 5 + 6 + 7)
})

test('a zero from npm is pending while it settles, and a real zero once it has', () => {
  const model = buildReportModel({
    snapshots: [
      snapshot({
        at: '2026-09-18T06:00:00.000Z',
        views: [
          { date: '2026-09-15', count: 17, uniques: 12 },
          { date: '2026-09-16', count: 39, uniques: 16 },
          { date: '2026-09-17', count: 14, uniques: 12 },
        ],
        npm: [
          { date: '2026-09-16', downloads: 0 },
          { date: '2026-09-17', downloads: 0 },
          { date: '2026-09-18', downloads: 0 },
        ],
      }),
    ],
    now: new Date('2026-09-18T12:00:00Z'),
    days: 7,
  })
  const text = renderText(model)
  const row = day => text.split('\n').find(line => line.startsWith(day)) ?? ''
  assert.match(row('2026-09-15'), /npm missing/u)
  assert.match(row('2026-09-16'), /\s0$/u)
  assert.doesNotMatch(row('2026-09-16'), /npm/u)
  assert.match(row('2026-09-17'), /npm pending/u)
  assert.match(row('2026-09-18'), /npm pending/u)
  // The windows come from traffic days only, so the setting npm days do not shift them.
  assert.equal(model.trailing.to, '2026-09-17')
})

test('stale and gapped stores say so instead of printing a smooth line', () => {
  const model = buildReportModel({
    snapshots: [
      snapshot({ at: '2026-08-01T06:00:00.000Z', views: [{ date: '2026-08-01', count: 1, uniques: 1 }] }),
      snapshot({ at: '2026-09-17T06:00:00.000Z', views: [{ date: '2026-09-17', count: 9, uniques: 4 }] }),
    ],
    now: new Date('2026-09-25T12:00:00Z'),
    days: 28,
  })
  const joined = model.warnings.join('\n')
  assert.match(joined, /last sample is 8 days old/u)
  assert.match(joined, /no data for 2026-08-02/u)
  assert.match(renderText(model), /warning: last sample is 8 days old/u)
  assert.match(renderMarkdown(model), /- warning: no data for/u)
})

test('markdown renders a real table, text keeps the plain one', () => {
  const model = buildReportModel({
    snapshots: [snapshot({ at: '2026-09-18T06:00:00.000Z', views: [{ date: '2026-09-17', count: 14, uniques: 12 }] })],
    now: new Date('2026-09-18T12:00:00Z'),
    days: 7,
    storePath: '/tmp/heat.jsonl',
  })
  const markdown = renderMarkdown(model)
  assert.match(markdown, /^\| date\s+\| views\s*\|/mu)
  assert.match(markdown, /^\| --- \| ---: \|/mu)
  assert.match(markdown, /\| 2026-09-17 \|\s+14 \|/u)
  assert.doesNotMatch(renderText(model), /\|/u)
})

test('an empty store reports empty, not a baseline of zeros', () => {
  const model = buildReportModel({ snapshots: [], now: new Date('2026-09-18T12:00:00Z'), days: 28 })
  assert.deepEqual(model.warnings, ['the store is empty — nothing to report yet'])
  assert.equal(model.span.from, null)
  assert.equal(renderText(model).includes('date  views'), true)
})

test('a torn store line is skipped, the rest of the store is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-heat-'))
  const path = join(dir, 'samples.jsonl')
  const first = snapshot({ at: '2026-09-17T06:00:00.000Z', views: [{ date: '2026-09-16', count: 39, uniques: 16 }] })
  const second = snapshot({ at: '2026-09-18T06:00:00.000Z', views: [{ date: '2026-09-17', count: 14, uniques: 12 }] })
  writeFileSync(path, `${JSON.stringify(first)}\n{"v":1,"at":"2026-09-\n${JSON.stringify(second)}\n`)
  const state = readStore(path)
  assert.equal(state.snapshots.length, 2)
  assert.equal(state.skipped, 1)
  const model = buildReportModel({ snapshots: state.snapshots, skipped: state.skipped, now: new Date('2026-09-18T12:00:00Z') })
  assert.match(model.warnings.join('\n'), /1 store line\(s\) could not be parsed/u)
  assert.equal(readStore(join(dir, 'absent.jsonl')).missing, true)
})

test('the token is found in the environment, a token file, or a credential store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-heat-token-'))
  const file = join(dir, 'github.token')
  writeFileSync(file, 'github_pat_fromfile\n')
  assert.deepEqual(discoverToken({ tokenFile: file }), { token: 'github_pat_fromfile', source: file })
  assert.deepEqual(discoverToken({ env: { GITHUB_TOKEN: ' github_pat_env ' }, home: dir }), { token: 'github_pat_env', source: 'the environment' })
  const home = mkdtempSync(join(tmpdir(), 'dsh-heat-home-'))
  assert.equal(discoverToken({ env: {}, home }).token, undefined)
  const parsed = tokenFromGitCredentials('https://cyjyyd:github_pat_abc123@github.com\n')
  assert.deepEqual(parsed, { user: 'cyjyyd', token: 'github_pat_abc123' })
  assert.equal(tokenFromGitCredentials('not a credential line'), null)
})

test('a token never survives into a message or a store', () => {
  const redacted = redact('GET https://api.github.com failed with github_pat_11ABCdef_xyz and Authorization: Bearer ghp_abcdef123456')
  assert.equal(redacted.includes('github_pat_11ABCdef_xyz'), false)
  assert.equal(redacted.includes('ghp_abcdef123456'), false)
  assert.match(redacted, /<token>/u)
})

test('the store defaults to $DSH_HOME, and a blank one is unset', () => {
  // `resolve` in the expectation: on Windows both the drive and the separator differ.
  assert.equal(defaultStorePath({ DSH_HOME: '/srv/dsh' }, '/home/u'), join(resolve('/srv/dsh'), 'heat', 'samples.jsonl'))
  assert.equal(defaultStorePath({ DSH_HOME: '   ' }, '/home/u'), join(resolve('/home/u'), '.dsh', 'heat', 'samples.jsonl'))
  assert.equal(defaultStorePath({}, '/home/u'), join(resolve('/home/u'), '.dsh', 'heat', 'samples.jsonl'))
})

test('day helpers stay in UTC across month ends', () => {
  assert.equal(utcDay(new Date('2026-09-18T23:59:59Z')), '2026-09-18')
  assert.equal(shiftDay('2026-09-01', -1), '2026-08-31')
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01')
  assert.equal(dayDistance('2026-09-11', '2026-09-17'), 6)
  assert.equal(apiDay('2026-09-16T06:23:20Z'), '2026-09-16')
  assert.equal(apiDay(undefined), null)
})

test('the dshfind card is read from its own markup, in either language', () => {
  assert.equal(parseDshfindVersion('<span>版本 0.6.3</span>'), '0.6.3')
  assert.equal(parseDshfindVersion('<span>Version 0.7.2-rc.1</span>'), '0.7.2-rc.1')
  assert.equal(parseDshfindVersion('<span>nothing here</span>'), null)
  assert.equal(parseDshfindStars('<title>dshfind: dsh-ssh-tui — ★ 1</title>'), 1)
  assert.equal(parseDshfindStars('<title>★ 1,204</title>'), 1204)
  assert.equal(parseDshfindStars('<svg/>'), null)
})
