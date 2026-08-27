#!/usr/bin/env node
/**
 * Public slow-link fixture: the same README task, painted with the real
 * 0.3.x incremental protocol, then replayed as if stdout were 2 kB/s SSH.
 *
 * Does not compare skins or other TUIs. Output is a GIF plus a byte ledger
 * so the README can say "what you would see on a jump host".
 *
 * Usage: npm run build && node scripts/capture-slow-link.mjs
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { SshTui, composePaintOutput, padAnsiToWidth } from '../lib/tui.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'docs', 'screenshots')
const COLS = 88
const ROWS = 30
const THROTTLE_BPS = 2048

const TASK = '给 SSH 会话加一个折叠的计划条，编辑工具用 git 风格 diff。'
const THINK = '先看现有 paint() 怎么排底栏，再决定计划条钉在输入框上方。'
const FINAL_ANSWER = [
  '## 改动',
  '',
  '- 计划条默认折叠，命令选单会让出底栏',
  '- `edit` 用整行底色的 git diff，不再堆 JSON',
  '- 子代理各自一张卡，互不混排',
].join('\n')
const OLD_LINE = "this.write(`\\x1b[${i + 1};1H\\x1b[0m${clipped}\\x1b[0m${' '.repeat(pad)}\\x1b[K`)"
const NEW_LINE = 'this.write(`\\x1b[${i + 1};1H\\x1b[0m${padAnsiToWidth(current, width)}\\x1b[K`)'

function ev(type, data) {
  return { type, time: Date.now(), data }
}

function mockCtx() {
  return { get: () => undefined, on() { return () => {} } }
}

function makeTui() {
  process.env.TERM = 'xterm-256color'
  process.env.FORCE_COLOR = '3'
  delete process.env.NO_COLOR
  process.stdout.columns = COLS
  process.stdout.rows = ROWS
  const agent = {
    id: 'main-session',
    options: { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'xhigh' },
    status: 'running',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(mockCtx(), agent, {
    sessionId: 'main-session',
    color: true,
    provider: 'xai',
    presetId: 'standard',
    presetName: '标准模式',
    selectionRef: { current: { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'xhigh' } },
    subagentSelection: { current: { model: 'grok-4.5' } },
  })
  tui.rows.splice(0, tui.rows.length)
  return tui
}

function snapshot(tui) {
  return tui.captureFrame(COLS, ROWS)
}

function applyPaint(prev, next, first) {
  return composePaintOutput({
    width: COLS,
    height: ROWS,
    paintRows: next,
    previousRows: prev,
    sizeChanged: first,
    chromeChanged: false,
    chromeStart: ROWS,
    cursorRow: ROWS,
    cursorColumn: 3,
  })
}

/** Reconstruct a full screen from incremental CSI for PNG snapshots. */
function materialize(prev, next) {
  const rows = Array.from({ length: ROWS }, (_, i) => prev[i] ?? '')
  for (let i = 0; i < ROWS; i++) rows[i] = next[i] ?? ''
  return rows.map(line => padAnsiToWidth(line ?? '', COLS))
}

function runSequence(tui) {
  const paints = []
  let prev = []
  const paint = (label) => {
    const next = snapshot(tui)
    const csi = applyPaint(prev, next, prev.length === 0)
    paints.push({
      label,
      bytes: Buffer.byteLength(csi),
      rows: next.slice(0, ROWS),
    })
    prev = next.slice(0, ROWS)
  }

  tui.handleSessionEvent(tui.agent.session, ev('user/message', {
    content: [{ type: 'text', text: TASK }],
    source: { kind: 'user' },
  }))
  paint('user')

  for (let i = 1; i <= THINK.length; i += 8) {
    tui.handleSessionEvent(tui.agent.session, ev('assistant/chunk', {
      turn: 1, step: 1,
      chunk: { type: 'reasoning-delta', text: THINK.slice(Math.max(0, i - 8), i) },
    }))
    paint(`think-${i}`)
  }

  tui.handleSessionEvent(tui.agent.session, ev('assistant/message', {
    message: {
      content: [
        { type: 'reasoning', text: THINK },
        { type: 'text', text: FINAL_ANSWER },
      ],
    },
  }))
  paint('reply')

  tui.handleSessionEvent(tui.agent.session, ev('tool/call', {
    callId: 'call-bash', name: 'bash',
    arguments: JSON.stringify({ command: 'git diff --stat src/tui.ts' }),
  }))
  paint('bash-run')
  tui.handleSessionEvent(tui.agent.session, ev('tool/result', {
    message: {
      source: { callId: 'call-bash' },
      content: [{ type: 'text', text: ' src/tui.ts | 42 +++++++---\nProcess exited with code 0' }],
    },
  }))
  paint('bash-ok')

  tui.handleSessionEvent(tui.agent.session, ev('tool/call', {
    callId: 'call-edit', name: 'edit',
    arguments: JSON.stringify({
      file_path: 'src/tui.ts',
      old_string: OLD_LINE,
      new_string: NEW_LINE,
    }),
  }))
  paint('edit-run')
  tui.handleSessionEvent(tui.agent.session, ev('tool/result', {
    message: {
      source: { callId: 'call-edit' },
      content: [{ type: 'text', text: 'ok' }],
    },
    meta: { diffs: [{ path: 'src/tui.ts', oldText: OLD_LINE, newText: NEW_LINE }] },
  }))
  paint('edit-ok')

  tui.handleSubagentStart({ runId: 'run-a', id: 'child-scan', provider: 'spawn', local: true })
  tui.handleSubagentSessionEvent('child-scan', ev('tool/call', {
    name: 'grep', arguments: JSON.stringify({ pattern: 'padAnsiToWidth', path: 'src' }),
  }))
  paint('sub-a')
  tui.handleSubagentStart({ runId: 'run-b', id: 'child-tests', provider: 'spawn', local: true })
  tui.handleSubagentSessionEvent('child-tests', ev('assistant/message', {
    message: { content: [{ type: 'text', text: '正在补回归测试…' }] },
  }))
  paint('sub-b')

  tui.handleSessionEvent(tui.agent.session, ev('plan/mode', { active: true }))
  tui.handleSessionEvent(tui.agent.session, ev('todo/write', {
    todos: [
      { content: '钉住计划条，命令选单让出底栏', status: 'completed' },
      { content: '编辑 diff 铺满整行底色', status: 'in_progress' },
      { content: '子代理默认折叠', status: 'pending' },
    ],
  }))
  tui.handleSessionEvent(tui.agent.session, ev('goal/change', {
    operation: 'create',
    goal: { objective: '慢速 SSH 上也能看清编辑和子代理', phase: 'active' },
  }))
  tui.status = 'running'
  tui.input = ''
  paint('plan')
  return paints
}

const KEY_LABELS = new Set(['user', 'think-9', 'reply', 'bash-ok', 'edit-ok', 'sub-b', 'plan'])

function delayForBytes(bytes) {
  return Math.max(80, Math.round(bytes / THROTTLE_BPS * 1000))
}

function renderPng(ansiPath, pngPath, caption) {
  const python = join(ROOT, 'scripts', 'ansi-to-png.py')
  const result = spawnSync('python3', [python, ansiPath, pngPath, caption], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`ansi-to-png failed for ${pngPath}`)
}

function buildGif(frames, dest) {
  const args = ['-delay', '0', '-loop', '0']
  for (const frame of frames) {
    args.push('-delay', String(Math.max(8, Math.round(frame.delayMs / 10))), frame.png)
  }
  args.push('-layers', 'optimize', dest)
  const result = spawnSync('convert', args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('convert gif failed')
}

const tui = makeTui()
const paints = runSequence(tui)
const totalBytes = paints.reduce((sum, item) => sum + item.bytes, 0)
const throttleMs = Math.ceil(totalBytes / THROTTLE_BPS * 1000)
const keyPaints = paints.filter((item, index) => KEY_LABELS.has(item.label) || index === paints.length - 1)

await mkdir(OUT_DIR, { recursive: true })
const tmp = await mkdtemp(join(tmpdir(), 'dsh-slow-link-'))
const gifFrames = []
let prevRows = Array.from({ length: ROWS }, () => '')
try {
  for (const [index, paint] of keyPaints.entries()) {
    const rows = materialize(prevRows, paint.rows)
    const ansiPath = join(tmp, `${String(index).padStart(2, '0')}-${paint.label}.ansi.txt`)
    const pngPath = join(tmp, `${String(index).padStart(2, '0')}-${paint.label}.png`)
    await writeFile(ansiPath, `${rows.join('\n')}\n`)
    const caption = index === 0
      ? `88×30 · 模拟 ${THROTTLE_BPS} B/s SSH · 同一任务逐步出现`
      : ''
    renderPng(ansiPath, pngPath, caption)
    gifFrames.push({ png: pngPath, delayMs: delayForBytes(paint.bytes) + (index === keyPaints.length - 1 ? 1400 : 280) })
    prevRows = rows
  }
  const gifPath = join(OUT_DIR, 'slow-link.gif')
  buildGif(gifFrames, gifPath)
} finally {
  await rm(tmp, { recursive: true, force: true })
}

const report = {
  cols: COLS,
  rows: ROWS,
  throttleBps: THROTTLE_BPS,
  paints: paints.length,
  keyFrames: keyPaints.length,
  bytes: totalBytes,
  throttleMs,
  compared: 'official headless stdout vs this TUI on a throttled SSH pipe; not other TUI skins',
}
await writeFile(join(OUT_DIR, 'slow-link.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
