#!/usr/bin/env node
/**
 * Render README screenshot frames from the live SshTui painter.
 * Usage: node scripts/capture-readme-frames.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { SshTui, padAnsiToWidth } from '../lib/tui.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'docs', 'screenshots')
const COLS = 88
const ROWS = 30

const FINAL_ANSWER = [
  '## 改动',
  '',
  '- 计划条默认折叠，命令选单会让出底栏',
  '- `edit` 用整行底色的 git diff，不再堆 JSON',
  '- 子代理各自一张卡，互不混排',
].join('\n')

function mockAgent(status = 'idle') {
  return {
    id: 'main-session',
    options: { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'xhigh' },
    status,
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
}

function mockCtx() {
  return { get: () => undefined, on() { return () => {} } }
}

function makeTui(status = 'running') {
  process.env.TERM = 'xterm-256color'
  delete process.env.NO_COLOR
  process.stdout.columns = COLS
  process.stdout.rows = ROWS
  const agent = mockAgent(status)
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

function ev(type, data, extra = {}) {
  return { type, time: Date.now(), data, ...extra }
}

function seedWorkspace(tui) {
  tui.handleSessionEvent(tui.agent.session, ev('user/message', {
    content: [{ type: 'text', text: '给 SSH 会话加一个折叠的计划条，编辑工具用 git 风格 diff。' }],
    source: { kind: 'user' },
  }))
  tui.handleSessionEvent(tui.agent.session, ev('assistant/chunk', {
    turn: 1, step: 1,
    chunk: { type: 'reasoning-delta', text: '先看现有 paint() 怎么排底栏，再决定计划条钉在输入框上方。' },
  }))
  tui.handleSessionEvent(tui.agent.session, ev('assistant/message', {
    message: {
      content: [
        { type: 'reasoning', text: '先看现有 paint() 怎么排底栏，再决定计划条钉在输入框上方。' },
        { type: 'text', text: FINAL_ANSWER },
      ],
    },
  }))
  tui.handleSessionEvent(tui.agent.session, ev('tool/call', {
    callId: 'call-bash',
    name: 'bash',
    arguments: JSON.stringify({ command: 'git diff --stat src/tui.ts' }),
  }))
  tui.handleSessionEvent(tui.agent.session, ev('tool/result', {
    message: {
      source: { callId: 'call-bash' },
      content: [{ type: 'text', text: ' src/tui.ts | 42 +++++++---\n 1 file changed, 31 insertions(+), 11 deletions(-)\n\nProcess exited with code 0' }],
    },
  }))
  tui.handleSessionEvent(tui.agent.session, ev('tool/call', {
    callId: 'call-edit',
    name: 'edit',
    arguments: JSON.stringify({
      file_path: 'src/tui.ts',
      old_string: 'this.write(`\\x1b[${i + 1};1H\\x1b[0m${clipped}\\x1b[0m${\' \'.repeat(pad)}\\x1b[K`)',
      new_string: 'this.write(`\\x1b[${i + 1};1H\\x1b[0m${padAnsiToWidth(current, width)}\\x1b[K`)',
    }),
  }))
  tui.handleSessionEvent(tui.agent.session, ev('tool/result', {
    message: {
      source: { callId: 'call-edit' },
      content: [{ type: 'text', text: 'ok' }],
    },
    meta: {
      diffs: [{
        path: 'src/tui.ts',
        oldText: "this.write(`\\x1b[${i + 1};1H\\x1b[0m${clipped}\\x1b[0m${' '.repeat(pad)}\\x1b[K`)",
        newText: 'this.write(`\\x1b[${i + 1};1H\\x1b[0m${padAnsiToWidth(current, width)}\\x1b[K`)',
      }],
    },
  }))
  tui.handleSubagentStart({ runId: 'run-a', id: 'child-scan', provider: 'spawn', local: true })
  tui.handleSubagentSessionEvent('child-scan', ev('tool/call', {
    name: 'grep',
    arguments: JSON.stringify({ pattern: 'padAnsiToWidth', path: 'src' }),
  }))
  tui.handleSubagentStart({ runId: 'run-b', id: 'child-tests', provider: 'spawn', local: true })
  tui.handleSubagentSessionEvent('child-tests', ev('assistant/message', {
    message: { content: [{ type: 'text', text: '正在补回归测试…' }] },
  }))
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
  tui.stats.turns = 1
  tui.stats.steps = 4
  tui.stats.llmMs = 4200
  tui.stats.toolMs = 860
  tui.stats.ttftMs = 380
  tui.stats.ttftSteps = 1
  tui.stats.decodeMs = 2100
  tui.stats.decodeTokens = 640
  tui.stats.usage = { inputTokens: 18200, outputTokens: 640, cacheReadTokens: 12100, cacheWriteTokens: 0 }
  tui.status = 'running'
  tui.input = '继续把隔线铺满，光标贴着字。'
  tui.cursor = tui.input.length
}

function capture(tui) {
  return tui.captureFrame(COLS, ROWS).map(line => padAnsiToWidth(line ?? '', COLS))
}

/**
 * Official `dsh --profile headless` stdout: last assistant text only.
 * Reasoning, tools, subagents, and the plan stay in the session log.
 * Source: @deepseek-ai/dsh-headless summarize() → stdout.write(outcome.text).
 */
function officialHeadlessStdout() {
  const prompt = '$ dsh --profile headless "给 SSH 会话加一个折叠的计划条，编辑工具用 git 风格 diff。"'
  const lines = [prompt, '']
  for (const line of FINAL_ANSWER.split('\n')) lines.push(line)
  lines.push('')
  while (lines.length < ROWS) lines.push('')
  return lines.slice(0, ROWS).map(line => padAnsiToWidth(line, COLS))
}

async function writeFrame(name, lines) {
  await writeFile(join(OUT_DIR, `${name}.ansi.txt`), `${lines.join('\n')}\n`)
}

function renderPng(name, caption) {
  const python = join(ROOT, 'scripts', 'ansi-to-png.py')
  const result = spawnSync('python3', [python, join(OUT_DIR, `${name}.ansi.txt`), join(OUT_DIR, `${name}.png`), caption], {
    stdio: 'inherit',
  })
  if (result.status !== 0) throw new Error(`ansi-to-png failed for ${name}`)
}

function label(input, output, text, color) {
  const args = [
    join(OUT_DIR, input),
    '-gravity', 'North',
    '-background', '#111111',
    '-splice', '0x36',
    '-font', 'Noto-Sans-Mono-CJK-SC',
    '-pointsize', '16',
    '-fill', color,
    '-annotate', '+16+24', text,
    join(OUT_DIR, output),
  ]
  const result = spawnSync('convert', args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`label failed for ${output}`)
}

function montage(inputs, output) {
  const args = [
    join(OUT_DIR, inputs[0]),
    join(OUT_DIR, inputs[1]),
    '-append',
    '-background', '#111111',
    join(OUT_DIR, output),
  ]
  const result = spawnSync('convert', args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`montage failed for ${output}`)
}

const workspace = makeTui('running')
seedWorkspace(workspace)
const workspaceLines = capture(workspace)
const headlessLines = officialHeadlessStdout()

await mkdir(OUT_DIR, { recursive: true })
await writeFrame('workspace', workspaceLines)
await writeFrame('headless', headlessLines)
renderPng('workspace', '')
renderPng('headless', '')
label('headless.png', 'headless-labeled.png', '官方 dsh --profile headless · stdout 只有最后一条助手回复', '#7aa2f7')
label('workspace.png', 'workspace-labeled.png', '同一任务 · dsh-ssh-tui：过程留在终端里', '#9ece6a')
montage(['headless-labeled.png', 'workspace-labeled.png'], 'compare.png')

console.log(`wrote frames to ${OUT_DIR}`)
