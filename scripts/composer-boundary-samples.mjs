#!/usr/bin/env node
/**
 * What the composer's boundary looks like, in every state that can be on screen.
 *
 * B1.2's second claim is that the row between the reader's history and the
 * keyboard is *owned*: it is the composer's top edge, it is drawn in every framed
 * state, and a transient surface stops above it. So each sample prints the bottom
 * of the frame — boundary, composer, footer — with the boundary marked and the
 * layer's extent beside it.
 *
 *     node scripts/composer-boundary-samples.mjs           # 100 / 72 cols, 20 rows
 *     node scripts/composer-boundary-samples.mjs --short   # plus a 10-row terminal
 *
 * Not part of the suite: this is the human-readable acceptance artifact.
 *
 * @module dsh-ssh-tui/scripts/composer-boundary-samples
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

function fixture() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  tui.pushRow({ kind: 'user', text: '❯ 把 staging 的构建修好' })
  tui.pushRow({ kind: 'assistant', text: '先看失败的那一步，然后决定要不要动 lockfile。' })
  for (let index = 0; index < 20; index += 1) {
    tui.pushRow({ kind: index % 2 === 0 ? 'assistant' : 'user', text: `${index % 2 === 0 ? '回复' : '提问'} ${index}` })
  }
  return tui
}

const plain = line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd()
const settle = ms => new Promise(resolve => setTimeout(resolve, ms))

function paint(tui, columns, rows) {
  return { lines: tui.captureFrame(columns, rows).map(plain), region: tui.interactionRegion }
}

const states = [
  ['plain', async () => {}],
  ['ask-user (interaction)', async tui => {
    tui.handleUserQuestions({ questions: [QUESTION], wait: { callId: 'call-q1' } }).catch(() => undefined)
    await settle(30)
  }],
  ['/model (picker)', async tui => {
    const options = Array.from({ length: 9 }, (_option, index) => ({ label: `模型 ${index + 1}` }))
    tui.askQuestion({ id: 'pick', question: '切换到哪个模型？', options }, 0, 1).catch(() => undefined)
    await settle(30)
  }],
  ['slash completion', async tui => {
    tui.handleChar('/')
    for (const char of 'm') tui.handleChar(char)
    await settle(30)
  }],
  ['compact workspace view', async tui => {
    tui.setWorkspaceView('compact')
    await settle(10)
  }],
]

const combos = has('--short') ? [[100, 20], [72, 20], [72, 10]] : [[100, 20], [72, 20]]

for (const [columns, rows] of combos) {
  for (const [label, open] of states) {
    const tui = fixture()
    await open(tui)
    const painted = paint(tui, columns, rows)
    // The composer block: the boundary is the last row above the input line, which
    // is the last line starting with the prompt glyph.
    const boundary = painted.lines.findIndex(line => line.startsWith('╭'))
    const from = Math.max(0, boundary - 2)
    process.stdout.write([
      '',
      `── ${label} · ${columns}×${rows}   layer ${painted.region === undefined ? 'none' : `${painted.region.rows} rows at ${painted.region.top}`}`,
      '',
    ].join('\n'))
    for (let index = from; index < painted.lines.length; index += 1) {
      const marker = index === boundary ? '╭▸' : '  '
      process.stdout.write(`${marker} ${String(index + 1).padStart(2)} ${painted.lines[index]}\n`)
    }
  }
}
process.stdout.write('\n')
process.exit(0)
