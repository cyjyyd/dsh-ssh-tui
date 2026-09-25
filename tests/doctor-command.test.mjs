import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setLocale } from '../lib/i18n/index.js'
import {
  allText, diagText, errorText, lastSystemText, systemText, tick, waitForDialog, waitForError, waitForText,
} from './wait.mjs'
import { FORMS_PATCH_BLOCK, ROSTER_PATCH_BLOCK } from '../lib/preset-rows.js'
import { SshTui } from '../lib/tui.js'
import { FORMS_HOST } from './host-line.mjs'

const WEB_ROW = "- insert:\n    - id: webserver\n      name: '@deepseek-ai/dsh-host-webserver'\n"

/**
 * The line's own report wording and the rows a repair writes.
 *
 * 0.1.5 reports the missing agent-preset *roster* and the two host services the
 * shipped presets need; 0.1.7 deleted that service, so `/doctor` judges the
 * agent-plane rows the profile mounts itself instead. The tests below are about
 * the repair and backup behaviour, not the wording, so only what the report
 * calls the loss and which rows the fix writes change with the line.
 */
const MISSING_SUMMARY = FORMS_HOST ? '0.1.7 在进程级组合代理' : '名单未组合'
const MISSING_ROW_IDS = FORMS_HOST ? ['tool-ask-user', 'present'] : ['agent-presets']
const REPAIRED_NAMES = FORMS_HOST
  ? ['@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-present']
  : ['@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-code-runtime-worker-thread']
/** Modules the other line's repair writes, and this one must never add. */
const OTHER_LINE_NAMES = FORMS_HOST
  ? ['@deepseek-ai/dsh-agent-presets', '@deepseek-ai/dsh-code-runtime-worker-thread', '@deepseek-ai/dsh-persona']
  : ['@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-present']
/** A row the first repair lands, so the poll cannot read a half-written file. */
const REPAIRED_MARKER = FORMS_HOST ? /dsh-tool-present/u : /subagent-model-selection-settings/u
/** The merged file: the user row, one copy of the block, and this line's rows. */
const MERGED_PATCH = FORMS_HOST
  ? `${WEB_ROW}\n${ROSTER_PATCH_BLOCK}\n${FORMS_PATCH_BLOCK}`
  : `${WEB_ROW}\n${ROSTER_PATCH_BLOCK}`

function fixture(ctxOverrides = {}) {
  const ctx = { get: () => undefined, on() { return () => {} }, ...ctxOverrides }
  const agent = {
    id: 'main-session',
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  return new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
}



/**
 * Read a file the command under test writes, polling instead of sleeping once.
 *
 * The write is a promise chain behind a dialog answer, and the missing-patch
 * path creates two directories first: a fixed 30ms tick lost that race on the
 * Windows runner (the file appeared after the assertion had already read), so
 * the tests wait for the result and report the transcript when it never comes.
 */
async function writtenPatch(path, expect, tui, timeoutMs = 4_000) {
  // A string means "wait until the file is exactly this" — `includes` would
  // also match a file that still carries an extra copy the repair removes,
  // which is the case this test is about. A RegExp waits for a marker.
  const matches = text => (typeof expect === 'string' ? text === expect : expect.test(text))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // `writePatchWithBackup` copies and then truncate-writes, so a single read
    // can land on an empty or half-written file; wait for the content the test
    // is about instead of the first readable bytes.
    const text = await readFile(path, 'utf8').catch(() => '')
    if (matches(text)) return text
    if (Date.now() >= deadline) {
      assert.fail(`no patch matching ${expect} at ${path}\n--- last content ---\n${text}\n--- transcript ---\n${allText(tui)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function withHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-doctor-cmd-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  return home
}

test('/doctor names the missing rows and --fix mounts them behind a backup', async t => {
  setLocale('zh')
  const home = await withHome(t)
  const dir = join(home, 'profiles', 'tui')
  const patch = join(dir, 'cordis.patch.yml')
  await mkdir(dir, { recursive: true })
  await writeFile(patch, WEB_ROW)
  const tui = fixture()

  tui.runCommand('/doctor')
  await waitForText(tui, MISSING_SUMMARY)
  const report = diagText(tui)
  assert.ok(report.includes('/doctor'), report)
  assert.ok(report.includes(MISSING_SUMMARY), report)
  // Every row this line's profile is missing is named, one detail each.
  for (const id of MISSING_ROW_IDS) assert.ok(report.includes(`缺少行：${id}`), report)
  if (!FORMS_HOST) assert.ok(report.includes('code-runtime 未注册'), report)
  assert.ok(report.includes('/doctor --fix'), report)

  tui.runCommand('/doctor --fix')
  await waitForDialog(tui, 'confirm')
  tui.handleChar('y')
  await tick()

  const written = await writtenPatch(patch, REPAIRED_MARKER, tui)
  assert.ok(written.startsWith(WEB_ROW), 'the user row stays first')
  for (const name of REPAIRED_NAMES) assert.ok(written.includes(`name: '${name}'`), written)
  // The repair never writes a row the running line cannot resolve.
  for (const name of OTHER_LINE_NAMES) {
    assert.equal(written.includes(`name: '${name}'`), false, `${name} must not be written on this line:\n${written}`)
  }
  const backups = (await readdir(dir)).filter(name => name.includes('.bak-'))
  assert.equal(backups.length, 1)
  // The fix notice is a system row; the report above it is a diag row. Wait for
  // it rather than reading the transcript straight after the file appeared: the
  // write resolves first, and on a slow runner the rows that report it land a
  // microtask later — the race this wait was added for.
  await waitForText(tui, '重启 TUI 后生效')
  assert.ok(allText(tui).includes('重启 TUI 后生效'), allText(tui))

  // The services stay missing for this launcher, so the report still fails, but
  // a second --fix has nothing left to write.
  tui.runCommand('/doctor --fix')
  await waitForText(tui, '没有需要修复的行')
  assert.equal(await writtenPatch(patch, written, tui), written)
})

test('/doctor reports a duplicate mount by line and --fix merges it', async t => {
  setLocale('zh')
  const home = await withHome(t)
  const dir = join(home, 'profiles', 'tui')
  const patch = join(dir, 'cordis.patch.yml')
  const doubled = `${WEB_ROW}\n${ROSTER_PATCH_BLOCK}${ROSTER_PATCH_BLOCK}`
  await mkdir(dir, { recursive: true })
  await writeFile(patch, doubled)
  const tui = fixture()

  tui.runCommand('/doctor')
  await waitForText(tui, MISSING_SUMMARY)
  const report = diagText(tui)
  assert.ok(report.includes('3 行被挂载两次'), report)
  // The second copy starts after the first block; the detail carries its line.
  const blockLines = ROSTER_PATCH_BLOCK.split('\n').length
  const lines = [...report.matchAll(/第 (\d+) 行：/gu)].map(match => Number(match[1]))
  assert.ok(lines.length >= 3, report)
  assert.ok(Math.min(...lines) > blockLines, `duplicates point past the first copy: ${lines}`)

  tui.runCommand('/doctor --fix')
  await waitForDialog(tui, 'confirm')
  tui.handleChar('y')
  await tick()
  assert.equal(await writtenPatch(patch, MERGED_PATCH, tui), MERGED_PATCH)
})

test('/fix <row> writes one requested row', async t => {
  setLocale('zh')
  const home = await withHome(t)
  const patch = join(home, 'profiles', 'tui', 'cordis.patch.yml')
  const tui = fixture()

  tui.runCommand('/fix nonsense')
  await waitForError(tui, '未知的行名')

  tui.runCommand('/fix code-runtime')
  await waitForDialog(tui, 'confirm')
  tui.handleChar('y')
  await tick()
  const written = await writtenPatch(patch, /code-runtime-worker-thread/u, tui)
  assert.ok(written.includes("name: '@deepseek-ai/dsh-code-runtime-worker-thread'"), written)
  assert.equal(written.includes("name: '@deepseek-ai/dsh-agent-presets'"), false, 'only the requested row is written')
})

test('/mode fix writes the rows this host line owns, never the other line\'s', async t => {
  // Regression: `/mode fix` used to call `ensureRosterRows` with no rows and no
  // generation, so on a 0.1.7 host it wrote the 0.1.5 roster — including a
  // package that has no release on that line at all. The advice `/mode` prints
  // and the rows it writes have to come from the same host-line fact.
  setLocale('zh')
  const home = await withHome(t)
  const dir = join(home, 'profiles', 'tui')
  const patch = join(dir, 'cordis.patch.yml')
  await mkdir(dir, { recursive: true })
  await writeFile(patch, WEB_ROW)
  const tui = fixture()

  tui.runCommand('/mode fix')
  const written = await writtenPatch(patch, REPAIRED_MARKER, tui)
  for (const name of REPAIRED_NAMES) {
    assert.ok(written.includes(name), `${name} must be written on this line\n${written}`)
  }
  for (const name of OTHER_LINE_NAMES) {
    // The quoted form, not a bare substring: the block's own header *names* the
    // persona plugin to explain why it is deliberately not mounted here, and a
    // comment is not a row.
    assert.equal(written.includes(`name: '${name}'`), false, `${name} belongs to the other line\n${written}`)
  }
})

test('/doctor lists two dsh-scope installs from its anchors', async t => {
  setLocale('zh')
  const home = await withHome(t)
  const anchor = join(home, 'app')
  await mkdir(join(anchor, 'node_modules', '@deepseek-ai', 'dsh-scope'), { recursive: true })
  await writeFile(join(anchor, 'node_modules', '@deepseek-ai', 'dsh-scope', 'package.json'), '{}')
  const tui = fixture({ baseUrl: anchor })

  tui.runCommand('/doctor')
  await waitForText(tui, MISSING_SUMMARY)
  const report = diagText(tui)
  assert.ok(report.includes(join(anchor, 'node_modules', '@deepseek-ai', 'dsh-scope')), report)
  // The test runner's own anchor may add the repository's copy; either way the
  // check must not claim a single install while the nested one is visible.
  assert.equal(/只有一份 @deepseek-ai\/dsh-scope/u.test(report), false, report)
})
