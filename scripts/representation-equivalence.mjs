#!/usr/bin/env node
/**
 * Behaviour equivalence harness for B2.3a.
 *
 * The metadata round is supposed to change nothing a reader can see. This drives one
 * fixed scenario list through a build and prints what the frame looked like at each
 * step, so two builds can be diffed:
 *
 *     node scripts/representation-equivalence.mjs ../lib/tui.js > after.txt
 *     node scripts/representation-equivalence.mjs .probe-home/b22-baseline/lib/tui.js > before.txt
 *     diff before.txt after.txt
 *
 * The frames are stripped of escapes and hashed, and the row kinds/sources are
 * printed beside them, so a difference is either a visible change (text) or a
 * representation change (kind/source) — the two things the round must not alter
 * (metadata *source ids* do not exist in the baseline, which is why the second line
 * is compared only for kinds).
 *
 * @module dsh-ssh-tui/scripts/representation-equivalence
 */
import process from 'node:process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const target = resolve(process.argv[2] ?? '../lib/tui.js')

// Freeze the clock: several surfaces are *meant* to animate (spinners, an elapsed
// second, a plan's clock), so without this the harness reports those scenarios as
// different on every run — including two runs of the same build. A frozen clock
// makes the comparison about the frame's content instead of the time of day.
const FROZEN_NOW = 1_700_000_000_000
const realNow = Date.now
Date.now = () => FROZEN_NOW
process.on('exit', () => { Date.now = realNow })
const { SshTui } = await import(pathToFileURL(target).href)

const plain = line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd()
const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 12)

function fixture() {
  const changes = {
    summary: () => ({ files: [{ path: 'a.ts', display: 'a.ts', added: 3, deleted: 1 }], total: 1, added: 3, deleted: 1 }),
    diff: async () => undefined,
  }
  const state = { questions: { active: [], settled: [] } }
  const ctx = {
    get: name => {
      if (name === 'sessionProjections') return { stateOf: () => state }
      if (name === 'commands') return { list: () => [] }
      if (name === 'workspaceChanges') return changes
      return undefined
    },
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
    followup: async () => {},
    steer: async () => {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  return { tui, agent }
}

const scenarios = []
const step = async (name, run) => {
  const { tui, agent } = fixture()
  const send = (seq, type, data) => tui.handleSessionEvent(agent.session, { type, seq, time: 1_700_000_000_000 + seq, data })
  await run({ tui, agent, send })
  await new Promise(resolve => setTimeout(resolve, 20))
  const frame = tui.captureFrame(100, 24).map(plain).join('\n')
  scenarios.push({ name, digest: digest(frame), kinds: tui.rows.map(row => row.kind).join(','), lines: frame.split('\n').length })
}

await step('boot only', async () => {})
await step('user turn', async ({ send }) => {
  send(1, 'user/message', { content: [{ type: 'text', text: '把 staging 的构建修好' }], source: { kind: 'user' } })
})
await step('assistant reply', async ({ send }) => {
  send(1, 'user/message', { content: [{ type: 'text', text: '把 staging 的构建修好' }], source: { kind: 'user' } })
  send(2, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '先看失败的那一步。' }] } })
})
await step('tool round trip', async ({ send }) => {
  send(1, 'user/message', { content: [{ type: 'text', text: '跑构建' }], source: { kind: 'user' } })
  send(2, 'tool/call', { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm build' }) })
  send(3, 'tool/result', { message: { role: 'tool', source: { callId: 'c1' }, content: [{ type: 'text', text: 'failed' }] }, isError: false })
})
await step('turn failure', async ({ send }) => {
  send(1, 'user/message', { content: [{ type: 'text', text: '跑一下' }], source: { kind: 'user' } })
  send(2, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: '模型不可用' } } })
})
await step('plan mode and todos', async ({ send }) => {
  send(1, 'plan/mode', { active: true })
  send(2, 'todo/write', { todos: [{ content: '找到失败的步骤', status: 'in_progress' }] })
})
await step('workspace changes card', async ({ send }) => {
  send(1, 'workspace/changes', { turn: 3 })
})
await step('theme switch (display feedback)', async ({ tui }) => {
  tui.runCommand('/theme mono')
})
await step('help report (line mode path not used here)', async ({ tui }) => {
  tui.runCommand('/status')
})
await step('streaming tail', async ({ tui }) => {
  tui.streaming = { reasoning: '先想一想', text: '正在写的回复内容 '.repeat(4) }
  tui.agent.status = 'running'
})
await step('wait card', async ({ tui }) => {
  tui.waitStartedAt = 1_700_000_000_000
  tui.agent.status = 'running'
})
await step('question dialog open', async ({ tui }) => {
  const pending = tui.handleUserQuestions({ questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }, { label: '生产' }] }] })
  pending.catch(() => undefined)
})
await step('compact view', async ({ tui, send }) => {
  tui.setWorkspaceView('compact')
  send(1, 'user/message', { content: [{ type: 'text', text: '紧凑视图' }], source: { kind: 'user' } })
  send(2, 'tool/call', { callId: 'c9', name: 'bash', arguments: JSON.stringify({ command: 'ls' }) })
})

for (const scenario of scenarios) {
  process.stdout.write(`${scenario.name.padEnd(34)} ${scenario.digest}  lines=${scenario.lines}  ${scenario.kinds}\n`)
}
process.exit(0)
