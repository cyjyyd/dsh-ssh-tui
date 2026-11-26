/**
 * Diagnostics for the real-PTY probes.
 *
 * The 0.9.0 main-push red (run 45735121259 attempt 1) was a setup probe that printed
 * `resumed first run: … workspace back` and then `FAIL` on the same run. Two things
 * were wrong with the evidence rather than with the product:
 *
 *   - the success line was emitted before the assertions were known to pass;
 *   - the failure left no screen, no child exit status and no versions behind.
 *
 * These cases pin the diagnostics contract: readiness is read from the current
 * terminal grid (not the accumulated stream), the sanitiser runs before any tail,
 * a child's liveness is frozen before intentional teardown, and the reporter never
 * prints a success line on failure.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { screen } from './screen.mjs'
import {
  assertDiagnosticSafe,
  markTeardown,
  observeChild,
  reportOutcome,
  safeDetail,
  safeExcerpt,
  sanitizeText,
  workspaceFrameReady,
  writeDiagnosticBundle,
} from '../scripts/probe-diagnostics.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

/** Replay bytes through the same terminal grid the probe uses. */
async function replay(stream, cols = 100, rows = 30) {
  const grid = await screen(cols, rows)
  await grid.write(stream)
  return grid.grid()
}

test('a cleared dialog frame is not ready even when a later footer is on screen', async () => {
  // The exact review counterexample: stale dialog, clear, then a confirmation and
  // footer in the final frame, but no composer. The accumulated ANSI-stripped text
  // still holds `╭` and `目录:`, so the old text-level test accepted it.
  const stream = [
    '\x1b[2J',
    '\x1b[1;1H',
    '╭── stale dialog ──╮',
    '\x1b[2J',
    '\x1b[29;1H',
    '配置完成',
    '\x1b[30;1H',
    '目录:synthetic',
  ].join('')
  const rows = await replay(stream)
  assert.equal(rows.some(row => row.includes('stale dialog')), false,
    'the clear removed the dialog from the visible frame')
  assert.equal(workspaceFrameReady(rows), false,
    'a footer on a cleared frame is not a workspace')
})

test('a stale transcript prompt without a composer is not ready', async () => {
  const stream = [
    '\x1b[2J',
    '\x1b[4;1H',
    '❯ an old transcript row',
    '\x1b[30;1H',
    '目录:repo',
  ].join('')
  const rows = await replay(stream)
  assert.equal(workspaceFrameReady(rows), false)
})

test('a current-frame composer and footer are ready', async () => {
  const stream = [
    '\x1b[2J',
    '\x1b[25;1H',
    '╭────────────────────────────────────────',
    '\x1b[26;1H',
    '❯ draft',
    '\x1b[28;1H',
    '本地 80ms │ 空闲',
    '\x1b[29;1H',
    '目录:repo · sub:model',
  ].join('')
  const rows = await replay(stream)
  assert.equal(workspaceFrameReady(rows), true)
  assert.equal(rows.at(-2).includes('目录:repo'), true, 'the footer is the last painted row')
  assert.equal(rows.at(-1).trim(), '', 'the row below it is empty')
})

test('the composer check needs the boundary, the prompt and the bottom footer together', () => {
  const base = Array.from({ length: 30 }, () => '')
  base[26] = '╭────────────────────────'
  base[27] = '❯ '
  base[29] = '目录:repo'
  assert.equal(workspaceFrameReady(base), true)
  assert.equal(workspaceFrameReady(base.map((row, index) => (index === 29 ? '' : row))), false,
    'no footer')
  assert.equal(workspaceFrameReady(base.map((row, index) => (index === 26 ? '' : row))), false,
    'no composer boundary')
  assert.equal(workspaceFrameReady(base.map((row, index) => (index === 27 ? '' : row))), false,
    'no prompt')
  const monochrome = base.map((row, index) => (index === 27 ? '> ' : row))
  assert.equal(workspaceFrameReady(monochrome), true, 'the no-colour prompt is still a composer')
  const highFooter = base.map((row, index) => (index === 29 ? '' : row))
  highFooter[20] = '目录:repo'
  assert.equal(workspaceFrameReady(highFooter), false, 'a footer outside the bottom rows is not current')
  assert.equal(workspaceFrameReady(['\x1b[32m╭────\x1b[0m', '\x1b[32m❯\x1b[0m ', '', '目录:repo']), true,
    'ANSI colour runs do not hide the rows')
})

test('sanitisation drops keys, bearer tokens, homes and session ids', () => {
  const raw = [
    'home: /home/alice/project',
    'probe: /tmp/dsh-artifact-home-4BBDnN',
    'key=sk-live-1234567890',
    'Authorization: Bearer abc.def.ghi',
    'DEEPSEEK_API_KEY=sk-xyz-987654321',
    'resume=session-123e4567-e89b-12d3-a456-426614174000',
  ].join('\n')
  const safe = sanitizeText(raw, { home: '/home/alice/project' })
  assert.ok(!safe.includes('/home/alice'), safe)
  assert.ok(!safe.includes('dsh-artifact-home-4BBDnN'), safe)
  assert.ok(!safe.includes('sk-live-1234567890'), safe)
  assert.ok(!safe.includes('sk-xyz-987654321'), safe)
  assert.ok(!safe.includes('abc.def.ghi'), safe)
  assert.ok(!safe.includes('123e4567-e89b-12d3-a456-426614174000'), safe)
  assert.match(safe, /<home>/u)
  assert.match(safe, /<probe-home>/u)
  assert.match(safe, /<redacted-key>/u)
  assert.match(safe, /<redacted-token>/u)
  assert.match(safe, /<session-id>/u)
})

test('a value split by an ANSI run is still one supported pattern', () => {
  const raw = [
    'key sk-\x1b[31mSYNTHETIC-ONLY-123456\x1b[0m',
    'Authorization: Bearer\x1b[0m SYNTHETIC-ONLY-TOKEN',
  ].join('\n')
  const safe = sanitizeText(raw)
  assert.ok(!safe.includes('SYNTHETIC-ONLY'), safe)
  assert.match(safe, /<redacted-key>/u)
  assert.match(safe, /Bearer <redacted-token>/u)
})

test('the outcome reporter never prints success lines for a failed run', () => {
  const success = []
  const errors = []
  const code = reportOutcome({
    problems: ['the workspace never came back'],
    successLines: ['resumed first run: workspace back'],
    log: line => success.push(line),
    error: line => errors.push(line),
  })
  assert.equal(code, 1)
  assert.deepEqual(success, [], 'no success line on failure')
  assert.match(errors.join('\n'), /FAIL/u)
  assert.match(errors.join('\n'), /the workspace never came back/u)

  const ok = []
  const codeOk = reportOutcome({
    problems: [],
    successLines: ['resumed first run: workspace back'],
    log: line => ok.push(line),
    error: () => assert.fail('no error output on success'),
  })
  assert.equal(codeOk, 0)
  assert.deepEqual(ok, ['resumed first run: workspace back'])
})

test('the failure bundle sanitises the whole value before tailing at 65536/32768 bytes', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-probe-diag-test-'))
  try {
    const key = 'sk-SYNTHETIC-ONLY-1234567890'
    // Old order was clean(tail(value)): a 65,539-character transcript dropped
    // exactly `sk-`, leaving the payload intact. The bundle must clean first.
    const transcript = `xx/home/synthetic-user\n${key}\n${'x'.repeat(65_539 - 'xx/home/synthetic-user\n'.length - key.length - 1)}`
    assert.equal(transcript.length, 65_539)
    const bearerLine = 'Bearer SYNTHETIC-ONLY-TOKEN\n'
    const screenText = `${bearerLine}${'y'.repeat(32_771 - bearerLine.length)}`
    assert.equal(screenText.length, 32_771)
    const result = writeDiagnosticBundle({
      dir: base,
      phase: 'resumed-save',
      problems: ['timed out waiting for workspace', `raw ${key}`],
      output: transcript,
      screen: screenText,
      child: { name: 'resumed', pid: 4242, exit: { exitCode: 1, signal: null } },
      elapsedMs: 30_123,
      runtime: { node: 'v24.20.0', npm: '11.19.0', pnpm: 'unavailable', os: 'linux 6.8 x64' },
      now: new Date('2026-11-26T02:30:00Z'),
      home: '/home/synthetic-user',
    })
    assert.ok(existsSync(join(result.dir, 'diagnostics.json')))
    assert.ok(existsSync(join(result.dir, 'screen.txt')))
    assert.ok(existsSync(join(result.dir, 'transcript.txt')))
    assert.ok(existsSync(join(result.dir, 'versions.txt')))
    const json = JSON.parse(readFileSync(join(result.dir, 'diagnostics.json'), 'utf8'))
    assert.equal(json.schema, 'dsh-ssh-tui/probe-diagnostics/v1')
    assert.equal(json.phase, 'resumed-save')
    assert.equal(json.elapsedMs, 30_123)
    assert.equal(json.child.name, 'resumed')
    assert.equal(json.child.exit.exitCode, 1)
    assert.equal(json.runtime.pnpm, 'unavailable')
    assert.deepEqual(json.problems, ['timed out waiting for workspace', 'raw <redacted-key>'])
    for (const name of ['diagnostics.json', 'screen.txt', 'transcript.txt', 'versions.txt']) {
      const text = readFileSync(join(result.dir, name), 'utf8')
      assert.ok(!text.includes('SYNTHETIC-ONLY'), `${name} leaked the synthetic payload`)
      assert.ok(!text.includes('synthetic-user'), `${name} leaked the home`)
      assert.ok(!text.includes('\x1b'), `${name} kept an escape sequence`)
    }
    assert.match(readFileSync(join(result.dir, 'versions.txt'), 'utf8'), /node/u)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a log excerpt sanitises the whole value too', () => {
  const key = 'sk-SYNTHETIC-ONLY-1234567890'
  const raw = `xx/home/synthetic-user\n${key}\n${'z'.repeat(100)}`
  const excerpt = safeExcerpt(raw, 1_600, { home: '/home/synthetic-user' })
  assert.ok(!excerpt.includes('SYNTHETIC-ONLY'), excerpt)
  assert.ok(!excerpt.includes('synthetic-user'), excerpt)
  assert.match(excerpt, /<redacted-key>/u)

  // The same boundary as the old `clean(raw.slice(-1600))`: the cut lands just
  // after `sk-`, so a slice-first sanitiser sees only the payload.
  const straddling = `${'q'.repeat(1_000)} ${key}${'q'.repeat(1_575)}`
  assert.equal(straddling.length, 2_604)
  const boundary = safeExcerpt(straddling, 1_600, { home: '/home/synthetic-user' })
  assert.ok(!boundary.includes('SYNTHETIC-ONLY'), boundary)
  assert.match(boundary, /<redacted-key>/u)
})

test('an unverifiable key prefix fails closed and writes no file', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-probe-diag-unsafe-'))
  try {
    assert.throws(() => writeDiagnosticBundle({
      dir: base,
      problems: ['unsafe'],
      output: 'sk-\u200bSYNTHETIC-ONLY-UNVERIFIABLE',
      screen: '',
    }), /unsafe/u)
    assert.deepEqual(readdirSync(base), [], 'no diagnostic file is written when safety is unproven')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a captured failure detail sanitises the whole input before the 1200-character cut', () => {
  const home = '/home/synthetic-user'
  const marker = 'SYNTHETIC-ONLY-TAIL-MARKER'
  // The prefix sits before the cut: slice(-1200) drops `sk-` and keeps the body.
  const key = `sk-SYNTHETICONLY${'A'.repeat(100)}${marker}${'B'.repeat(1_100)}`
  const raw = `${'q'.repeat(20)} ${key}`
  assert.ok(raw.length > 1_200)
  const detail = safeDetail(raw, 1_200, { home })
  assert.ok(!detail.includes(marker), 'the cut cannot leave key body behind')
  assert.ok(!detail.includes('sk-'), 'no key prefix is left in the detail')
  assert.match(detail, /<redacted-key>/u)

  const problem = `timed out waiting for the workspace\n--- captured ---\n${detail}`
  const base = mkdtempSync(join(tmpdir(), 'dsh-probe-diag-detail-'))
  try {
    const bundle = writeDiagnosticBundle({
      dir: base,
      phase: 'red-a-green',
      problems: [problem],
      output: 'safe synthetic transcript',
      screen: 'safe synthetic screen',
      now: new Date('2026-11-26T02:30:00Z'),
      home,
    })
    for (const name of readdirSync(bundle.dir)) {
      const text = readFileSync(join(bundle.dir, name), 'utf8')
      assert.ok(!text.includes(marker), `${name} leaked the surviving key body`)
      assert.ok(!text.includes('SYNTHETIC-ONLY'), `${name} leaked the synthetic key`)
    }
    const logs = []
    const code = reportOutcome({
      problems: [problem],
      successLines: [],
      log: line => logs.push(line),
      error: line => logs.push(line),
      home,
    })
    assert.equal(code, 1)
    assert.ok(!logs.join('\n').includes(marker), 'the reporter emitted the surviving key body')
    assert.ok(!logs.join('\n').includes('SYNTHETIC-ONLY'), 'the reporter emitted the synthetic key')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the reporter fails closed on an unverifiable split-prefix key', () => {
  const body = 'SYNTHETIC-ONLY-SPLIT-KEY-123456'
  const split = `sk-\u200b${body}`
  assert.throws(() => assertDiagnosticSafe(sanitizeText(split)), /unsafe/u)
  const logs = []
  const code = reportOutcome({
    problems: [split],
    successLines: [],
    log: line => logs.push(line),
    error: line => logs.push(line),
  })
  const text = logs.join('\n')
  assert.equal(code, 1)
  assert.ok(!text.includes(body), 'the reporter emitted the split key body')
  assert.ok(!text.includes('sk-'), 'the reporter emitted the key prefix')
  assert.match(text, /withheld/u, 'the reporter substituted fixed class-only metadata')
})

test('an unverifiable problem in an otherwise safe packet becomes class-only metadata', () => {
  const body = 'SYNTHETIC-ONLY-PACKET-KEY-123456'
  const split = `sk-\u200b${body}`
  const base = mkdtempSync(join(tmpdir(), 'dsh-probe-diag-problem-'))
  try {
    const bundle = writeDiagnosticBundle({
      dir: base,
      problems: [split],
      output: 'safe synthetic transcript',
      screen: 'safe synthetic screen',
      now: new Date('2026-11-26T02:30:00Z'),
    })
    for (const name of readdirSync(bundle.dir)) {
      const text = readFileSync(join(bundle.dir, name), 'utf8')
      assert.ok(!text.includes(body), `${name} leaked the split key body`)
      assert.ok(!text.includes('sk-'), `${name} leaked the key prefix`)
    }
    const json = JSON.parse(readFileSync(join(bundle.dir, 'diagnostics.json'), 'utf8'))
    assert.match(json.problems[0], /withheld/u)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a rejected packet does not emit the unsafe value through the reporter', () => {
  const body = 'SYNTHETIC-ONLY-REJECTED-KEY-123456'
  const split = `sk-\u200b${body}`
  const base = mkdtempSync(join(tmpdir(), 'dsh-probe-diag-rejected-'))
  try {
    assert.throws(() => writeDiagnosticBundle({
      dir: base,
      problems: [split],
      output: split,
      screen: '',
      home: '/home/synthetic-user',
    }), /unsafe/u)
    assert.deepEqual(readdirSync(base), [], 'a rejected packet leaves no file behind')
    const logs = []
    const code = reportOutcome({
      problems: [split],
      successLines: [],
      log: line => logs.push(line),
      error: line => logs.push(line),
      home: '/home/synthetic-user',
    })
    const text = logs.join('\n')
    assert.equal(code, 1)
    assert.ok(!text.includes(body), 'the reporter emitted the rejected key body')
    assert.ok(!text.includes('sk-'), 'the reporter emitted the rejected key prefix')
    assert.match(text, /withheld/u)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a format control inside diagnostic text is unverifiable', () => {
  assert.throws(
    () => assertDiagnosticSafe(sanitizeText('before\u200bafter')),
    /format control/u,
  )
  assert.throws(
    () => assertDiagnosticSafe(sanitizeText('sk-SYNTHETIC\u200bONLY-123456')),
    /unsafe/u,
  )
})

test('a spontaneous child exit is frozen before teardown', () => {
  const spontaneous = {
    name: 'spontaneous',
    pid: 7,
    startedAt: 1_000,
    exit: { exitCode: 7, signal: null, at: 2_000 },
  }
  const observed = observeChild(spontaneous, 3_000)
  assert.equal(observed.alive, false)
  assert.equal(observed.teardown, false)
  assert.equal(observed.exit.exitCode, 7)
  assert.equal(observed.elapsedMs, 2_000)

  const live = { name: 'live', pid: 8, startedAt: 1_000 }
  const before = observeChild(live, 2_000)
  assert.equal(before.alive, true)
  assert.equal(before.teardown, false)
  markTeardown(live, 2_100)
  live.exit = { exitCode: null, signal: 'SIGTERM', at: 2_200 }
  const after = observeChild(live, 2_300)
  assert.equal(after.alive, false)
  assert.equal(after.teardown, true)
  assert.equal(after.exit.signal, 'SIGTERM')

  const base = mkdtempSync(join(tmpdir(), 'dsh-probe-diag-child-'))
  try {
    const bundle = writeDiagnosticBundle({
      dir: base,
      problems: ['child state'],
      child: { ...live, observed: before },
      now: new Date('2026-11-26T02:30:00Z'),
    })
    const json = JSON.parse(readFileSync(join(bundle.dir, 'diagnostics.json'), 'utf8'))
    assert.equal(json.child.alive, true, 'the pre-teardown observation is what the packet reports')
    assert.equal(json.child.spontaneous, false)
    assert.equal(json.child.teardown, true, 'the probe stopped a child that was alive at the observation')
    assert.equal(json.child.exit, undefined, 'the later SIGTERM must not be attributed to the run')
    assert.equal(json.child.exitAfterTeardown.signal, 'SIGTERM')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the synthetic failure packet is written sanitised and exits nonzero', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-probe-diag-e2e-'))
  const home = join(root, 'synthetic-home')
  const diag = join(home, 'nested-output', 'diagnostics')
  try {
    const env = { ...process.env, PROBE_DIAG_SELFTEST: '1', PROBE_DIAG_DIR: diag, HOME: home }
    delete env.USERPROFILE
    const result = spawnSync(process.execPath, [join(REPO, 'scripts/tui-setup-probe.mjs')], {
      cwd: REPO,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.equal(result.status, 1, 'expected the self-test to exit nonzero')
    assert.ok(/FAIL/u.test(result.stderr), 'stderr reports FAIL')
    assert.ok(/<redacted-key>/u.test(result.stderr), 'stderr shows the redacted key class')
    assert.ok(!result.stderr.includes('SYNTHETIC-ONLY'), 'stderr leaked the synthetic payload')
    assert.ok(!result.stderr.includes('/home/synthetic-user'), 'stderr leaked the fixed synthetic home')
    assert.ok(!result.stdout.includes(home), 'stdout printed the synthetic home')
    assert.ok(!result.stderr.includes(home), 'stderr printed the synthetic home')
    assert.ok(!result.stdout.includes(diag), 'stdout printed the diagnostic destination')
    assert.ok(!result.stderr.includes(diag), 'stderr printed the diagnostic destination')
    assert.match(result.stderr, /diagnostics: tui-setup-probe-\S+ written under the configured diagnostic destination/u,
      'the log names the generated packet and the configured location category, not the path')
    const runs = readdirSync(diag)
    assert.equal(runs.length, 1, `one packet: ${runs.join(', ')}`)
    const dir = join(diag, runs[0])
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), 'utf8')
      assert.ok(!text.includes('SYNTHETIC-ONLY'), `${name} leaked the synthetic payload`)
      assert.ok(!text.includes('/home/synthetic-user'), `${name} leaked the home`)
      assert.ok(!text.includes(home), `${name} leaked the synthetic run home`)
      assert.ok(!text.includes(diag), `${name} leaked the diagnostic destination`)
      assert.ok(!text.includes('\x1b'), `${name} kept an escape sequence`)
    }
    const json = JSON.parse(readFileSync(join(dir, 'diagnostics.json'), 'utf8'))
    assert.equal(json.phase, 'self-test')
    assert.equal(json.child.alive, false)
    assert.equal(json.child.teardown, false)
    assert.equal(json.child.exit.exitCode, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a self-test bundle write failure is path-free and still exits nonzero', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-probe-diag-e2e-fail-'))
  const home = join(root, 'synthetic-home')
  const blocker = join(home, 'blocker')
  const diag = join(blocker, 'diagnostics')
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(blocker, 'not a directory')
    const env = { ...process.env, PROBE_DIAG_SELFTEST: '1', PROBE_DIAG_DIR: diag, HOME: home }
    delete env.USERPROFILE
    const result = spawnSync(process.execPath, [join(REPO, 'scripts/tui-setup-probe.mjs')], {
      cwd: REPO,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.equal(result.status, 1, 'expected the self-test write failure to exit nonzero')
    assert.ok(/could not write the self-test bundle under the configured diagnostic destination/u.test(result.stderr),
      'the write failure is reported by category')
    assert.ok(/ENOTDIR/u.test(result.stderr), 'the path-free errno code is kept')
    assert.ok(!result.stderr.includes(home), 'stderr printed the synthetic home')
    assert.ok(!result.stderr.includes(diag), 'stderr printed the diagnostic destination')
    assert.ok(!/^\s+at .*mkdirSync/mu.test(result.stderr), 'the raw stack reached the log')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a real failed boot and its --keep notice print no raw path', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-probe-diag-boot-'))
  const home = join(root, 'synthetic-home')
  const diag = join(home, 'nested-output', 'diagnostics')
  const fakeCli = join(root, 'fake-tui.mjs')
  try {
    mkdirSync(home, { recursive: true })
    // A real PTY child that settles into the workspace: with PROBE_REQUIRE_WIZARD the
    // probe fails fast (after its three-second settle window) and reaches the same
    // bundle/reporter boundary as a red setup run, without a provider or real home.
    writeFileSync(fakeCli, "process.stdout.write('目录:fake\\n'); setInterval(() => {}, 1000)\\n")
    const env = {
      ...process.env,
      HOME: home,
      PROBE_HOME: home,
      PROBE_CLI: fakeCli,
      PROBE_DIAG_DIR: diag,
      PROBE_REQUIRE_WIZARD: '1',
    }
    delete env.USERPROFILE
    const result = spawnSync(process.execPath, [join(REPO, 'scripts/tui-setup-probe.mjs'), '--keep'], {
      cwd: REPO,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    })
    if (/node-pty is unavailable/u.test(result.stdout ?? '')) {
      // The probe's own documented skip: this host cannot exercise a PTY. Not a pass
      // for the path check, but the self-test above still covers the writer/reporter.
      assert.equal(result.status, 0)
      return
    }
    assert.equal(result.status, 1, 'expected the failing boot to exit nonzero')
    assert.ok(/FAIL/u.test(result.stderr), 'stderr reports FAIL')
    assert.ok(/diagnostics: tui-setup-probe-\S+ written under the configured diagnostic destination/u.test(result.stderr),
      'the bundle log names the packet and the location category')
    assert.ok(/probe home kept: the configured probe home \(PROBE_HOME or DSH_HOME\); its path is not printed/u.test(result.stdout),
      'the keep notice is path-free')
    assert.ok(!result.stdout.includes(home), 'stdout printed the synthetic home')
    assert.ok(!result.stderr.includes(home), 'stderr printed the synthetic home')
    assert.ok(!result.stdout.includes(diag), 'stdout printed the diagnostic destination')
    assert.ok(!result.stderr.includes(diag), 'stderr printed the diagnostic destination')
    const runs = readdirSync(diag)
    assert.equal(runs.length, 1, `one packet: ${runs.join(', ')}`)
    const dir = join(diag, runs[0])
    assert.ok(existsSync(join(dir, 'diagnostics.json')), 'the intended packet exists')
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), 'utf8')
      assert.ok(!text.includes(home), `${name} leaked the synthetic run home`)
      assert.ok(!text.includes(diag), `${name} leaked the diagnostic destination`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
