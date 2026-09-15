import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  analyzePatch,
  duplicatePatchRows,
  planDuplicateRepair,
  planRosterRepair,
  ROSTER_PATCH_BLOCK,
  ROSTER_ROWS,
  rosterPatchPath,
  writePatchWithBackup,
} from '../lib/preset-rows.js'
const root = join(import.meta.dirname, '..')

import {
  collectDoctor,
  copyTrapHint,
  doctorChecks,
  findScopeCopies,
  formatDoctorReport,
  rowsToRepair,
} from '../lib/doctor.js'

const WEB_ROW = "- insert:\n    - id: webserver\n      name: '@deepseek-ai/dsh-host-webserver'\n"

/** One synthetic snapshot; individual tests override what they are about. */
function facts(overrides = {}) {
  const patchText = overrides.patchText ?? WEB_ROW
  return {
    pluginVersion: '0.6.4', // synthetic facts: the value is not the point here
    hostVersion: '0.1.5-rc.1',
    nodeVersion: 'v24.0.0',
    profile: 'tui',
    dshHome: '/home/.dsh',
    patchPath: '/home/.dsh/profiles/tui/cordis.patch.yml',
    services: { roster: true, codeRuntime: true },
    patch: { readable: true, text: patchText, analysis: analyzePatch(patchText) },
    bundleRows: [],
    compatibility: { range: '>=0.1.2-rc.1 <0.1.6', releases: { '0.1.5-rc.1': 'compatible' } },
    scopeCopies: ['/usr/lib/node_modules/@deepseek-ai/dsh-scope'],
    ...overrides,
  }
}

const checkOf = (checks, id) => checks.find(check => check.id === id)

test('a missing roster is named row by row', () => {
  // Bad case 1: the profile composes nothing (0.6.3's regression).
  const snapshot = facts({
    services: { roster: false, codeRuntime: false },
    patchText: '[]\n',
  })
  const checks = doctorChecks(snapshot)
  const roster = checkOf(checks, 'roster')
  assert.equal(roster.status, 'fail')
  assert.equal(roster.fixable, true)
  assert.deepEqual(roster.details, [`缺少行：${ROSTER_ROWS[0].id}`])
  const runtime = checkOf(checks, 'code-runtime')
  assert.equal(runtime.status, 'fail')
  assert.deepEqual(runtime.details, [`缺少行：${ROSTER_ROWS[1].id}`])
  assert.equal(checkOf(checks, 'subagent-settings').status, 'warn')
  assert.deepEqual(rowsToRepair(snapshot), [...ROSTER_ROWS])
})

test('a declared row whose service never registered is reported, not re-added', () => {
  const snapshot = facts({ services: { roster: false, codeRuntime: true }, patchText: ROSTER_PATCH_BLOCK })
  const roster = checkOf(doctorChecks(snapshot), 'roster')
  assert.equal(roster.status, 'fail')
  assert.equal(roster.fixable, false, 'writing the row again would only duplicate it')
  assert.match(roster.details[0], /dsh-scope|模块解析|module resolution/u)
  assert.deepEqual(rowsToRepair(snapshot), [])
})

test('a composed service keeps its row from being mounted again', () => {
  // The web bundle (or a user's own patch) may already mount the roster while
  // this profile patch declares nothing: writing our row then would double-mount
  // it, so the fix must plan no write even though the text lacks the row.
  const snapshot = facts({ services: { roster: true, codeRuntime: true }, patchText: WEB_ROW })
  const checks = doctorChecks(snapshot)
  assert.equal(checkOf(checks, 'roster').status, 'ok')
  assert.equal(checkOf(checks, 'code-runtime').status, 'ok')
  assert.equal(checkOf(checks, 'subagent-settings').status, 'warn')
  assert.deepEqual(rowsToRepair(snapshot).map(row => row.id), [ROSTER_ROWS[2].id])
})

test('a duplicate mount is pointed at its line', () => {
  // Bad case 2: the same block written twice (installer plus in-app repair).
  const doubled = `${ROSTER_PATCH_BLOCK}${ROSTER_PATCH_BLOCK}`
  const snapshot = facts({ patchText: doubled })
  const duplicates = checkOf(doctorChecks(snapshot), 'duplicates')
  assert.equal(duplicates.status, 'fail')
  assert.equal(duplicates.fixable, true)
  // Three rows are repeated; each detail names the row and the line it sits on.
  assert.equal(duplicates.details.length, 3)
  for (const detail of duplicates.details) assert.match(detail, /^第 \d+ 行：/u)
  const firstLine = Number(/(\d+)/u.exec(duplicates.details[0])[1])
  assert.ok(firstLine > ROSTER_PATCH_BLOCK.split('\n').length, `second copy starts later (${firstLine})`)
})

test('two dsh-scope copies are listed with both paths', () => {
  // Bad case 3: the nested-install copy trap.
  const copies = ['/usr/lib/node_modules/@deepseek-ai/dsh-scope', '/srv/app/node_modules/@deepseek-ai/dsh-scope']
  const check = checkOf(doctorChecks(facts({ scopeCopies: copies })), 'scope-copies')
  assert.equal(check.status, 'fail')
  assert.deepEqual(check.details, copies)
  assert.match(check.summary, /2/u)
})

test('a broken patch is reported with the parser error', () => {
  const snapshot = facts({ patchText: '- insert:\n    - id: [unclosed\n' })
  const checks = doctorChecks(snapshot)
  const patch = checkOf(checks, 'patch')
  assert.equal(patch.status, 'fail')
  assert.equal(patch.fixable, undefined, 'a YAML error is the user’s to fix')
  assert.equal(checkOf(checks, 'subagent-settings').status, 'warn')
  assert.deepEqual(rowsToRepair(snapshot), [])
})

test('an unreadable patch is a fixable failure', () => {
  const snapshot = facts({
    patch: { readable: false, text: '', analysis: { parseable: true, rows: [] } },
    services: { roster: false, codeRuntime: false },
  })
  const checks = doctorChecks(snapshot)
  assert.equal(checkOf(checks, 'patch').status, 'fail')
  assert.equal(checkOf(checks, 'patch').fixable, true)
  assert.deepEqual(rowsToRepair(snapshot), [...ROSTER_ROWS])
})

test('the host version is judged against the declared table', () => {
  const compatible = checkOf(doctorChecks(facts()), 'version')
  assert.equal(compatible.status, 'ok')

  const undeclared = checkOf(doctorChecks(facts({ hostVersion: '0.1.9' })), 'version')
  assert.equal(undeclared.status, 'warn')
  assert.match(undeclared.details[0], /0\.1\.5-rc\.1/u)

  const unknown = checkOf(doctorChecks(facts({
    compatibility: { releases: { '0.1.5-rc.1': 'unknown' } },
  })), 'version')
  assert.equal(unknown.status, 'warn')
})

test('routing mismatches are reported per problem', () => {
  const clean = checkOf(doctorChecks(facts({
    routing: { provider: 'deepseek', model: 'deepseek-v4-flash', routes: ['deepseek'], routeModels: ['deepseek-v4-flash'] },
  })), 'routing')
  assert.equal(clean.status, 'ok')

  const messy = checkOf(doctorChecks(facts({
    routing: {
      provider: 'ghost',
      model: 'deepseek-v4-flash',
      routes: ['deepseek'],
      routeModels: ['deepseek-v4-pro'],
      subProvider: 'xai',
      subModel: 'deepseek-v4-flash',
    },
  })), 'routing')
  assert.equal(messy.status, 'warn')
  assert.equal(messy.details.length, 3)
})

test('the report renders every check with its evidence', () => {
  const snapshot = facts({ services: { roster: false, codeRuntime: true }, patchText: '[]\n' })
  const lines = formatDoctorReport(snapshot, doctorChecks(snapshot))
  assert.ok(lines[0].includes('/doctor'))
  assert.ok(lines.some(line => line.startsWith('✖ ') && line.includes('名单')))
  assert.ok(lines.some(line => line.includes('/doctor --fix')))
  assert.ok(lines.some(line => line.includes(snapshot.patchPath)))
})

test('repairing a missing roster equals a hand-written patch', () => {
  // The profile script and the in-app repair produce the same file, so the
  // composed config cannot depend on which path wrote it.
  const template = `${[
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  ].join('\n')}\n[]\n\n`
  const repair = planRosterRepair(template, ROSTER_ROWS)
  assert.ok(repair !== undefined)
  const handWritten = `${[
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  ].join('\n')}\n${ROSTER_PATCH_BLOCK}`
  assert.equal(repair.text, handWritten)
  assert.equal(planRosterRepair(repair.text, ROSTER_ROWS), undefined, 'idempotent')
  assert.deepEqual(analyzePatch(repair.text).rows.map(row => row.id), ROSTER_ROWS.map(row => row.id))
})

test('repairing a duplicate equals a hand-written single copy', () => {
  const doubled = `${WEB_ROW}\n${ROSTER_PATCH_BLOCK}${ROSTER_PATCH_BLOCK}`
  const repair = planDuplicateRepair(doubled)
  assert.ok(repair !== undefined)
  assert.deepEqual(repair.removed.map(entry => entry.id), ROSTER_ROWS.map(row => row.id))
  assert.equal(repair.text, `${WEB_ROW}\n${ROSTER_PATCH_BLOCK}`, 'the first copy and the user row stay')
  assert.equal(planDuplicateRepair(repair.text), undefined, 'idempotent')
})

test('a duplicate inside one entry loses only the repeated item', () => {
  const oneEntry = [
    '- insert:',
    "    - id: agent-presets",
    "      name: '@deepseek-ai/dsh-agent-presets'",
    '',
    "    - id: code-runtime",
    "      name: '@deepseek-ai/dsh-code-runtime-worker-thread'",
    '',
    "    - id: code-runtime",
    "      name: '@deepseek-ai/dsh-code-runtime-worker-thread'",
    '',
  ].join('\n')
  const repair = planDuplicateRepair(oneEntry)
  assert.ok(repair !== undefined)
  assert.deepEqual(repair.removed.map(entry => entry.id), ['code-runtime'])
  const parsed = analyzePatch(repair.text)
  assert.deepEqual(parsed.rows.map(row => row.id), ['agent-presets', 'code-runtime'])
  assert.equal(repair.text.includes('\n\n\n'), false, 'no blank run is left behind')
})

test('an override the user wrote is never treated as a duplicate', () => {
  const withOverride = `${ROSTER_PATCH_BLOCK}\n- override:\n    id: agent-presets\n    config:\n      default: minimal\n`
  assert.deepEqual(duplicatePatchRows(analyzePatch(withOverride).rows), [])
  assert.equal(planDuplicateRepair(withOverride), undefined)
  assert.equal(planRosterRepair(withOverride, ROSTER_ROWS), undefined, 'nothing is missing')
})

test('a repaired profile passes the checks that failed before it', () => {
  const before = facts({ services: { roster: false, codeRuntime: false }, patchText: `${WEB_ROW}\n${ROSTER_PATCH_BLOCK}${ROSTER_PATCH_BLOCK}` })
  assert.equal(checkOf(doctorChecks(before), 'duplicates').status, 'fail')
  assert.equal(checkOf(doctorChecks(before), 'roster').status, 'fail')

  let text = before.patch.text
  const duplicates = planDuplicateRepair(text)
  if (duplicates !== undefined) text = duplicates.text
  const roster = planRosterRepair(text, rowsToRepair(before))
  if (roster !== undefined) text = roster.text
  const after = facts({
    services: { roster: true, codeRuntime: true },
    patchText: text,
  })
  const checks = doctorChecks(after)
  assert.equal(checkOf(checks, 'duplicates').status, 'ok')
  assert.equal(checkOf(checks, 'roster').status, 'ok')
  assert.equal(checkOf(checks, 'code-runtime').status, 'ok')
  assert.equal(checkOf(checks, 'subagent-settings').status, 'ok')
  assert.equal(checks.filter(check => check.status === 'fail').length, 0)
})

test('findScopeCopies locates a nested copy and deduplicates', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-doctor-'))
  try {
    const outer = join(home, 'outer')
    const inner = join(home, 'outer', 'node_modules', 'dsh-ssh-tui', 'node_modules')
    await mkdir(join(outer, 'node_modules', '@deepseek-ai', 'dsh-scope'), { recursive: true })
    await mkdir(join(inner, '@deepseek-ai', 'dsh-scope'), { recursive: true })
    await writeFile(join(outer, 'node_modules', '@deepseek-ai', 'dsh-scope', 'package.json'), '{}')
    await writeFile(join(inner, '@deepseek-ai', 'dsh-scope', 'package.json'), '{}')
    const found = findScopeCopies([join(outer, 'node_modules', 'dsh-ssh-tui')])
    assert.equal(found.length, 2)
    assert.deepEqual([...new Set(found)].length, found.length, 'deduplicated')
    assert.deepEqual(findScopeCopies([join(home, 'nowhere')]), [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a boot that died on the copy trap gets an actionable hint', () => {
  // The composition fails before the TUI exists, so /doctor cannot answer this
  // one; the launcher's failure report is the only place the hint can land.
  const real = 'agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset'
  const hint = copyTrapHint(real)
  assert.ok(hint !== undefined, 'the real failure text must be recognized')
  assert.ok(hint.includes('dsh-scope'), hint)
  assert.ok(hint.includes('README'), hint)
  assert.equal(copyTrapHint('some other host failure'), undefined)
  assert.equal(copyTrapHint(''), undefined)
})

test('writePatchWithBackup keeps the previous bytes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-doctor-'))
  try {
    const path = join(home, 'cordis.patch.yml')
    await writeFile(path, WEB_ROW)
    const backup = await writePatchWithBackup(path, `${WEB_ROW}\n${ROSTER_PATCH_BLOCK}`, 'test-stamp')
    assert.equal(backup, `${path}.bak-test-stamp`)
    assert.equal(await readFile(backup, 'utf8'), WEB_ROW)
    assert.ok((await readFile(path, 'utf8')).includes('agent-presets'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('collectDoctor reads the real patch, manifest, and bundle rows', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-doctor-'))
  try {
    const path = rosterPatchPath(home, 'tui')
    await mkdir(join(home, 'profiles', 'tui'), { recursive: true })
    await writeFile(path, '[]\n')
    const snapshot = await collectDoctor({
      profile: 'tui',
      dshHome: home,
      hostVersion: '0.1.5-rc.1',
      services: { roster: false, codeRuntime: false },
      anchors: [],
    })
    assert.equal(snapshot.patch.readable, true)
    assert.equal(snapshot.patchPath, path)
    // The reported version is the manifest's, so a release bump never breaks
    // this: hard-coding it here made every version bump a failing test.
    assert.equal(snapshot.pluginVersion, JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version)
    assert.equal(snapshot.compatibility.releases['0.1.5-rc.1'], 'compatible')
    // The shipped bundle patch is read from the package root, next to lib/.
    assert.ok(Array.isArray(snapshot.bundleRows))
    const checks = doctorChecks(snapshot)
    assert.equal(checkOf(checks, 'roster').status, 'fail')
    assert.equal(checkOf(checks, 'version').status, 'ok')
    assert.deepEqual(snapshot.scopeCopies, [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
