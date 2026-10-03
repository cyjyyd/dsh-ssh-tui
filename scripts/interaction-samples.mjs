#!/usr/bin/env node
/**
 * What the interaction region looks like, and what it does to the transcript.
 *
 * B1.1's claim is not visible in a single screenshot — the point is what *did not*
 * change. So each sample prints the frame twice: the base (what the reader had) and
 * the same frame with the interaction up, with the window anchor beside both and a
 * marker on every row the interaction replaced.
 *
 *     node scripts/interaction-samples.mjs            # 72 / 120 cols, 20 rows
 *     node scripts/interaction-samples.mjs --short    # height 12 and 10 as well
 *     node scripts/interaction-samples.mjs --all      # every combination
 *
 * Not part of the suite: this is the human-readable acceptance artifact.
 *
 * @module dsh-ssh-tui/scripts/interaction-samples
 */
import process from 'node:process'

const argv = process.argv.slice(2)
const has = flag => argv.includes(flag)
const { SshTui } = await import('../lib/tui.js')

const QUESTION = {
  id: 'q1',
  question: '要部署到哪个环境？',
  options: [{ label: '预发' }, { label: '生产' }],
}

const PLAN_REVIEW = {
  id: 'plan-review',
  header: 'Plan review',
  question: 'Approve this plan and leave plan mode?',
  detail: ['# 修复构建', '', '1. 找到失败的步骤', '2. 修掉它', '3. 重新跑测试'].join('\n'),
  options: [{ label: 'Approve and run' }, { label: 'Keep planning' }],
  intent: { kind: 'plan-review', approve: 'Approve and run', callId: 'call-plan' },
}

const state = () => ({
  questions: {
    active: [{ callId: 'call-q1', questions: [{ id: 'q1', question: QUESTION.question }], state: 'open' }],
    settled: [],
  },
})

function fixture() {
  const projections = state()
  const ctx = {
    get: name => (name === 'sessionProjections' ? { stateOf: () => projections } : undefined),
    on() { return () => {} },
  }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  tui.pushRow({ kind: 'user', text: '❯ 把 staging 的构建修好' })
  tui.pushRow({ kind: 'assistant', text: '先看失败的那一步，然后决定要不要动 lockfile。' })
  tui.pushRow({ kind: 'tool', callId: 'c1', name: 'bash', args: '{"command":"pnpm build"}', status: 'ok', output: 'ok', title: 'bash: pnpm build', summary: 'pnpm build' })
  for (let index = 0; index < 40; index += 1) {
    tui.pushRow({ kind: index % 2 === 0 ? 'assistant' : 'user', text: `${index % 2 === 0 ? '回复' : '提问'} ${index}` })
  }
  return tui
}

const plain = line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd()

function paint(tui, columns, rows) {
  const lines = tui.captureFrame(columns, rows).map(plain)
  return {
    lines,
    start: tui.lastTranscriptStart,
    scrollOffset: tui.scrollOffset,
    region: tui.interactionRegion,
    // Model rows, not visible ones: a question's own card is appended when the
    // question arrives, and that append is what moves the window by a line. The
    // layer never does; the two numbers side by side are what tells them apart.
    rows: tui.rows.length,
  }
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

/** One sample: the base frame, then the frame with the surface up, marked. */
async function sample(label, columns, rows, open, prepare = async () => {}) {
  const tui = fixture()
  await prepare(tui)
  const before = paint(tui, columns, rows)
  await open(tui)
  const after = paint(tui, columns, rows)
  const region = after.region
  process.stdout.write([
    '',
    `── ${label} · ${columns}×${rows}`,
    `   window start ${before.start} → ${after.start}` + (before.start === after.start ? '  (unchanged)' : '  *** MOVED ***')
      + `   scrollOffset ${before.scrollOffset} → ${after.scrollOffset}`
      + `   layer ${region === undefined ? 'none' : `${region.rows} rows at ${region.top}`}`,
    `   model rows ${before.rows} → ${after.rows}`
      + (before.rows === after.rows ? '   (no append)' : '   ← a row was appended; that, not the layer, is what moved the window'),
    '',
  ].join('\n'))
  const width = Math.max(...before.lines.map(line => line.length), ...after.lines.map(line => line.length))
  for (let index = 0; index < Math.max(before.lines.length, after.lines.length); index += 1) {
    const left = (before.lines[index] ?? '').padEnd(width)
    const right = after.lines[index] ?? ''
    const covered = region !== undefined && index + 1 >= region.top && index + 1 < region.top + region.rows
    process.stdout.write(`${covered ? '▸' : ' '} ${left}  │  ${right}\n`)
  }
}

const openQuestion = tui => {
  tui.handleUserQuestions({ questions: [QUESTION], wait: { callId: 'call-q1' } }).catch(() => undefined)
  return settle(30)
}
const openApproval = tui => {
  tui.handleApproval({ toolName: 'bash', reason: 'runs a build', agent: { id: 'main-session' } }).catch(() => undefined)
  return settle(30)
}
const openPlanReview = tui => {
  tui.handleUserQuestions({ questions: [PLAN_REVIEW], wait: { callId: 'call-plan' } }).catch(() => undefined)
  return settle(30)
}
const withCard = async tui => {
  tui.handleSessionEvent({ id: 'main-session' }, {
    type: 'tool/call',
    seq: 1,
    time: Date.now(),
    data: {
      callId: 'call-q1',
      name: 'ask_user_question',
      arguments: JSON.stringify({ questions: [{ ...QUESTION, timeout: 60_000 }] }),
    },
  })
  await settle(20)
}

const combos = has('--all')
  ? [[72, 20], [120, 20], [72, 12], [72, 10]]
  : has('--short')
    ? [[120, 20], [72, 20], [72, 12], [72, 10]]
    : [[72, 20], [120, 20]]

for (const [columns, rows] of combos) {
  await sample('normal (no surface)', columns, rows, async () => {})
  await sample('ask-user', columns, rows, openQuestion, withCard)
  await sample('approval', columns, rows, openApproval)
  await sample('plan-review', columns, rows, openPlanReview, withCard)
  await sample('picker (B1.2: the same layer as an interaction)', columns, rows, async tui => {
    tui.askQuestion({ id: 'pick', question: '切换到哪个模型？', options: [{ label: 'deepseek-v4' }, { label: 'grok-4.5' }] }, 0, 1).catch(() => undefined)
    await settle(30)
  })
  await sample('picker · long list', columns, rows, async tui => {
    const options = Array.from({ length: 14 }, (_option, index) => ({ label: `模型 ${index + 1}` }))
    tui.askQuestion({ id: 'pick', question: '切换到哪个模型？', options }, 0, 1).catch(() => undefined)
    await settle(30)
  })
}
process.stdout.write('\n')
process.exit(0)
