#!/usr/bin/env node
/**
 * How long a frame takes as the transcript grows.
 *
 * The report was behavioural — "rendering feels slower and slower in a long
 * session" — so the first thing worth knowing is which operation grows with the
 * number of rows, and by how much. This builds a synethic transcript of a given
 * size and times three things a session actually does all day:
 *
 *   1. ingest    — appending one row (every token batch during a turn),
 *   2. keystroke — the incremental paint after typing a character,
 *   3. full      — a whole repaint (`/clear`-sized work: resize, theme change).
 *
 *     node scripts/bench-render.mjs                 # 500 / 2000 / 8000 / 20000 rows
 *     node scripts/bench-render.mjs --rows 50000    # one size
 *     node scripts/bench-render.mjs --profile       # same, with a CPU profile
 *
 * It prints the median of several runs, because a single sample of a GC-heavy
 * path is noise. Nothing here touches a profile or a real session.
 *
 * @module dsh-ssh-tui/scripts/bench-render
 */
import process from 'node:process'

const argv = process.argv.slice(2)
const valueOf = flag => {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}

const { SshTui } = await import('../lib/tui.js')

/** Representative rows: prose, a tool card, a diff, reasoning, a user turn. */
function rowsFor(count) {
  const rows = []
  for (let index = 0; index < count; index += 1) {
    switch (index % 5) {
      case 0:
        rows.push({
          kind: 'assistant',
          text: `第 ${index} 段回答：这是一段中文说明，包含 \`inline code\`、一个列表与一些**强调**文字，用来代表真实的模型输出长度。\n\n- 项目一\n- 项目二\n`,
        })
        break
      case 1:
        rows.push({
          kind: 'tool', callId: `call-${index}`, name: 'bash', args: `node scripts/check-${index}.mjs --flag value`,
          status: 'ok', output: `checking ${index}\nok`, title: `bash: check-${index}`, summary: `node scripts/check-${index}.mjs`, expanded: false,
        })
        break
      case 2:
        rows.push({ kind: 'tool-result', text: `line ${index}\nline ${index + 1}\nline ${index + 2}`, callId: `call-${index}` })
        break
      case 3:
        rows.push({ kind: 'diff-add', text: `+ added line ${index}` })
        rows.push({ kind: 'diff-del', text: `- removed line ${index}` })
        break
      default:
        rows.push({ kind: 'user', text: `用户第 ${index} 次提问：请把这个模块的性能问题找出来，并给出证据。` })
        break
    }
  }
  return rows
}

function fixture() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: true })
  return tui
}

/** Median of `runs` samples of `fn`, in milliseconds. */
function median(runs, fn) {
  const samples = []
  for (let index = 0; index < runs; index += 1) {
    const started = process.hrtime.bigint()
    fn()
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
}

function measure(rowCount) {
  // Capture frames instead of printing them: the byte cost is measured
  // elsewhere (FRAME_BYTE_BUDGETS); here the question is CPU.
  const written = []
  const realWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = chunk => {
    written.push(chunk)
    return true
  }
  try {
    const tui = fixture()
    tui.render = () => {
      // Bypass the timer/budget gates; we want the cost of the work itself.
      if (!tui.dirty || tui.exiting) return
      tui.dirty = false
      tui.paint()
    }

    const rows = rowsFor(rowCount)
    const ingestStarted = process.hrtime.bigint()
    for (const row of rows) tui.pushRow(row)
    const ingestMs = Number(process.hrtime.bigint() - ingestStarted) / 1e6

    const fullMs = median(3, () => {
      written.length = 0
      tui.forceFullPaint = true
      tui.markDirty()
      tui.render()
    })

    const keystrokeMs = median(20, () => {
      written.length = 0
      tui.handleData(Buffer.from('x'))
      tui.markDirty()
      tui.render()
    })

    const scrollMs = median(20, () => {
      written.length = 0
      tui.scrollOffset = Math.min(5, rowCount)
      tui.markDirty()
      tui.render()
    })

    // One more row, i.e. what every token batch of a live turn costs.
    const oneRowMs = median(20, () => {
      tui.pushRow({ kind: 'assistant', text: `追加的一行 ${Math.random()}` })
      tui.markDirty()
      tui.render()
    })

    return { rows: tui.rows.length, ingestMs, fullMs, keystrokeMs, scrollMs, oneRowMs, bytes: written.join('').length }
  } finally {
    process.stdout.write = realWrite
  }
}

const sizes = valueOf('--rows') !== undefined
  ? [Number.parseInt(valueOf('--rows'), 10)]
  : [500, 2000, 8000, 20000]

process.stdout.write('rows        ingest(ms)  full(ms)  keystroke(ms)  scroll(ms)  one-row(ms)\n')
for (const size of sizes) {
  const result = measure(size)
  process.stdout.write(
    `${String(result.rows).padStart(6)}  `
    + `${result.ingestMs.toFixed(1).padStart(10)}  `
    + `${result.fullMs.toFixed(1).padStart(8)}  `
    + `${result.keystrokeMs.toFixed(2).padStart(13)}  `
    + `${result.scrollMs.toFixed(2).padStart(10)}  `
    + `${result.oneRowMs.toFixed(2).padStart(11)}\n`,
  )
}
