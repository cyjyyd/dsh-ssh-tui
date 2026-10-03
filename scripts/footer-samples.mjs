#!/usr/bin/env node
/**
 * The status row rendered at the widths and states this pass is specified
 * against, in both locales — the human-readable half of the acceptance record.
 *
 * `capture-footer-frames.mjs` asserts the contracts on a rendered frame;
 * `tests/footer-strip.test.mjs` pins the exact row per width. This script is the
 * one that is meant to be *looked at*: it prints the two footer rows for every
 * state × width × locale, so a reviewer can check the design rather than the
 * assertions, and it is cited from `docs/checkpoints.md`.
 *
 * Usage:
 *   node scripts/footer-samples.mjs                 # every state, 72/88/100/120/160, zh
 *   node scripts/footer-samples.mjs reply en        # one state, in English
 *   node scripts/footer-samples.mjs all zh color    # also dump the raw ANSI row
 */
import { setLocale } from '../lib/i18n/index.js'
import { displayWidth, stripAnsi } from '../lib/term-text.js'

const state = process.argv[2] ?? 'all'
const locale = process.argv[3] ?? 'zh'
const mode = process.argv[4] ?? 'plain'
setLocale(locale)

const { SshTui } = await import('../lib/tui.js')

const WIDTHS = [72, 88, 100, 120, 160]
const ROWS = 24

function makeTui() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  return new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: mode === 'color',
    headlessDisplay: true,
  })
}

const send = (tui, type, data, time = Date.now()) =>
  tui.handleSessionEvent(tui.agent.session, { type, time, data })

/** A settled step with usage, so tok/s and Tok have something real to show. */
function seedSettledStats(tui) {
  const tracker = tui.statsTracker
  const start = Date.now() - 60_000
  tracker.noteStepStart(1, 1, start)
  tracker.noteFirstToken(1, 1, start + 600)
  tracker.recordUsage(1, 1, {
    inputTokens: 46_000, outputTokens: 2_400, cacheReadTokens: 20_000, cacheWriteTokens: 6_000,
    totalTokens: 74_400,
  })
  tracker.settleMessage({ turn: 1, step: 1, time: start + 4_000, firstTokenTime: start + 600, outputTokens: 2_400 })
  tracker.noteStepEnd(1, 1)
}

/** A live stream, through the same frames a real session emits. */
function seedStream(tui, kind, chars, turn, step) {
  const now = Date.now()
  tui.handleSessionEvent(tui.agent.session, {
    type: 'step/start', time: now - 4_000, data: { turn, step },
  })
  tui.handleSessionEvent(tui.agent.session, {
    type: 'turn/start', time: now - 4_000, data: { turn },
  })
  const span = 4_000
  const frames = 24
  const per = Math.max(1, Math.round(chars / frames))
  for (let i = 0; i < frames; i++) {
    tui.handleAssistantStream({
      agent: tui.agent,
      frame: {
        type: 'chunk',
        attemptId: 'a1',
        revision: 1,
        index: i,
        time: now - span + (span * i) / (frames - 1),
        chunk: { type: `${kind}-delta`, index: 0, text: '字'.repeat(per) },
      },
    })
  }
}

function seedQuota(tui, remaining, period = 'hourly') {
  tui.quotaSnapshot = {
    provider: 'deepseek-official',
    plan: 'SuperGrok',
    source: 'supergrok',
    windows: [{ label: 'rolling 5h', period, remainingPercent: remaining }],
  }
}

function seedContext(tui, used, window) {
  tui.contextPressure = {
    usedTokens: used,
    contextWindow: window,
    percent: used / window * 100,
    level: used / window >= 0.95 ? 'danger' : used / window >= 0.8 ? 'warn' : 'ok',
  }
}

function seedLink(tui, rttMs) {
  tui.paintLink = 'ssh'
  tui.paintProbed = rttMs !== undefined
  tui.paintRttMs = rttMs
  tui.paintIntervalMs = rttMs === undefined ? 160 : rttMs < 50 ? 80 : rttMs < 150 ? 160 : 250
}

/**
 * The signals every state starts from.
 *
 * Context pressure is seeded *last* on purpose: `applySessionEvent` recomputes it
 * from live usage on every event (there is no model window in this fixture), so a
 * state that emits events after seeding it would paint a row with no context
 * chip and make the probe look like it had dropped one.
 */
const base = (tui) => {
  seedSettledStats(tui)
  seedQuota(tui, 82)
  seedLink(tui, 31)
  seedContext(tui, 610_000, 1_000_000)
}

const states = {
  idle: (tui) => base(tui),
  reply: (tui) => {
    tui.agent.status = 'running'
    base(tui)
    seedStream(tui, 'text', 600, 2, 2)
    // Last, because a live event recomputes the context pressure from usage.
    seedContext(tui, 610_000, 1_000_000)
  },
  thinking: (tui) => {
    tui.agent.status = 'running'
    base(tui)
    seedStream(tui, 'reasoning', 900, 2, 2)
    seedLink(tui, 140)
    seedContext(tui, 610_000, 1_000_000)
  },
  tool: (tui) => {
    tui.agent.status = 'running'
    send(tui, 'tool/call', {
      turn: 1, step: 2, callId: 'c1', name: 'bold-edit-tool',
      arguments: JSON.stringify({ command: 'npm run build' }),
    })
    base(tui)
    seedLink(tui, 260)
    tui.statsTracker.noteToolStart('c1', Date.now() - 28_000)
    tui.lastActivity = Date.now() - 4_000
  },
  subagent: (tui) => {
    tui.agent.status = 'running'
    tui.activeSubagents.set('s1', { id: 'task-1', provider: 'xai', startedAt: Date.now() - 192_000 })
    base(tui)
    seedLink(tui, 420)
    tui.lastActivity = Date.now()
  },
  waiting: (tui) => {
    tui.agent.status = 'running'
    tui.rows.push({
      kind: 'question',
      id: 'q1',
      question: { question: 'Pick one', options: [{ label: 'a' }] },
      status: 'waiting',
      cursor: 0,
      filter: '',
      expanded: false,
    })
    base(tui)
    tui.waitStartedAt = Date.now() - 9_000
    tui.lastActivity = Date.now() - 9_000
  },
  approval: (tui) => {
    tui.agent.status = 'running'
    // A real approval dialog: the shape `paint` reads, multi-select bookkeeping
    // included, so the probe measures the same frame a session would paint.
    tui.dialog = {
      kind: 'questions',
      cursor: 0,
      filter: '',
      filtering: false,
      selected: new Set(),
      activeQuestion: 0,
      answers: [],
      question: {
        id: 'q2',
        question: 'Run npm run build in the workspace?',
        options: [{ label: 'Allow' }, { label: 'Deny' }],
      },
    }
    base(tui)
    tui.waitStartedAt = Date.now() - 12_000
  },
  'quota-warn': (tui) => {
    base(tui)
    seedQuota(tui, 38)
  },
  'quota-critical': (tui) => {
    base(tui)
    seedQuota(tui, 9)
  },
  'quota-unknown': (tui) => {
    seedSettledStats(tui)
    seedLink(tui, 31)
    tui.hasQuotaSurface = () => true
    seedContext(tui, 610_000, 1_000_000)
  },
  'context-warn': (tui) => {
    base(tui)
    seedContext(tui, 870_000, 1_000_000)
  },
  'context-critical': (tui) => {
    base(tui)
    seedContext(tui, 960_000, 1_000_000)
  },
  'no-telemetry': (tui) => {
    seedLink(tui, 31)
  },
  'no-speed': (tui) => {
    tui.agent.status = 'running'
    tui.streaming = { text: '', reasoning: '' }
    base(tui)
    tui.lastActivity = Date.now()
  },
}

function footerRows(tui, width) {
  const frame = tui.captureFrame(width, ROWS)
  return {
    stripped: frame.slice(-2).map(stripAnsi),
    raw: frame.slice(-2),
  }
}

/**
 * What `/status` prints for the same session.
 *
 * The default row gave up its counters; this is the check that they landed
 * somewhere a user can still read them, in the shape the acceptance list names
 * (turns, steps, tokens, model time, tool time, cache hit, and the throughput
 * accounting with the span it covers).
 */
function statusReport(tui) {
  tui.runCommand('/status')
  const row = tui.rows.at(-1)
  return typeof row?.text === 'string' ? row.text.split('\n') : []
}

const wanted = Object.keys(states).filter(name => state === 'all' || name === state)
for (const name of wanted) {
  console.log(`\n=== ${name} (${locale}, ${mode}) ===`)
  for (const width of WIDTHS) {
    const tui = makeTui()
    states[name](tui)
    const { stripped } = footerRows(tui, width)
    const over = stripped.map(line => displayWidth(line) > width)
    console.log(`${String(width).padStart(3)} | ${stripped[0] ?? ''}${over[0] ? '  <<OVERFLOW>>' : ''}`)
    console.log(`    | ${stripped[1] ?? ''}${over[1] ? '  <<OVERFLOW>>' : ''}`)
  }
}

if (state === 'status' || state === 'all') {
  const tui = makeTui()
  states.idle(tui)
  console.log(`\n=== /status (${locale}) ===`)
  for (const line of statusReport(tui)) console.log(line)
}

if (mode === 'color') {
  console.log('\n=== raw ANSI (idle, 120) ===')
  const tui = makeTui()
  states.idle(tui)
  const { raw } = footerRows(tui, 120)
  for (const line of raw) console.log(JSON.stringify(line))
}
