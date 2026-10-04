/**
 * Windows leg of the footer acceptance pass: what the status row looks like on
 * each Windows terminal this project supports.
 *
 * A real Windows Terminal cannot be driven from this POSIX host, so this probe
 * does the three things that *are* meaningful without one:
 *
 * 1. it resolves the capability decision each Windows terminal would produce
 *    (`colorDepth`, `asciiFallbackEnabled`, `terminalCapabilities`) through the
 *    same functions the TUI calls, with `platform: 'win32'` forced — so the
 *    /windows/ profile table is exercised rather than assumed; and
 * 2. it paints the real status row with those decisions and prints exactly what
 *    each console would receive, then checks the frame-integrity invariants
 *    (cell width, ASCII-only chrome where declared, accent lowering);
 * 3. it does 1 and 2 for **both link-chip shapes** — a measured round trip and a
 *    link that was never measured — since the delay slot is where a paint
 *    cadence used to be printed as if it were a latency (`52417b9`).
 *
 * The PTY leg that runs on a real Windows runner is `scripts/tui-term-probe.mjs`
 * (its `win32Only` profiles, now including a legacy-codepage console). This probe
 * is the part that can run here, and it is deliberately exhaustive about the
 * combinations instead of sampling one.
 *
 * Usage: node scripts/footer-windows-probe.mjs
 *   exits non-zero when a profile's painted row violates its own capability.
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

const {
  asciiFallbackEnabled,
} = await import(pathToFileURL(join(REPO, 'lib', 'platform.js')).href)
const {
  colorDepth,
} = await import(pathToFileURL(join(REPO, 'lib', 'color-depth.js')).href)
const {
  terminalCapabilities,
} = await import(pathToFileURL(join(REPO, 'lib', 'terminal-caps.js')).href)
const {
  resetAsciiChrome,
  stripAnsi,
  visibleWidth,
} = await import(pathToFileURL(join(REPO, 'lib', 'term-text.js')).href)
const { setLocale } = await import(pathToFileURL(join(REPO, 'lib', 'i18n', 'index.js')).href)
const {
  runtimeStrip,
  formatLinkQualityChip,
} = await import(pathToFileURL(join(REPO, 'lib', 'tui.js')).href)

setLocale(process.env.DSH_TUI_LANG === 'en' ? 'en' : 'zh')

/**
 * The two link-chip shapes (see `52417b9`): a link that was measured prints the
 * measurement, a link that was never measured says so — it must **not** print the
 * paint cadence (160ms) where a round trip belongs. Both are asserted on a
 * Windows console here, because the chip is what the Windows pass is about and
 * the cadence-versus-measurement confusion was reported from the field twice.
 */
const MEASURED_LINK = { kind: 'ssh', intervalMs: 160, probed: true, rttMs: 31 }
const UNMEASURED_LINK = { kind: 'ssh', intervalMs: 160, probed: false }

/**
 * One Windows terminal, as it presents itself to a Node process.
 *
 * The env markers are the ones the terminals really export, and the expectations
 * are what the project's own capability tables say they mean (`docs/windows.md`,
 * `terminal-caps.ts`). `codepage: 'unicode'` is a console whose output code page
 * is UTF-8 (Windows Terminal, Windows 11 conhost); `'legacy'` is a console still
 * on CP437/936, where `platform.ts` swaps the chrome for ASCII.
 */
const PROFILES = [
  {
    name: 'Windows Terminal (WT_SESSION, no TERM)',
    env: { WT_SESSION: '9d0f5b6a-0000-4000-8000-000000000000', COLORTERM: 'truecolor' },
    codepage: 'unicode',
    expect: { depth: 'truecolor', ascii: false, alternateScreen: true, pips: '●●●●', delay: '31ms' },
  },
  {
    name: 'Windows Terminal, no COLORTERM',
    env: { WT_SESSION: '9d0f5b6a-0000-4000-8000-000000000000' },
    codepage: 'unicode',
    expect: { depth: 'truecolor', ascii: false, alternateScreen: true, pips: '●●●●', delay: '31ms' },
  },
  {
    name: 'Windows Terminal over SSH (TERM=xterm-256color)',
    env: {
      WT_SESSION: '9d0f5b6a-0000-4000-8000-000000000000',
      TERM: 'xterm-256color',
      SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22',
    },
    codepage: 'unicode',
    expect: { depth: '256', ascii: false, alternateScreen: true, pips: '●●●●', delay: '31ms' },
  },
  {
    // The field shape: an SSH link whose terminal never answered `CSI 6n`, so
    // nothing was measured. `未测` here, never `160ms`.
    name: 'Windows Terminal over SSH, link never measured',
    env: {
      WT_SESSION: '9d0f5b6a-0000-4000-8000-000000000000',
      TERM: 'xterm-256color',
      SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22',
    },
    codepage: 'unicode',
    link: UNMEASURED_LINK,
    expect: { depth: '256', ascii: false, alternateScreen: true, pips: '○○○○', delay: '未测' },
  },
  {
    name: 'conhost (Windows 10, SESSIONNAME=Console)',
    env: { SESSIONNAME: 'Console' },
    codepage: 'unicode',
    expect: { depth: '8', ascii: false, alternateScreen: true, pips: '●●●●', delay: '31ms' },
  },
  {
    name: 'conhost on a legacy code page (CP437 output)',
    env: { SESSIONNAME: 'Console', DSH_TUI_CODEPAGE: '437' },
    codepage: 'legacy',
    expect: { depth: '8', ascii: true, alternateScreen: true, pips: '****', delay: '31ms' },
  },
  {
    // The same console, with nothing measured: the hollow pips are the honest
    // level, and the ASCII fallback is `o` for them (`●` is `*`, `○` is `o`), so
    // the fallback must render this shape too.
    name: 'conhost on a legacy code page, link never measured (hollow pips are o)',
    env: { SESSIONNAME: 'Console', DSH_TUI_CODEPAGE: '437' },
    codepage: 'legacy',
    link: UNMEASURED_LINK,
    expect: { depth: '8', ascii: true, alternateScreen: true, pips: 'oooo', delay: '未测' },
  },
  {
    name: 'VS Code / PowerShell embedded terminal (TERM_PROGRAM)',
    env: { TERM_PROGRAM: 'vscode', TERM: 'xterm-256color' },
    codepage: 'unicode',
    expect: { depth: '256', ascii: false, alternateScreen: true, pips: '●●●●', delay: '31ms' },
  },
  {
    name: 'A pipe, no console at all (desktop / Electron)',
    env: {},
    codepage: 'unicode',
    expect: { depth: '8', ascii: false, alternateScreen: true, pips: '●●●●', delay: '31ms' },
  },
  {
    name: 'NO_COLOR on Windows Terminal',
    env: { WT_SESSION: '9d0f5b6a-0000-4000-8000-000000000000', NO_COLOR: '1' },
    codepage: 'unicode',
    expect: { depth: 'none', ascii: false, alternateScreen: true, pips: '●●●●', delay: '31ms' },
  },
]

/** The row a Windows session paints, with the decisions that terminal implies. */
function paintRow(profile) {
  // `platform.ts` reads the environment and the platform; `win32` is forced here
  // because that is the branch under test.
  const env = { ...profile.env }
  const ascii = asciiFallbackEnabled(env, 'win32')
  resetAsciiChrome()
  const previous = {}
  for (const key of ['DSH_TUI_ASCII', 'NO_COLOR', 'TERM', 'COLORTERM', 'WT_SESSION', 'SESSIONNAME', 'DSH_TUI_CODEPAGE']) {
    previous[key] = process.env[key]
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
  try {
    resetAsciiChrome()
    const depth = colorDepth(process.env, 'win32')
    const caps = terminalCapabilities()
    const row = runtimeStrip({
      link: profile.link ?? MEASURED_LINK,
      activity: { kind: 'idle', text: '空闲' },
      running: false,
      quota: { remainingPercent: 82, period: 'hourly' },
      context: { usedTokens: 610_000, contextWindow: 1_000_000, percent: 61, level: 'ok' },
      totalTokens: 36_800_000,
      throughput: { settledRate: 158.4, liveChars: 0, fresh: false },
      ascii,
      depth,
      color: depth !== 'none',
    }, 200, ' │ ', '⠹')
    return { ascii, depth, caps, row }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetAsciiChrome()
  }
}

let failures = 0
console.log(`footer windows probe — ${PROFILES.length} profiles, platform forced to win32\n`)
for (const profile of PROFILES) {
  const problems = []
  const { ascii, depth, caps, row } = paintRow(profile)
  const want = (condition, message) => { if (!condition) problems.push(message) }

  want(depth === profile.expect.depth, `colour depth ${depth}, expected ${profile.expect.depth}`)
  want(ascii === profile.expect.ascii, `ascii=${ascii}, expected ${profile.expect.ascii}`)
  want(caps.alternateScreen === profile.expect.alternateScreen,
    `alternate screen ${caps.alternateScreen}, expected ${profile.expect.alternateScreen}`)

  const plainRow = stripAnsi(row)
  want(plainRow.includes(profile.expect.pips), `pips ${JSON.stringify(profile.expect.pips)} not in ${JSON.stringify(plainRow)}`)
  // The link chip, cell by cell: pips and the *delay slot*. An unmeasured link
  // must read `未测`/`n/a` there — printing the paint cadence (160ms) is the
  // defect `52417b9` fixed, and a reader cannot tell a cadence from a latency.
  const chip = /SSH ([●○*o]{4}) (\S+)/u.exec(plainRow)
  want(chip !== null, `no link chip on the row: ${JSON.stringify(plainRow)}`)
  if (chip !== null) {
    want(chip[1] === profile.expect.pips, `chip pips ${JSON.stringify(chip[1])}, expected ${JSON.stringify(profile.expect.pips)}`)
    want(chip[2] === profile.expect.delay, `the chip says ${JSON.stringify(chip[2])}, expected ${JSON.stringify(profile.expect.delay)}`)
    if (profile.link?.probed === false) {
      want(chip[2] !== '160ms', 'the paint cadence is printed where the round trip goes')
    }
  }
  if (profile.expect.ascii) {
    want(!/[●○█░]/u.test(plainRow), `UTF-8 chrome on an ASCII console: ${JSON.stringify(plainRow)}`)
  }
  if (depth === 'none') {
    want(!row.includes('\x1b'), `escape sequences on a NO_COLOR console: ${JSON.stringify(row)}`)
  }
  if (depth === '8') {
    want(!/\x1b\[38;2;/u.test(row), '24-bit colour on an 8-colour console')
  }
  if (depth === '256') {
    want(!/\x1b\[38;2;/u.test(row), '24-bit colour on a 256-colour console')
  }
  // The row must fit whatever the console width is; `visibleWidth` is the same
  // measure the painter pads against.
  want(visibleWidth(row) <= 200, `row is ${visibleWidth(row)} cells`)

  if (problems.length === 0) {
    console.log(`  ✓ ${profile.name}`)
    console.log(`      ${plainRow}`)
  } else {
    failures += 1
    console.error(`FAIL: ${profile.name}`)
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(`      row: ${JSON.stringify(plainRow)}`)
  }
}

// The old row's chips must be gone from the default row on every profile, which
// is the point of the pass; this is a second, terminal-independent check.
const goneRow = stripAnsi(paintRow(PROFILES[0]).row)
for (const gone of ['轮 ·', '缓存命中']) {
  if (goneRow.includes(gone)) {
    failures += 1
    console.error(`FAIL: "${gone}" is still on the default row`)
  }
}

console.log(failures === 0
  ? `\nOK: ${PROFILES.length} Windows profiles paint the status row their console can take`
  : `\n${failures} profile(s) failed`)
process.exit(failures === 0 ? 0 : 1)
