#!/usr/bin/env node
/**
 * The representation audit, for a human.
 *
 * B2.3a put every transcript line through a policy (`src/representation.ts`), and
 * this prints what a real session ends up carrying: how many lines are history that
 * a replay rebuilds, how many are this Host's own voice, and — the two numbers that
 * must be zero — how many are unclassified, and how many claim to be a live
 * projection while sitting in the transcript.
 *
 *     npm run build && node scripts/representation-audit.mjs
 *
 * Driving a *fixture* session rather than a real one keeps the output stable enough
 * to read, and the interesting part is the shape (which sources exist, what each one
 * is), not the counts. The suite asserts the invariants; this is the readable view.
 *
 * @module dsh-ssh-tui/scripts/representation-audit
 */
import process from 'node:process'

const { SshTui } = await import('../lib/tui.js')
const { REPRESENTATION_POLICY, represent } = await import('../lib/representation.js')
const { setLocale } = await import('../lib/i18n/index.js')

setLocale('zh')

const state = { questions: { active: [], settled: [] } }
const changed = {
  summary: () => ({
    files: [{ path: 'src/tui.ts', display: 'src/tui.ts', added: 30, deleted: 5 }],
    total: 1, added: 30, deleted: 5,
  }),
  diff: async () => undefined,
}
const ctx = {
  get: name => {
    if (name === 'sessionProjections') return { stateOf: () => state }
    if (name === 'commands') return { list: () => [] }
    if (name === 'workspaceChanges') return changed
    return undefined
  },
  on() { return () => {} },
}
const agent = { id: 'audit-session', options: {}, status: 'idle', session: { id: 'audit-session', events: [] }, cancel() {} }
const tui = new SshTui(ctx, agent, { sessionId: 'audit-session', color: false, headlessDisplay: true })
tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
tui.write = () => {}

const event = (data, type) => tui.handleSessionEvent({ id: 'audit-session' }, { type, seq: (event.seq = (event.seq ?? 0) + 1), time: Date.now(), data })

// A session that exercises one of each interesting shape: durable narrative, a
// durable summary (the question card), a display-only card (workspace changes), a
// tool round trip, and control-plane feedback.
event({ content: [{ type: 'text', text: '把 staging 的构建修好' }], source: { kind: 'user' } }, 'user/message')
event({
  message: { role: 'assistant', content: [{ type: 'text', text: '先看失败的那一步。' }] },
  turn: 1,
  step: 1,
}, 'assistant/message')
event({ callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm build' }) }, 'tool/call')
event({
  message: { role: 'tool', source: { callId: 'c1' }, content: [{ type: 'text', text: 'build failed' }] },
  isError: false,
}, 'tool/result')
event({ active: true }, 'plan/mode')
event({ todos: [{ content: '找到失败的步骤', status: 'in_progress' }] }, 'todo/write')
tui.handleSessionEvent({ id: 'audit-session' }, {
  type: 'workspace/changes', seq: 900, time: Date.now(), data: { turn: 1 },
})
// A question the Session still holds: the durable *summary* representation (class C).
tui.handleSessionEvent({ id: 'audit-session' }, {
  type: 'tool/call',
  seq: 901,
  time: Date.now(),
  data: {
    callId: 'q1',
    name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [{ id: 'q1', question: '要部署到哪个环境？', timeout: 60_000 }] }),
  },
})
// Control-plane feedback: this Host's own voice, and never rebuilt by a replay.
tui.pushRow(represent('command-feedback', { kind: 'system', text: '（示例）主题已切换' }))

const audit = tui.representationAudit()
const questions = tui.questionPrimaryAudit()
process.stdout.write([
  'representation audit — fixture session',
  '',
  tui.formatRepresentationAudit(),
  '',
  `policy sources: ${Object.keys(REPRESENTATION_POLICY).length}`,
  // B2.4: one semantic question gets exactly one primary transcript
  // representation, so a generic tool card beside the question card is a
  // duplicate — and duplicates are what the count above is for.
  questions.duplicateCalls.length === 0
    ? `question primaries: ${questions.questionRows} row(s) · duplicate calls: 0 ✓`
    : `question primaries: ${questions.questionRows} row(s) · duplicate calls: ${questions.duplicateCalls.join(', ')} ✗`,
  questions.genericToolRows === 0
    ? 'generic question tool rows: 0 ✓'
    : `generic question tool rows: ${questions.genericToolRows} ✗ (a tool card is standing in for a question)`,
  questions.calls > 0
    ? `ask_user_question calls represented: ${questions.calls}`
    : 'ask_user_question calls represented: 0 (the fixture asks none)',
  audit.unclassified === 0
    ? 'unclassified: 0 ✓'
    : `unclassified: ${audit.unclassified} ✗ (a line reached the transcript without a policy)`,
  audit.liveRows === 0
    ? 'live source rows: 0 ✓'
    : `live source rows: ${audit.liveRows} ✗ (a live projection became a source row)`,
  '',
].join('\n'))
process.exit(0)
