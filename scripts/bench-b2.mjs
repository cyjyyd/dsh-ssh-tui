#!/usr/bin/env node
/**
 * B2 performance baseline — the five ticks the freeze record names.
 *
 * B2's rounds each quoted a cost ("20 rows / ~2.9–3.2 KB per tick", "51 frames in
 * 1.2 s"), but those were one-off measurements taken while the work was being
 * done: there was no command that reproduced them, so "did this get slower?" had
 * no answer that did not start from scratch. This is that command.
 *
 * It drives a real `SshTui` in-process (no PTY, no provider, no session file) and
 * measures one *action* per scenario — the frame a reader's action actually pays
 * for — as the median of `--runs` samples:
 *
 *   stream tick   one streamed delta while a long answer is arriving
 *   waiting tick  one repaint while the agent is busy and the clock is moving
 *   screen scroll one PgDn inside a report Screen
 *   picker move   one ↓ inside an open control-plane menu
 *   setup typing  one character into the wizard's own field
 *
 * Bytes are what `paint()` handed to `write()`; **row writes** are the absolutely
 * addressed rows in that frame, and **clears** are the full-screen clears. Those
 * two are the shape of the frame, and they are the numbers the contract is about:
 * an incremental frame repaints a handful of rows and never clears.
 *
 *     node scripts/bench-b2.mjs                # 100x20, 40 runs (default)
 *     node scripts/bench-b2.mjs --runs 100     # a tighter median
 *     node scripts/bench-b2.mjs --json         # machine-readable
 *
 * It reads `lib/`, so run `npm run build` first if you changed `src/`. Absolute
 * milliseconds are this host's; the *ratios* between scenarios and the row/clear
 * counts are what travel between releases.
 *
 * @module dsh-ssh-tui/scripts/bench-b2
 */
import process from 'node:process'

const argv = process.argv.slice(2)
const valueOf = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at === -1 ? fallback : Number(argv[at + 1])
}
const JSON_OUT = argv.includes('--json')
const RUNS = Math.max(5, valueOf('--runs', 40))
const COLUMNS = valueOf('--columns', 100)
const ROWS = valueOf('--rows', 20)

const { setLocale } = await import('../lib/i18n/index.js')
const { SshTui } = await import('../lib/tui.js')
const { represent } = await import('../lib/representation.js')

setLocale('zh')

const plain = line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd()

/** A TUI with `history` rows of mixed transcript, wired to a no-op display. */
function fixture({ history = 200, status = 'idle' } = {}) {
  const ctx = {
    get: name => (name === 'sessionProjections' ? { stateOf: () => ({ questions: { active: [], settled: [] } }) } : undefined),
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session', options: {}, status,
    session: { id: 'main-session', events: [] }, cancel() {}, steer() {}, followup() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  for (let index = 0; index < history; index += 1) {
    switch (index % 4) {
      case 0:
        tui.pushRow(represent('fixture', { kind: 'assistant', text: `第 ${index} 段回答：这是一段中文说明，带有 \`inline code\` 与**强调**，用来代表真实长度的模型输出。` }))
        break
      case 1:
        tui.pushRow(represent('fixture', { kind: 'tool', callId: `call-${index}`, name: 'bash', args: '{"command":"node scripts/check.mjs"}', status: 'ok', output: 'ok', title: 'bash', summary: 'node scripts/check.mjs', expanded: false }))
        break
      case 2:
        tui.pushRow(represent('fixture', { kind: 'tool-result', text: `line ${index}\nline ${index + 1}`, callId: `call-${index}` }))
        break
      default:
        tui.pushRow(represent('fixture', { kind: 'user', text: `用户第 ${index} 次提问：请把这个模块的性能问题找出来，并给出证据。` }))
        break
    }
  }
  return { tui, agent }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/**
 * Feed one keystroke through the production entry and settle it.
 *
 * `handleData` is what a real read reaches, and it holds a half-arrived escape
 * sequence for `INPUT_HOLD_MS` — a PgDn or an arrow key is exactly that shape, so
 * the guard's window has to be closed before the action can be measured.
 */
async function feed(tui, input) {
  tui.handleData(Buffer.from(input))
  tui.inputGuard.release()
  await settle()
}

/**
 * Paint for real, once, and measure what reached the wire.
 *
 * `captureFrame` swaps `write` out; this wraps it instead, so the bytes are the
 * frame the reader's terminal would have received. The action is fed first (when
 * it is input), so each sample is the round trip a keystroke or an event actually
 * costs, not a paint of state a test set directly.
 */
function paint(tui, columns = COLUMNS, rows = ROWS) {
  const written = []
  const real = tui.write.bind(tui)
  tui.write = chunk => { written.push(chunk); real(chunk) }
  const previous = { columns: process.stdout.columns, rows: process.stdout.rows }
  process.stdout.columns = columns
  process.stdout.rows = rows
  const startedAt = process.hrtime.bigint()
  try {
    tui.paint()
  } finally {
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6
    tui.write = real
    process.stdout.columns = previous.columns
    process.stdout.rows = previous.rows
    const frame = written.join('')
    return {
      ms: elapsed,
      bytes: Buffer.byteLength(frame),
      rows: [...frame.matchAll(/\u001b\[(\d+);1H/gu)].length,
      clears: [...frame.matchAll(/\u001b\[H\u001b\[J|\u001b\[2J/gu)].length,
    }
  }
}

const median = values => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Run one scenario's action `RUNS` times and summarise. */
async function measure(setup, action) {
  const built = setup()
  const { tui } = built
  // One warm paint: the first frame of a session builds every row's cache entry,
  // which is a startup cost, not the cost of the action being measured.
  paint(tui)
  const samples = []
  for (let index = 0; index < RUNS; index += 1) {
    const input = action(built, index)
    if (typeof input === 'string') await feed(tui, input)
    samples.push(paint(tui))
  }
  return {
    ms: median(samples.map(sample => sample.ms)),
    bytes: median(samples.map(sample => sample.bytes)),
    rows: median(samples.map(sample => sample.rows)),
    clears: samples.reduce((total, sample) => total + sample.clears, 0),
    samples: samples.length,
  }
}

const scenarios = [
  {
    id: 'stream-tick',
    what: 'one streamed delta while an answer is arriving',
    setup: () => fixture({ history: 200, status: 'running' }),
    action: (built, index) => {
      const { tui, agent } = built
      if (index === 0) {
        tui.handleAssistantStream({ agent, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } })
      }
      tui.handleAssistantStream({
        agent,
        frame: {
          type: 'chunk', attemptId: 'a1', revision: 1, index,
          time: Date.now(),
          chunk: { type: 'text-delta', index, text: '流式输出片段，带标点与英文 tail。' },
        },
      })
      return undefined
    },
  },
  {
    id: 'waiting-tick',
    what: 'one repaint while the agent is busy (the wait card’s clock)',
    setup: () => fixture({ history: 200, status: 'running' }),
    action: (built, index) => {
      // The card's clock is what makes it a *tick*: a frame with nothing changed
      // paints nothing, so each sample moves the clock one second — the same
      // repaint a reader sees once a second while the model is thinking.
      built.tui.waitStartedAt = Date.now() - 1_100 - index * 1_100
      return undefined
    },
  },
  {
    id: 'screen-scroll',
    what: 'one page key inside a report Screen (PgDn, then PgUp)',
    setup: () => {
      const built = fixture({ history: 40 })
      built.tui.openScreen({
        kind: 'report',
        title: '基准报告',
        lines: Array.from({ length: 120 }, (_line, index) => ({ kind: 'system', text: `报告第 ${index} 行：一行足够长的正文，用来让报告超过一屏。` })),
        offset: 0,
      })
      return built
    },
    // Alternating direction on purpose: the body's window holds a state the reader
    // is *in*, so measuring one direction only measures the frames until it hits
    // the end and an already-at-the-end frame paints nothing (that is the contract,
    // not a slow path). Both directions are the same navigation cost.
    action: (_built, index) => (index % 2 === 0 ? '\x1b[6~' : '\x1b[5~'),
  },
  {
    id: 'picker-move',
    what: 'one cursor key inside an open control-plane menu (↓, then ↑)',
    setup: () => {
      const built = fixture({ history: 60 })
      const pending = built.tui.askQuestion({
        id: 'pick',
        question: '切换到哪个模型？',
        options: Array.from({ length: 6 }, (_option, index) => ({ label: `模型 ${index + 1}` })),
      }, 0, 1)
      pending.catch(() => undefined)
      return built
    },
    // Same reason as the Screen: a cursor at the end of its list does not move, and
    // a frame that paints nothing is a correct frame — it is just not this cost.
    action: (_built, index) => (index % 2 === 0 ? '\x1b[B' : '\x1b[A'),
  },
  {
    id: 'setup-typing',
    what: 'one character into the wizard’s own field',
    setup: () => {
      const built = fixture({ history: 20 })
      built.tui.onboarding = {
        step: 'id', providerType: 'official', providerId: '', baseUrl: '', key: '', models: [],
        catalogPresets: undefined, catalog: undefined, providerCursor: 0, saving: false,
        field: '', fieldCursor: 0, resolve() {},
      }
      built.tui.openScreen({ kind: 'setup', title: '首次配置', lines: [], offset: 0 })
      return built
    },
    action: (_built, index) => String.fromCharCode(97 + (index % 26)),
  },
]

const report = []
for (const scenario of scenarios) {
  const result = await measure(scenario.setup, scenario.action)
  report.push({ id: scenario.id, what: scenario.what, ...result })
}

// The assertion travels with the numbers: a scenario that clears the screen is a
// regression whatever the milliseconds say (B2's whole claim is the incremental
// frame), so the exit code does not depend on which output format was asked for.
const clears = report.reduce((total, entry) => total + entry.clears, 0)

if (JSON_OUT) {
  console.log(JSON.stringify({ columns: COLUMNS, rows: ROWS, runs: RUNS, clears, scenarios: report }, null, 2))
} else {
  console.log(`B2 performance baseline — ${COLUMNS}×${ROWS}, median of ${RUNS} runs`)
  console.log('')
  console.log('  scenario        ms      bytes   rows   clears   what')
  for (const entry of report) {
    console.log(`  ${entry.id.padEnd(14)} ${entry.ms.toFixed(2).padStart(6)}  ${String(entry.bytes).padStart(6)}  ${String(entry.rows).padStart(5)}  ${String(entry.clears).padStart(6)}   ${entry.what}`)
  }
  console.log('')
  console.log(clears === 0
    ? 'OK: every measured action was incremental (no full clear)'
    : `FAIL: ${clears} full clear(s) across the measured actions`)
}
process.exit(clears === 0 ? 0 : 1)
