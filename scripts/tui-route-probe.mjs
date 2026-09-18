#!/usr/bin/env node
/**
 * Real-PTY probe for per-session routes: a resumed conversation must come back
 * on the supplier it was actually using (`$DSH_HOME/tui-session-routes.json`),
 * and the running session must keep that record current.
 *
 * The unit tests cover the store, the launch waterfall and the TUI's reporting;
 * what none of them can reach is the launcher wiring — reading the record before
 * the agent is built, applying the subagent route in memory, and writing the file
 * when a route settles. That is what this probe drives, over a real terminal:
 *
 *   1. boot a throwaway home whose global default (`settings.yaml`) names a
 *      *different* model from the session's record, so precedence is visible;
 *   2. resume that session and assert the notice names the recorded parent route
 *      (model and effort) and the recorded subagent pin;
 *   3. run a turn — proof the resumed route is what actually serves;
 *   4. assert the record was not rewritten while nothing moved;
 *   5. `/submodel <model>` and assert the file follows, inside the restored pin.
 *
 * Usage:
 *   node scripts/tui-route-probe.mjs [--keep]
 *
 * Exit code 0 means every assertion passed; captured output is printed on
 * failure. node-pty and the mock server are devDependencies: without either,
 * the probe skips instead of failing.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import process from 'node:process'

const require = createRequire(import.meta.url)
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `usage: node scripts/tui-route-probe.mjs [--keep]

  --keep   keep the throwaway DSH_HOME (printed on start)

Resumes a session that has a recorded route and asserts the record is what the
resumed window runs on, then that the running session keeps the record current.`

async function loadModule(name) {
  try {
    return await import(name)
  } catch {
    return undefined
  }
}

/** A profile that mounts this plugin and nothing else, plus a global default. */
async function synthesizeHome() {
  const home = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'dsh-tui-route-'))
  const profile = join(home, 'profiles', 'tui')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-tui-route-probe',
    private: true,
    dependencies: { 'dsh-ssh-tui': `link:${ROOT}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-ssh-tui'] } },
  }, null, 2)}\n`)
  await writeFile(join(profile, 'cordis.yml'), '[]\n')
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  await symlink(ROOT, join(profile, 'node_modules', 'dsh-ssh-tui'), 'dir')
  // The global default deliberately differs from the session's record: the
  // notice must name the record, or precedence is broken.
  await writeFile(join(home, 'settings.yaml'), [
    'agent-default-model:',
    '  provider: deepseek-official',
    '  model: deepseek-v4-flash',
    '',
  ].join('\n'))
  return home
}

async function runProbe({ keep }) {
  const pty = await loadModule('node-pty')
  if (pty === undefined) {
    console.log('SKIP: node-pty is unavailable, so the TUI cannot be driven on a PTY here')
    return 0
  }
  const mockModule = await loadModule('@deepseek-ai/dsh-llm-mock-server')
  if (mockModule === undefined || typeof mockModule.startMockLlmServer !== 'function') {
    console.log('SKIP: @deepseek-ai/dsh-llm-mock-server is not installed')
    return 0
  }

  const home = await synthesizeHome()
  const mock = await mockModule.startMockLlmServer({
    port: 0,
    apiKey: 'sk-tui-route-probe',
    sequence: ['success'],
    successText: 'ROUTE-PROBE-OK',
    repeatLast: true,
  })
  const sessionId = `main-session-${randomUUID()}`
  const routePath = join(home, 'tui-session-routes.json')
  await writeFile(routePath, `${JSON.stringify({
    version: 1,
    entries: {
      [sessionId]: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
        subagent: { provider: 'xai', model: 'grok-4.5' },
        updatedAt: 1,
      },
    },
  }, null, 2)}\n`)

  console.log(`probe home: ${home}${keep ? ' (kept)' : ''}`)
  console.log(`probe session: ${sessionId}`)
  console.log(`mock model: ${mock.baseURL}`)

  const env = {
    ...process.env,
    DSH_HOME: home,
    TERM: 'xterm-256color',
    DSH_TUI_NO_UPDATE_CHECK: '1',
    SSH_CONNECTION: '10.0.0.2 55555 10.0.0.1 22',
    SSH_TTY: '/dev/pts/9',
    DEEPSEEK_BASE_URL: mock.baseURL,
    DEEPSEEK_API_KEY: 'sk-tui-route-probe',
    NO_COLOR: '',
    DSH_TUI_COLOR_DEPTH: 'truecolor',
  }
  const term = pty.spawn(process.execPath, [CLI, '--profile', 'tui', `--resume=${sessionId}`], {
    name: 'xterm-256color',
    cols: 110,
    rows: 30,
    cwd: home,
    env,
  })
  let output = ''
  term.onData(chunk => { output += chunk })
  const waitFor = async (needle, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (output.includes(needle)) return true
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return false
  }
  /** The log without escapes, one line per painted row. */
  const plain = () => output
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, '')
    .replace(/\x1b\][^\x07]*\x07/gu, '')

  let failures = 0
  const check = (ok, what) => {
    if (ok) {
      console.log(`ok   ${what}`)
      return
    }
    failures += 1
    console.log(`FAIL ${what}`)
  }
  const readRoute = async () => {
    const file = JSON.parse(await readFile(routePath, 'utf8'))
    return file.entries[sessionId]
  }

  try {
    check(await waitFor('已按本会话记录恢复路由'), 'the resumed session says which route it came back on')
    const notice = plain().split('\n').find(line => line.includes('已按本会话记录恢复路由')) ?? ''
    console.log(`     ${notice.trim().slice(0, 120)}`)
    check(notice.includes('deepseek-official/deepseek-v4-pro'), 'the record beats the global default model')
    check(notice.includes('max'), 'the recorded effort travels with the route')
    check(notice.includes('xai/grok-4.5'), 'the recorded subagent pin comes back too')

    term.write('say something\r')
    check(await waitFor('ROUTE-PROBE-OK'), 'the turn runs on the resumed route')
    await new Promise(resolve => setTimeout(resolve, 1_000))
    const afterTurn = await readRoute()
    check(afterTurn?.model === 'deepseek-v4-pro', 'the record still names the session route after a turn')
    check(afterTurn?.updatedAt === 1, 'a route that did not move is not rewritten')

    // Move the subagent route while the window is open: the record must follow,
    // and the bare `/submodel <model>` form must keep the restored pin.
    term.write('/submodel deepseek-v4-flash\r')
    await new Promise(resolve => setTimeout(resolve, 3_000))
    const moved = await readRoute()
    check((moved?.updatedAt ?? 0) > 1, 'a settled route is written while the session runs')
    check(moved?.subagent?.model === 'deepseek-v4-flash' && moved?.subagent?.provider === 'xai',
      'the subagent model moved inside the restored xai pin')
    check(moved?.model === 'deepseek-v4-pro', 'a subagent change leaves the parent route alone')

    term.write('/exit\r')
    await waitFor('To resume this session', 10_000)
  } finally {
    term.kill()
    await mock.close()
    if (!keep) await rm(home, { recursive: true, force: true })
  }
  console.log(failures === 0 ? 'session-route probe: PASS' : `session-route probe: FAIL (${failures})`)
  if (failures > 0) console.log(`--- captured output ---\n${plain()}`)
  return failures === 0 ? 0 : 1
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}
process.exit(await runProbe({ keep: args.includes('--keep') }))
