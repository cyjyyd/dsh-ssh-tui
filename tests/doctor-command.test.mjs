import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setLocale } from '../lib/i18n/index.js'
import { ROSTER_PATCH_BLOCK } from '../lib/preset-rows.js'
import { SshTui } from '../lib/tui.js'

const WEB_ROW = "- insert:\n    - id: webserver\n      name: '@deepseek-ai/dsh-host-webserver'\n"

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

const tick = () => new Promise(resolve => setTimeout(resolve, 30))
const systemText = tui => tui.rows.filter(row => row.kind === 'system').map(row => String(row.text)).join('\n')
const errorText = tui => tui.rows.filter(row => row.kind === 'error').map(row => String(row.text)).join('\n')

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
  await tick()
  const report = systemText(tui)
  assert.ok(report.includes('/doctor'), report)
  assert.ok(report.includes('名单未组合'), report)
  assert.ok(report.includes('缺少行：agent-presets'), report)
  assert.ok(report.includes('code-runtime 未注册'), report)
  assert.ok(report.includes('/doctor --fix'), report)

  tui.runCommand('/doctor --fix')
  await tick()
  assert.equal(tui.dialog?.kind, 'confirm')
  tui.handleChar('y')
  await tick()

  const written = await readFile(patch, 'utf8')
  assert.ok(written.startsWith(WEB_ROW), 'the user row stays first')
  assert.ok(written.includes("name: '@deepseek-ai/dsh-agent-presets'"), written)
  assert.ok(written.includes("name: '@deepseek-ai/dsh-code-runtime-worker-thread'"), written)
  const backups = (await readdir(dir)).filter(name => name.includes('.bak-'))
  assert.equal(backups.length, 1)
  assert.ok(systemText(tui).includes('重启 TUI 后生效'), systemText(tui))

  // The services stay missing for this launcher, so the report still fails, but
  // a second --fix has nothing left to write.
  tui.runCommand('/doctor --fix')
  await tick()
  assert.ok(systemText(tui).includes('没有需要修复的行'), systemText(tui))
  assert.equal(await readFile(patch, 'utf8'), written)
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
  await tick()
  const report = systemText(tui)
  assert.ok(report.includes('3 行被挂载两次'), report)
  // The second copy starts after the first block; the detail carries its line.
  const blockLines = ROSTER_PATCH_BLOCK.split('\n').length
  const lines = [...report.matchAll(/第 (\d+) 行：/gu)].map(match => Number(match[1]))
  assert.ok(lines.length >= 3, report)
  assert.ok(Math.min(...lines) > blockLines, `duplicates point past the first copy: ${lines}`)

  tui.runCommand('/doctor --fix')
  await tick()
  assert.equal(tui.dialog?.kind, 'confirm')
  tui.handleChar('y')
  await tick()
  assert.equal(await readFile(patch, 'utf8'), `${WEB_ROW}\n${ROSTER_PATCH_BLOCK}`)
})

test('/fix <row> writes one requested row', async t => {
  setLocale('zh')
  const home = await withHome(t)
  const patch = join(home, 'profiles', 'tui', 'cordis.patch.yml')
  const tui = fixture()

  tui.runCommand('/fix nonsense')
  await tick()
  assert.ok(errorText(tui).includes('未知的行名'), errorText(tui))

  tui.runCommand('/fix code-runtime')
  await tick()
  assert.equal(tui.dialog?.kind, 'confirm')
  tui.handleChar('y')
  await tick()
  const written = await readFile(patch, 'utf8')
  assert.ok(written.includes("name: '@deepseek-ai/dsh-code-runtime-worker-thread'"), written)
  assert.equal(written.includes("name: '@deepseek-ai/dsh-agent-presets'"), false, 'only the requested row is written')
})

test('/doctor lists two dsh-scope installs from its anchors', async t => {
  setLocale('zh')
  const home = await withHome(t)
  const anchor = join(home, 'app')
  await mkdir(join(anchor, 'node_modules', '@deepseek-ai', 'dsh-scope'), { recursive: true })
  await writeFile(join(anchor, 'node_modules', '@deepseek-ai', 'dsh-scope', 'package.json'), '{}')
  const tui = fixture({ baseUrl: anchor })

  tui.runCommand('/doctor')
  await tick()
  const report = systemText(tui)
  assert.ok(report.includes(join(anchor, 'node_modules', '@deepseek-ai', 'dsh-scope')), report)
  // The test runner's own anchor may add the repository's copy; either way the
  // check must not claim a single install while the nested one is visible.
  assert.equal(/只有一份 @deepseek-ai\/dsh-scope/u.test(report), false, report)
})
