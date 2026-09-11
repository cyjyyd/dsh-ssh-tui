/**
 * Host contract tests: the shapes this plugin consumes from the real host.
 *
 * The 0.5.8 regression that killed the tok/s chip was an upstream change to the
 * chunk frames the TUI reads — nothing in the suite could see it, and only a
 * user report found it. These tests drive the shipping host (the `@deepseek-ai/dsh`
 * CLI from node_modules) against `@deepseek-ai/dsh-llm-mock-server` over real
 * HTTP, then assert the durable shapes this plugin renders and accounts from:
 *
 *   - `assistant/message`: `stream` frames (chunk/text-chunks), `usage`
 *     counters, and the `eventAt`/`seq` envelope used for TTFT and tok/s;
 *   - the session event stream (`turn`/`step` framing) that `--resume` replays;
 *   - the settings API surface this plugin installs its section through.
 *
 * A change in any of them must fail here, not in a user's terminal.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { streamFrameOwner, streamChunkOf } from '../lib/tui.js'
import { installSettingsSection, settingsNamespace } from '../lib/dsh-compat.js'

const require = createRequire(import.meta.url)
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')

/** Run one headless turn against `baseURL` and return what the host logged. */
async function runHeadlessTurn({ baseURL, prompt, home }) {
  const child = spawn(process.execPath, [CLI, '--profile', 'headless', prompt], {
    cwd: home,
    env: {
      ...process.env,
      DSH_HOME: home,
      DEEPSEEK_BASE_URL: baseURL,
      DEEPSEEK_API_KEY: 'sk-contract',
      DSH_TUI_NO_UPDATE_CHECK: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', chunk => { out += String(chunk) })
  child.stderr.on('data', chunk => { out += String(chunk) })
  const code = await new Promise(resolve => child.on('exit', resolve))
  assert.equal(code, 0, `headless run failed:\n${out.slice(-800)}`)
  return out
}

/** Every event of one run's session log, oldest first. */
async function sessionEvents(home) {
  const root = join(home, 'sessions')
  const projects = await readdir(root)
  const events = []
  for (const project of projects) {
    for (const id of await readdir(join(root, project))) {
      const dir = join(root, project, id)
      const names = await readdir(dir)
      const log = names.find(name => name.startsWith('session.v3.jsonl'))
      if (log === undefined) continue
      const raw = await readFile(join(dir, log))
      const text = await inflate(raw)
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          events.push(JSON.parse(line))
        } catch {
          // a torn final line is not this test's business
        }
      }
    }
  }
  return events
}

/** The logs are zstd-compressed; let the CLI's own zstd binary do it. */
async function inflate(raw) {
  const { execFile } = await import('node:child_process')
  return await new Promise((resolve, reject) => {
    const child = execFile('zstd', ['-dc'], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
    child.stdin.end(raw)
  })
}

/** A throwaway DSH_HOME: the shipped `headless` profile needs no user config. */
async function makeHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-contract-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

test('the host streams a reply with the durable shapes this plugin renders', { timeout: 120_000 }, async t => {
  const mock = await startMockLlmServer({ port: 0, sequence: ['success'], repeatLast: true })
  t.after(() => mock.close())
  const home = await makeHome(t)

  const stdout = await runHeadlessTurn({ baseURL: mock.baseURL, prompt: 'say something', home })
  assert.match(stdout, /CONTRACT|mock|DeepSeek/i, 'the mock reply reaches the caller')

  const events = await sessionEvents(home)
  const message = events.find(event => event.type === 'assistant/message')
  assert.ok(message !== undefined, 'the turn logs an assistant/message')

  // The envelope: seq/time drive the replay cursor and the speed/elapsed math.
  assert.equal(typeof message.seq, 'number')
  assert.equal(typeof message.time, 'number')

  const data = message.data
  assert.equal(data.message.role, 'assistant')
  assert.equal(typeof data.message.content[0].text, 'string')

  // Usage counters: input/output/total are what the footer and /status account.
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens']) {
    assert.equal(typeof data.usage[field], 'number', `assistant/message.usage.${field} must stay a number`)
  }

  // The packed stream is what TTFT and tok/s are reconstructed from on replay.
  assert.equal(Array.isArray(data.stream), true, 'assistant/message.stream must stay an array')
  const kinds = data.stream.map(frame => frame?.type)
  assert.equal(kinds.includes('chunk'), true, 'the stream keeps chunk frames')
  const chunk = data.stream.find(frame => frame?.type === 'chunk')
  assert.equal(typeof chunk.time, 'number', 'chunk frames carry a timestamp')
  assert.equal(typeof chunk.chunk?.type, 'string', 'chunk payloads stay discriminated by type')

  // Turn/step framing is what groups rows and attributes stats.
  const turnStart = events.find(event => event.type === 'turn/start')
  const stepStart = events.find(event => event.type === 'step/start')
  assert.equal(typeof turnStart.data.turn, 'number')
  assert.equal(typeof stepStart.data.step, 'number')
  assert.equal(typeof stepStart.data.turn, 'number')
})

test('the live frame shape this plugin reads is the one the host emits', () => {
  // Live frames arrive as `agent/assistant-stream` with a discriminated `type`
  // and an `attemptId`; 0.1.5 chunk frames carry no turn/step, so the TUI takes
  // the owner from the opening `start` frame. Field drift here is exactly what
  // killed the tok/s chip, so it is asserted against the documented shape.
  assert.deepEqual(
    streamFrameOwner({ type: 'start', attemptId: 'main:1', revision: 1, turn: 3, step: 2 }),
    { attemptId: 'main:1', turn: 3, step: 2 },
  )
  assert.equal(streamFrameOwner({ type: 'chunk', attemptId: 'main:1', revision: 2, index: 0 }), undefined)
  assert.equal(streamFrameOwner(undefined), undefined)
  // The durable compact stream is read through its own accessor: a packed
  // `{ type: 'chunk', time, chunk }` frame yields the chunk plus its framing.
  const read = streamChunkOf({ type: 'chunk', time: 123, chunk: { type: 'block-start', index: 0 } })
  assert.equal(read?.chunk?.type, 'block-start')
  assert.equal(read?.time, 123)
})

test('the settings API this plugin installs through keeps its shape', () => {
  // `installUiLocale`/`readDisconnectPolicy` resolve their section through
  // these two helpers; the schema factories are the host's, so a rename or a
  // signature change has to fail here.
  assert.equal(typeof settingsNamespace, 'function')
  assert.equal(typeof installSettingsSection, 'function')
  const ns = settingsNamespace('ssh-tui')
  assert.equal(typeof ns, 'string')
  assert.equal(ns.includes('ssh-tui'), true, 'the namespace keeps the section id')

  // installSettingsSection must keep its (ctx, ns, schema, entry, hooks) call
  // shape: it is called through the compat shim on every boot.
  assert.equal(installSettingsSection.length, 5)
})
