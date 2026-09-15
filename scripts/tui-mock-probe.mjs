#!/usr/bin/env node
/**
 * Real-PTY probe for a scripted model turn: a synthesized throwaway profile plus
 * a mock OpenAI-compatible server, so the transcript gets an actual assistant
 * reply without a provider key and without spending anyone's tokens.
 *
 * `tui-probe.mjs` runs the user's own profile and deliberately never starts a
 * turn. That leaves the parts of the UI that only exist once a reply is on
 * screen unverified end to end — free-form copy (drag over the reply) and the
 * `/find` highlight. This probe covers exactly those, on a real terminal:
 *
 *   1. boot a throwaway home whose `tui` profile mounts this plugin and nothing
 *      else, then start a turn against the mock model;
 *   2. wait for the scripted reply to be painted;
 *   3. `/find` the token inside it and assert the *token* is the thing wrapped
 *      in reverse video — not the whole card;
 *   4. drag across the reply by feeding the terminal's own mouse reports and
 *      assert the OSC 52 clipboard write carries exactly the dragged text.
 *
 * Usage:
 *   node scripts/tui-mock-probe.mjs [--keep]
 *
 * Exit code 0 means every assertion passed; captured output is printed on
 * failure. node-pty and the mock server are devDependencies: without either,
 * the probe skips instead of failing.
 */
import { lstatSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const ROOT = process.cwd()

const USAGE = `usage: node scripts/tui-mock-probe.mjs [--keep]

  (no args)   synthesize a profile, run a scripted turn, verify copy and find
  --keep      leave the throwaway home behind (its path is printed)`

const CSI = /\x1b\[[0-9;?]*[a-zA-Z]/gu
const OSC = /\x1b\][^\x07]*\x07/gu
const plain = text => text.replace(CSI, '').replace(OSC, '')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A distinctive token inside the reply, so the assertions cannot match chrome. */
const REPLY_TOKEN = 'TOKEN-ALPHA-9'
const REPLY_TEXT = `Deployment notes. Run this first: ${REPLY_TOKEN} --dry-run. Then check the log.`

async function loadModule(name) {
  try {
    return await import(require.resolve(name, { paths: [ROOT] })).then(mod => mod.default ?? mod)
  } catch {
    return undefined
  }
}

/** Decode every OSC 52 clipboard write the terminal received. */
function clipboardWrites(text) {
  const out = []
  const pattern = /\x1b\]52;[^;]*;([A-Za-z0-9+/=]*)\x1b\\/gu
  for (const match of text.matchAll(pattern)) {
    const payload = match[1] ?? ''
    if (payload === '') continue
    out.push(Buffer.from(payload, 'base64').toString('utf8'))
  }
  return out
}

/**
 * The last painted content of each screen row.
 *
 * The painter addresses rows absolutely (`\x1b[<row>;1H`), so the transcript can
 * be reconstructed from the raw stream: that is how the probe knows where the
 * reply sits, which the mouse reports need as coordinates.
 */
function screenRows(text) {
  const rows = new Map()
  const pattern = /\x1b\[(\d+);1H([\s\S]*?)(?=\x1b\[\d+;1H|\x1b\[\?7h|$)/gu
  for (const match of text.matchAll(pattern)) {
    rows.set(Number(match[1]), plain(match[2] ?? ''))
  }
  return rows
}

/** Where `needle` is on the reconstructed screen: a 1-based row and cell column. */
function locateOnScreen(text, needle) {
  for (const [row, line] of screenRows(text)) {
    const at = line.indexOf(needle)
    if (at !== -1) return { row, column: at + 1 }
  }
  return undefined
}

async function synthesizeHome() {
  const home = await mkdtemp('/tmp/dsh-tui-mock-')
  const profile = join(home, 'profiles', 'tui')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-tui-probe',
    private: true,
    dependencies: { 'dsh-ssh-tui': `link:${ROOT}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-ssh-tui'] } },
  }, null, 2)}\n`)
  await writeFile(join(profile, 'cordis.yml'), '[]\n')
  // The plugin's own patch layer: what a real install writes is a superset, but
  // the probe needs no roster to render a reply.
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  await symlink(ROOT, join(profile, 'node_modules', 'dsh-ssh-tui'), 'dir')
  return home
}

async function killHostByLock(sessionId, home) {
  try {
    const lock = JSON.parse(await readFile(join(home, 'tui-locks', `${sessionId}.json`), 'utf8'))
    if (Number.isInteger(lock.pid) && lock.pid > 0) process.kill(lock.pid, 'SIGKILL')
  } catch {
    // No lock or already gone.
  }
}

async function removeSessionDir(home, sessionId) {
  let entries
  try {
    entries = await readdir(join(home, 'sessions'), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await rm(join(home, 'sessions', entry.name, sessionId), { recursive: true, force: true })
  }
}

/** The probe only runs against a home whose state lives in one tree. */
function assertHomeIsCoherent(home) {
  for (const name of ['sessions', 'tui-locks', 'tui-socks']) {
    try {
      if (lstatSync(join(home, name)).isSymbolicLink()) throw new Error(`${name} is a symlink`)
    } catch (error) {
      if (error instanceof Error && error.message === `${name} is a symlink`) throw error
    }
  }
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
  assertHomeIsCoherent(home)
  const mock = await mockModule.startMockLlmServer({
    port: 0,
    apiKey: 'sk-tui-mock-probe',
    sequence: ['success'],
    successText: REPLY_TEXT,
    repeatLast: true,
  })
  const sessionId = `main-session-${randomUUID()}`
  const env = {
    ...process.env,
    DSH_HOME: home,
    TERM: 'xterm-256color',
    DSH_TUI_NO_UPDATE_CHECK: '1',
    SSH_CONNECTION: '10.0.0.2 55555 10.0.0.1 22',
    SSH_TTY: '/dev/pts/9',
    DEEPSEEK_BASE_URL: mock.baseURL,
    DEEPSEEK_API_KEY: 'sk-tui-mock-probe',
    // The probe asserts reverse video, so the run has to be a color terminal:
    // inheriting NO_COLOR would silently switch to the `»` marker path.
    NO_COLOR: '',
  }
  console.log(`probe home: ${home}${keep ? ' (kept)' : ''}`)
  console.log(`probe session: ${sessionId}`)
  console.log(`mock model: ${mock.baseURL}`)

  const term = pty.spawn(process.execPath, [CLI, '--profile', 'tui', `--resume=${sessionId}`], {
    name: 'xterm-256color',
    cols: 110,
    rows: 32,
    cwd: home,
    env,
  })
  let output = ''
  term.onData(chunk => { output += chunk })

  const waitFor = async (predicate, timeoutMs, what) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate(output)) return
      await delay(50)
    }
    throw new Error(`timed out waiting for ${what}\n--- captured ---\n${plain(output).slice(-1500)}`)
  }
  const waitForExit = async timeoutMs => new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    term.onExit(({ exitCode }) => {
      clearTimeout(timer)
      resolve(exitCode)
    })
  })

  const problems = []
  const check = (condition, message) => { if (!condition) problems.push(message) }

  try {
    // 1. Boot, then start a real turn against the scripted model.
    await waitFor(text => text.includes('DeepSeek Harness'), 60_000, 'the boot banner')
    await waitFor(text => /空闲|idle/u.test(text), 60_000, 'the idle status line')
    term.write('describe the deployment\r')
    await waitFor(text => plain(text).includes(REPLY_TOKEN), 60_000, 'the scripted reply')
    console.log('reply painted')

    // 2. `/find` must mark the token, not the card.
    const beforeFind = output.length
    term.write(`/find ${REPLY_TOKEN}\r`)
    await waitFor(
      text => /\x1b\[7m[^\x1b]*TOKEN-ALPHA-9/u.test(text.slice(beforeFind)),
      20_000,
      'the highlighted match',
    )
    const findSlice = output.slice(beforeFind)
    const highlighted = [...findSlice.matchAll(/\x1b\[7m([\s\S]*?)\x1b\[27m/gu)].map(m => plain(m[1] ?? ''))
    check(
      highlighted.includes(REPLY_TOKEN),
      `/find must highlight the token itself, got ${JSON.stringify(highlighted)}`,
    )
    check(
      highlighted.every(span => span.trim() === REPLY_TOKEN || span.includes(REPLY_TOKEN)),
      `/find must not highlight more than the match: ${JSON.stringify(highlighted)}`,
    )

    // 3. Drag across the reply: press on the token, move right, release.
    const at = locateOnScreen(output, REPLY_TOKEN)
    check(at !== undefined, 'the reply must be locatable on the painted screen')
    if (at !== undefined) {
      // Nine cells past the token: the copy must be the dragged range itself,
      // not the line it sits on.
      const dragTail = ' --dry-ru'
      const DRAGGED = `${REPLY_TOKEN}${dragTail}`
      const endColumn = at.column + REPLY_TOKEN.length + dragTail.length
      const beforeDrag = output.length
      term.write(`\x1b[<0;${at.column};${at.row}M`)
      await delay(60)
      term.write(`\x1b[<32;${endColumn};${at.row}M`)
      await delay(120)
      term.write(`\x1b[<0;${endColumn};${at.row}m`)
      await waitFor(text => /52;[^;]*;[A-Za-z0-9+/=]+\x1b/u.test(text.slice(beforeDrag)), 15_000, 'the drag clipboard write')
      const copied = clipboardWrites(output.slice(beforeDrag))
      check(
        copied.includes(DRAGGED),
        `the drag must copy exactly what it covered (${JSON.stringify(DRAGGED)}),`
        + ` got ${JSON.stringify(copied.map(t => t.slice(0, 80)))}`,
      )
      check(
        copied.every(text => !text.includes('DeepSeek Harness')),
        'the drag must not copy the chrome',
      )
      console.log(`drag copied: ${JSON.stringify(copied.at(-1)?.slice(0, 90))}`)
    }

    // 4. The window still exits on its own terms.
    term.write('\x15')
    term.write('/exit\r')
    const exitCode = await waitForExit(15_000)
    check(exitCode === 0, `the probe window must exit on /exit (got ${exitCode ?? 'no exit within 15s'})`)
  } catch (error) {
    problems.push(String(error.message ?? error))
  } finally {
    try { term.kill() } catch { /* already gone */ }
    await mock.close().catch(() => {})
    if (!keep) {
      await killHostByLock(sessionId, home)
      await removeSessionDir(home, sessionId)
      await rm(home, { recursive: true, force: true })
    }
  }

  if (problems.length > 0) {
    console.error('FAIL')
    for (const problem of problems) console.error(`  - ${problem}`)
    return 1
  }
  console.log('OK: a scripted turn was copied by dragging, and /find marked the match itself')
  return 0
}

function parseArgs(argv) {
  const parsed = { keep: false }
  for (const arg of argv) {
    if (arg === '--keep') parsed.keep = true
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}\n${USAGE}`)
      process.exit(2)
    }
  }
  return parsed
}

process.exit(await runProbe(parseArgs(process.argv.slice(2))))
