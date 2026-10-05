#!/usr/bin/env node
/**
 * README reconnect demo: one real PTY, one real turn, one real hangup, one real
 * reattach — rendered to `docs/screenshots/reconnect.gif`.
 *
 * What the demo has to show, in this order:
 *
 *   1. the agent is working (a streamed reply, painted by the real painter)
 *   2. the display disappears — the window is closed the way this platform closes
 *      it (`scripts/pty-window.mjs`: SIGHUP on POSIX, `ClosePseudoConsole` on
 *      Windows)
 *   3. the Host is still alive and the turn is still running
 *   4. the same command attaches back to it
 *   5. the same session continues — the reply finishes in the new window
 *
 * How it stays honest:
 *
 *   - Every frame except the two narrative cards is captured from a **real
 *     terminal**: a real `dsh --profile tui` in a real PTY, on a throwaway home,
 *     against the mock model server (so it needs no provider key and spends no
 *     tokens). Nothing is drawn by hand and no UI state is invented.
 *   - "The display disappeared" is a caption over the *last frame the window
 *     painted*, not a fabricated screen. The caption says what was measured: the
 *     hangup primitive, and the Host pid that was still answering afterwards —
 *     both read from the real lock file, not asserted by the script.
 *   - The frames carry no credentials, no home paths and no session ids.
 *
 * Reproduce:
 *
 *   npm run build && npm run screenshots:reconnect
 *
 * Requires: node-pty (ships in the harness tree), `@deepseek-ai/dsh-llm-mock-server`,
 * and python3 + ImageMagick for the frames. A machine without any of them gets a
 * `SKIP:` line, never a fabricated GIF.
 *
 * Run it from a checkout whose `node_modules` matches the pin. A workspace carrying an
 * old mock server resolves it happily and then answers every request with 404 on
 * `/messages` (the provider posts the Messages API; the 0.1.5-era mock only served
 * `/chat/completions`), which surfaces as "the turn never started" — measured, and the
 * reason a clean `npm install` is the supported way to regenerate this asset.
 */
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const require = createRequire(import.meta.url)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const OUT_DIR = join(REPO, 'docs', 'screenshots')
const COLS = 88
const ROWS = 30

const { closeWindow, windowDeathNote, IS_WINDOWS } = await import(
  pathToFileURL(join(REPO, 'scripts/pty-window.mjs')).href
)
const { sessionLockLookupPaths } = await import(pathToFileURL(join(REPO, 'lib/session-lock.js')).href)
const { mountProfileRows } = await import(pathToFileURL(join(REPO, 'scripts/profile-rows.mjs')).href)

/**
 * A throwaway home whose `tui` profile links this checkout — the same shape
 * `tui-mock-probe.mjs` boots on, and deliberately **without** a stored credential:
 * a credentials file beats the environment, so a provisioned placeholder key would
 * shadow the mock server's base URL and key and the turn would never reach it
 * (measured: the composer accepted the prompt and nothing happened, no wait card).
 * The mock's key travels in the environment instead, which is also what makes the
 * boot count as configured and keeps the first-run wizard out of the capture.
 */
/**
 * The workspace the demo session runs in. It is a real directory on purpose (the
 * harness is given it as `cwd`), but its *name* is what lands in the captured
 * footer, so it must be a neutral one — a `dsh-reconnect-XXXX` temp name would put
 * a machine-specific path in a README asset.
 */
async function synthesizeWorkspace(home) {
  const workspace = join(home, 'relay-demo')
  await mkdir(workspace, { recursive: true })
  return workspace
}

async function synthesizeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-reconnect-'))
  const profile = join(home, 'profiles', 'tui')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-tui-reconnect',
    private: true,
    dependencies: { 'dsh-ssh-tui': `link:${REPO}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-ssh-tui'] } },
  }, null, 2)}\n`)
  await writeFile(join(profile, 'cordis.yml'), '[]\n')
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  // A directory symlink needs SeCreateSymbolicLinkPrivilege on Windows; a junction
  // needs none and resolves identically.
  await symlink(REPO, join(profile, 'node_modules', 'dsh-ssh-tui'), IS_WINDOWS ? 'junction' : 'dir')
  // The agent-preset roster, or every captured frame carries the boot warning
  // "代理平面行缺失" — a real signal about a real install, and a distraction in a
  // demo whose subject is the reconnect. Mounting it is what `probe-home.mjs` does
  // for the PTY probes; the credential stays out of it (see above).
  mountProfileRows({ profile: 'tui', home, log: message => console.log(`  ${message}`) })
  return home
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function loadModule(name) {
  try {
    const resolved = require.resolve(name, { paths: [process.cwd()] })
    const mod = await import(pathToFileURL(resolved).href)
    return mod.default ?? mod
  } catch {
    return undefined
  }
}

const pty = await loadModule('node-pty')
if (pty === undefined) {
  console.log('SKIP: node-pty is unavailable, so no real terminal can be driven here')
  process.exit(0)
}
const mockModule = await loadModule('@deepseek-ai/dsh-llm-mock-server')
if (mockModule === undefined || typeof mockModule.startMockLlmServer !== 'function') {
  console.log('SKIP: @deepseek-ai/dsh-llm-mock-server is not installed')
  process.exit(0)
}
for (const tool of ['python3', 'convert']) {
  if (spawnSync('command', ['-v', tool], { shell: true, stdio: 'ignore' }).status !== 0) {
    console.log(`SKIP: ${tool} is not on PATH, so the frames cannot be rendered`)
    process.exit(0)
  }
}

/**
 * What the mock model streams.
 *
 * Long enough on purpose: a 30-row window opens on the logo and on the harness's
 * injected runtime context, and the demo must not put either in a README asset —
 * the transcript has to scroll the preamble away *before* the frames are taken
 * (and the injected context names the throwaway workspace path). The numbered
 * lines also make "the stream is still arriving" visible between two frames.
 */
const REPLY_TOKEN = 'RELAY-OK'
const REPLY_TEXT = [
  '## What survives a dropped display',
  '',
  '1. The Host does not exit when the display goes away.',
  '2. The running turn follows `/disconnect`: with `continue` it keeps going.',
  '3. The same `--resume` command attaches back to the same session.',
  '4. Approvals and questions are asked once you are back, not while nobody is there.',
  '5. Queued messages stay queued and are sent in order on reattach.',
  '',
  '---',
  '',
  'Every line on screen comes from this one real session:',
  'no replay, no stitching, no staging.',
  '',
  'Six. The display channel is a unix socket (a named pipe on Windows).',
  'Seven. Frames address rows and repaint what changed; nothing clears the screen.',
  'Eight. A long line is wrapped to the terminal width before it is painted.',
  'Nine. CJK and Latin cells are measured, not guessed.',
  'Ten. Every reattach leaves a line in the transcript saying how long you were away.',
  'Eleven. An unmeasured link says `n/a`, it does not invent a latency.',
  'Twelve. A report is a screen over the workspace; paging repaints the body only.',
  'Thirteen. The plan dock never covers the input row.',
  'Fourteen. A dead display with an idle session lets its Host go.',
  '',
  `${REPLY_TOKEN}: this turn finished while the window was gone.`,
].join('\n')

const CSI = /\x1b\[[0-9;?]*[a-zA-Z]/gu
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu
const plain = text => text.replace(CSI, '').replace(OSC, '')

/**
 * The screen as the terminal holds it, **with** each row's styling kept.
 *
 * The painter addresses rows absolutely (`\x1b[<row>;1H`), so the last write to a
 * row is what the reader sees; an alternate-screen entry or a full clear starts a
 * fresh screen and everything before it is dropped. Rows are returned as styled
 * text for `scripts/ansi-to-png.py`, which is what the slow-link fixture already
 * feeds it.
 */
function styledRows(text) {
  const lastReset = Math.max(text.lastIndexOf('\x1b[?1049h'), text.lastIndexOf('\x1b[2J'))
  const from = lastReset === -1 ? 0 : lastReset
  const rows = new Map()
  const pattern = /\x1b\[(\d+);1H([^\n]*?)(?=\x1b\[\d+;1H|\x1b\[\?7h|$)/gu
  for (const match of text.slice(from).matchAll(pattern)) {
    rows.set(Number(match[1]), (match[2] ?? '').replace(/\x1b\[K/gu, ''))
  }
  const out = []
  for (let row = 1; row <= ROWS; row += 1) out.push(rows.get(row) ?? '')
  return out
}

/** A narrative card: no chrome, a few sentences, rendered like any other frame. */
function cardRows(lines) {
  const rows = Array.from({ length: ROWS }, () => '')
  const start = Math.floor((ROWS - lines.length) / 2)
  for (const [index, line] of lines.entries()) {
    rows[start + index] = line
  }
  return rows
}

function renderPng(rows, pngPath, caption) {
  const ansiPath = `${pngPath.replace(/\.png$/u, '')}.ansi.txt`
  return writeFile(ansiPath, `${rows.join('\n')}\n`)
    .then(() => {
      const result = spawnSync('python3', [join(REPO, 'scripts', 'ansi-to-png.py'), ansiPath, pngPath, caption], { stdio: 'inherit' })
      if (result.status !== 0) throw new Error(`ansi-to-png failed for ${pngPath}`)
    })
}

/**
 * Compose the frames into one GIF. Frame delays are the demo's own pacing: a long
 * beat for the hangup (the reader has to understand the window is gone) and a
 * short one for the stream, so the whole thing lands around 15 seconds.
 */
function buildGif(frames, dest) {
  const args = ['-delay', '0', '-loop', '0']
  for (const frame of frames) {
    args.push('-delay', String(Math.max(8, Math.round(frame.delayMs / 10))), frame.png)
  }
  args.push('-layers', 'optimize', dest)
  const result = spawnSync('convert', args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('convert gif failed')
}

async function hostPid(sessionId, home) {
  for (const path of sessionLockLookupPaths(sessionId, home)) {
    try {
      const lock = JSON.parse(await readFile(path, 'utf8'))
      if (Number.isInteger(lock.pid) && lock.pid > 0) return lock.pid
    } catch {
      // No lock at this name yet.
    }
  }
  return undefined
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function openWindow(sessionId, cwd, env) {
  const term = pty.spawn(process.execPath, [CLI, '--profile', 'tui', `--resume=${sessionId}`], {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd,
    env,
  })
  const window = { term, output: '', exited: undefined }
  term.onData(chunk => { window.output += chunk })
  term.onExit(({ exitCode }) => { window.exited = exitCode })
  window.settle = async (idleMs = 700, maxMs = 20_000) => {
    const deadline = Date.now() + maxMs
    let lastLength = -1
    let lastChange = Date.now()
    while (Date.now() < deadline) {
      if (window.output.length !== lastLength) {
        lastLength = window.output.length
        lastChange = Date.now()
      } else if (Date.now() - lastChange >= idleMs) return true
      await delay(60)
    }
    return false
  }
  window.waitFor = async (predicate, timeoutMs, what) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate(window.output)) return true
      await delay(60)
    }
    throw new Error(`timed out waiting for ${what}\n--- captured ---\n${plain(window.output).slice(-1200)}`)
  }
  return window
}

const sessionId = `main-session-${randomUUID()}`
const home = await synthesizeHome()
const workspace = await synthesizeWorkspace(home)
const frames = []
const notes = []
let windowA
let windowB
let mock

try {
  console.log(`throwaway home: ${home}`)

  // A slow stream, so the turn is genuinely in flight when the window dies.
  mock = await mockModule.startMockLlmServer({
    port: 0,
    apiKey: 'sk-reconnect-capture',
    sequence: ['slow_success'],
    successText: REPLY_TEXT,
    // Fast enough that the frame carries a sane throughput reading and the run
    // stays short: a very slow mock stream renders as `-9 tok/s` and a minute-long
    // elapsed, which reads like a defect in an asset whose subject is the reconnect.
    chunkSize: 8,
    chunkDelayMs: 90,
    repeatLast: true,
  })
  const env = {
    ...process.env,
    DSH_HOME: home,
    TERM: 'xterm-256color',
    // The asset is embedded in README.en.md as well as README.md, and it is read
    // by people who do not read Chinese: the demo runs in English.
    DSH_TUI_LANG: 'en',
    LC_ALL: 'en_US.UTF-8',
    DSH_TUI_NO_UPDATE_CHECK: '1',
    SSH_CONNECTION: '10.0.0.2 55555 10.0.0.1 22',
    SSH_TTY: '/dev/pts/9',
    DEEPSEEK_BASE_URL: mock.baseURL,
    DEEPSEEK_API_KEY: 'sk-reconnect-capture',
    NO_COLOR: '',
    DSH_TUI_COLOR_DEPTH: 'truecolor',
  }

  // ── 1. the agent is working ────────────────────────────────────────────────
  console.log('window A: booting and starting a turn')
  windowA = openWindow(sessionId, workspace, env)
  await windowA.waitFor(text => text.includes('DeepSeek Harness'), 90_000, 'the boot banner')
  await windowA.waitFor(text => /空闲|idle/u.test(text), 90_000, 'the idle status line')
  // The policy the demo is about. On the default (`pause`) a display that goes away
  // *cancels* the in-flight turn — the Host survives, the turn does not — so the
  // frames would show an interrupted stream and "the same session continues" would
  // be a half-truth. `/disconnect continue` is the documented setting for "the turn
  // finishes in the background"; it is typed here, in the captured session, so the
  // transcript itself records which policy the demo ran under.
  windowA.term.write('/disconnect continue\r')
  await windowA.waitFor(
    text => /Disconnect policy|断线策略/u.test(plain(text)),
    30_000,
    'the disconnect confirmation',
  )
  await delay(400)

  windowA.term.write('What survives a dropped display?\r')
  // Wait on the scripted reply's own text rather than on the chrome: the wait card
  // and the streaming verb are localized, and the capture runs the UI in English
  // while the assertion must not care (it has been tripped by exactly that twice).
  await windowA.waitFor(
    text => plain(text).includes('The Host does not exit'),
    90_000,
    'the stream to start',
  )
  // Mid-stream, and far enough in that the window has scrolled past the boot
  // banner and the harness's injected runtime context.
  await windowA.waitFor(text => plain(text).includes('Fourteen. A dead display'), 90_000, 'the stream to reach its fourteenth line')
  await delay(400)
  frames.push({
    rows: styledRows(windowA.output),
    caption: 'a real turn, mid-stream · the display is about to disappear',
    delayMs: 2_600,
  })

  // ── 2. the display disappears ──────────────────────────────────────────────
  const pid = await hostPid(sessionId, home)
  console.log(`window A: ${windowDeathNote('close')}`)
  const lastFrame = styledRows(windowA.output)
  closeWindow(windowA.term)
  for (let wait = 0; wait < 100 && windowA.exited === undefined; wait += 1) await delay(100)
  await delay(1_500)
  const aliveAfterClose = pid !== undefined && isAlive(pid)
  notes.push({ beat: 'window closed', primitive: windowDeathNote('close'), hostPid: pid, hostAlive: aliveAfterClose })
  console.log(`host after the hangup: ${aliveAfterClose ? 'still running (pid alive)' : 'not answering'}`)
  if (!aliveAfterClose) throw new Error('the Host did not survive the hangup, so there is no reconnect to show')
  frames.push({
    rows: lastFrame,
    caption: IS_WINDOWS
      ? 'window closed (ConPTY teardown) · policy: continue · Host alive, turn still streaming'
      : 'window closed (SIGHUP) · policy: continue · Host alive, turn still streaming',
    delayMs: 3_000,
  })

  // ── 3. reattach: the same command, the same session ────────────────────────
  console.log('window B: resuming the same session')
  windowB = openWindow(sessionId, workspace, env)
  await windowB.waitFor(text => text.includes('DeepSeek Harness'), 90_000, 'the boot banner in window B')
  await windowB.waitFor(text => /reconnected|已重连/u.test(text), 90_000, 'the reconnect notice')
  await windowB.settle()
  frames.push({
    rows: styledRows(windowB.output),
    caption: 'the same command attached back to the live Host',
    delayMs: 2_800,
  })

  // ── 4. the same session continues ──────────────────────────────────────────
  await windowB.waitFor(text => plain(text).includes(REPLY_TOKEN), 90_000, 'the reply finishing in window B')
  await windowB.settle()
  frames.push({
    rows: styledRows(windowB.output),
    caption: 'the same turn finished in the new window',
    delayMs: 3_400,
  })

  const hostSurvived = aliveAfterClose && (await hostPid(sessionId, home)) === pid
  notes.push({ beat: 'reattached', sameHost: hostSurvived, replyCompleted: true })
  console.log(`host after the reattach: ${hostSurvived ? 'the same pid as before' : 'a different pid'}`)

  await mkdir(OUT_DIR, { recursive: true })
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-reconnect-frames-'))
  try {
    const gifFrames = []
    for (const [index, frame] of frames.entries()) {
      const pngPath = join(tmp, `${String(index).padStart(2, '0')}.png`)
      await renderPng(frame.rows, pngPath, frame.caption)
      gifFrames.push({ png: pngPath, delayMs: frame.delayMs })
    }
    const gifPath = join(OUT_DIR, 'reconnect.gif')
    buildGif(gifFrames, gifPath)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }

  const report = {
    cols: COLS,
    rows: ROWS,
    frames: frames.length,
    durationMs: frames.reduce((sum, frame) => sum + frame.delayMs, 0),
    scenario: [
      'the session runs with `/disconnect continue`, typed in the captured window: the policy is what makes the turn outlive the display (the default `pause` cancels it on detach, while the Host survives either way)',
      'a real turn is in flight (mock model, no provider key)',
      IS_WINDOWS ? 'the window is closed: ConPTY torn down' : 'the window is closed: SIGHUP to the launcher',
      'the Host answers afterwards (checked against the lock pid)',
      'the same session is resumed and the same turn finishes',
    ],
    captured: 'real PTY, real painter, real hangup, real resume; captions state what was measured',
  }
  await writeFile(join(OUT_DIR, 'reconnect.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
} finally {
  try { windowA?.term.kill() } catch { /* already gone */ }
  try { windowB?.term.kill() } catch { /* already gone */ }
  try { await mock?.close() } catch { /* already closed */ }
  // A Host that is still running has this directory open, and a failing cleanup
  // must never mask the real error from the scenario above.
  try {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch (error) {
    console.log(`note: the throwaway home was left behind (${String(error?.code ?? error)})`)
  }
}
