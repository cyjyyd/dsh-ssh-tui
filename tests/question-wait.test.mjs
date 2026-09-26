import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'

import { setLocale } from '../lib/i18n/index.js'
import { sessionErrPath } from '../lib/display-sock.js'
import {
  clearWaitingMarker,
  mailNotifyCommand,
  notifyCommand,
  notifyMessage,
  notifyShell,
  notifyTargetCommand,
  notifyTargetLabel,
  parseNotifyTarget,
  runNotify,
  waitingMarkerPath,
  wecomNotifyCommand,
  wecomPayload,
  writeWaitingMarker,
} from '../lib/question-wait.js'

/**
 * A question that starts waiting while nobody is attached.
 *
 * The marker is what a jump host shows before the TUI is open again; the
 * command is how the same fact leaves the machine. Both are pinned here
 * without a TUI, because the TUI side only decides *when* to call them.
 */
setLocale('zh')

const question = {
  sessionId: 'main/session',
  count: 1,
  question: '部署到哪个环境？',
  since: Date.parse('2026-09-26T08:00:00Z'),
}

test('the marker sits beside the session stderr log, under the same stem', () => {
  const home = '/tmp/dsh-home'
  const marker = waitingMarkerPath('main/session', home)
  const err = sessionErrPath('main/session', home)
  // `dirname`/`basename` rather than splitting on `/`: the Windows leg runs this
  // same test with backslash separators, where a hand-rolled split silently
  // compares the wrong halves (it did, and this is the fix).
  assert.equal(dirname(marker), dirname(err), 'the marker is a sibling of the stderr log')
  assert.equal(basename(marker), `${basename(err, '.err')}.waiting`, 'named from the same stem')
  // The digest keeps two ids that sanitize to one stem apart, so the marker
  // must carry it too.
  assert.notEqual(waitingMarkerPath('main/session', home), waitingMarkerPath('main_session', home))
})

test('the marker records the question', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-question-wait-'))
  try {
    const ok = await writeWaitingMarker(question, home)
    assert.equal(ok, true)
    const path = waitingMarkerPath(question.sessionId, home)
    const text = readFileSync(path, 'utf8')
    assert.match(text, /^session=main\/session$/mu)
    assert.match(text, /^waiting=1$/mu)
    assert.match(text, /^since=2026-09-26T08:00:00\.000Z$/mu)
    assert.match(text, /^question=部署到哪个环境？$/mu)
    await clearWaitingMarker(question.sessionId, home)
    assert.throws(() => statSync(path), 'answering removes the marker')
    await clearWaitingMarker(question.sessionId, home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a reader in another process never sees a partial marker', async () => {
  // The real reader is a jump-host shell polling `ls`/`cat`, i.e. another
  // process, so that is what this spawns. `writeFile` creates the file before it
  // has content, so an empty sample is expected — the writer's docstring records
  // why the staged-rename version is not an option (Windows refuses to replace a
  // file the reader has open, i.e. it stops updating exactly while it is being
  // read). What must never happen is a marker that is present and half-written:
  // every non-empty sample has to be a whole one.
  const home = mkdtempSync(join(tmpdir(), 'dsh-question-wait-race-'))
  const path = waitingMarkerPath(question.sessionId, home)
  const reader = spawn(process.execPath, ['-e', `
    const { readFileSync } = require('node:fs')
    const [path, ms] = process.argv.slice(1)
    const seen = new Set()
    const deadline = Date.now() + Number(ms)
    do {
      try { seen.add(readFileSync(path, 'utf8')) } catch { /* not there yet */ }
    } while (Date.now() < deadline)
    process.stdout.write(JSON.stringify([...seen]))
  `, path, '1200'], { stdio: ['ignore', 'pipe', 'inherit'] })
  const samples = new Promise((resolve, reject) => {
    let out = ''
    reader.stdout.on('data', chunk => { out += String(chunk) })
    reader.on('error', reject)
    reader.on('close', () => {
      try {
        resolve(JSON.parse(out))
      } catch (error) {
        reject(new Error(`the reader printed ${JSON.stringify(out)}: ${String(error)}`))
      }
    })
  })
  try {
    for (let count = 1; count <= 200; count += 1) {
      assert.equal(await writeWaitingMarker({ ...question, count }, home), true)
    }
    const seen = await samples
    assert.ok(seen.length > 0, 'the reader has to catch the marker at least once for this to mean anything')
    for (const text of seen) {
      if (text === '') continue
      assert.match(
        text,
        /^session=main\/session\nwaiting=\d+\nsince=2026-09-26T08:00:00\.000Z\nquestion=部署到哪个环境？\n$/u,
        `a marker that exists must be whole, got ${JSON.stringify(text)}`,
      )
    }
  } finally {
    reader.kill()
    rmSync(home, { recursive: true, force: true })
  }
})

// Windows cannot express 0o600 — `chmod` there only toggles the read-only bit
// and `stat` reports 0o666/0o444 — and the intent is applied as an `icacls` ACL
// instead, whose effect only the Windows leg can observe
// (tests/platform-permissions.test.mjs asserts that half).
test('the marker is owner-only', { skip: process.platform === 'win32' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-question-wait-'))
  try {
    assert.equal(await writeWaitingMarker(question, home), true)
    assert.equal(statSync(waitingMarkerPath(question.sessionId, home)).mode & 0o777, 0o600)
    assert.equal(statSync(join(home, 'tui-socks')).mode & 0o777, 0o700, 'and so is its directory')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a notify command comes from the environment before settings', () => {
  assert.equal(notifyCommand({}), undefined)
  assert.equal(notifyCommand({ DSH_TUI_NOTIFY: '  ' }, 'mail'), 'mail', 'settings fill in when the env is blank')
  assert.equal(notifyCommand({ DSH_TUI_NOTIFY: '  mail -s x a@b  ' }), 'mail -s x a@b')
  assert.equal(notifyCommand({ DSH_TUI_NOTIFY: 'from-env' }, 'from-settings'), 'from-env')
})

test('mail and wecom are presets of the one command', () => {
  assert.equal(mailNotifyCommand('a@b.c'), `mail -s 'dsh 有提问在等你' -- 'a@b.c'`)
  assert.equal(
    mailNotifyCommand("o'reilly@b.c"),
    `mail -s 'dsh 有提问在等你' -- 'o'\\''reilly@b.c'`,
    'an address is quoted, not spliced',
  )
  const command = wecomNotifyCommand('k e/y')
  assert.match(command, /^curl -fsS -m 10 .* --data-binary @- '/u)
  assert.match(command, /key=k%20e%2Fy'/)
})

test('the message names the session, the wait, and how to come back', () => {
  const text = notifyMessage({
    sessionId: 'main-session', count: 2, question: '继续吗？', waitedMs: 90_000,
    resumeCommand: 'dsh --profile tui --resume main-session',
  })
  assert.match(text, /main-session/)
  assert.match(text, /2 个提问/)
  assert.match(text, /2m/)
  assert.match(text, /继续吗？/)
  assert.match(text, /dsh --profile tui --resume main-session/)
})

test('a wecom payload is the text message the robot expects', () => {
  const payload = JSON.parse(wecomPayload({
    sessionId: 's', count: 1, question: '继续吗？', waitedMs: 0, resumeCommand: 'dsh --resume s',
  }))
  assert.equal(payload.msgtype, 'text')
  assert.match(payload.text.content, /继续吗？/)
})

test('the command gets the message on stdin and the facts in its environment', async () => {
  const seen = []
  const child = new EventEmitter()
  child.stdin = new EventEmitter()
  let written = ''
  child.stdin.end = (data) => { written = String(data); return child.stdin }
  const spawnFn = (command, args, options) => {
    seen.push({ command, args, options })
    queueMicrotask(() => child.emit('exit', 0))
    return child
  }
  await runNotify('mail -s x a@b', {
    sessionId: 'main session', count: 1, question: '继续吗？', waitedMs: 5_000,
    resumeCommand: 'dsh --resume "main session"',
  }, { spawnFn, platform: 'linux' })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].args.slice(0, 2), ['-c', 'mail -s x a@b'])
  assert.equal(seen[0].command, 'sh')
  assert.equal(seen[0].options.env.DSH_TUI_NOTIFY_SESSION, 'main session')
  assert.equal(seen[0].options.env.DSH_TUI_NOTIFY_COUNT, '1')
  assert.equal(seen[0].options.env.DSH_TUI_NOTIFY_QUESTION, '继续吗？')
  assert.equal(seen[0].options.env.DSH_TUI_NOTIFY_WAITED_MS, '5000')
  assert.match(written, /继续吗？/)
  assert.equal(seen[0].options.stdio[1], 'ignore', 'stdout never reaches the transcript')
})

test('a notify command that fails to start does not reject', async () => {
  const child = new EventEmitter()
  child.stdin = new EventEmitter()
  child.stdin.end = () => child.stdin
  await runNotify('nowhere', {
    sessionId: 's', count: 1, question: 'q', waitedMs: 0, resumeCommand: 'dsh',
  }, {
    spawnFn: () => {
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')))
      return child
    },
  })
})

test('/notify parses mail, smtp, the local mailer, and off', () => {
  assert.deepEqual(parseNotifyTarget(''), { kind: 'off' })
  assert.deepEqual(parseNotifyTarget('off'), { kind: 'off' })
  assert.equal(parseNotifyTarget('nope'), undefined)
  assert.equal(parseNotifyTarget('mail not-an-address'), undefined)

  assert.deepEqual(parseNotifyTarget('mail you@example.com'), { kind: 'mail', address: 'you@example.com' })

  const smtp = parseNotifyTarget('smtp mail.example.com from@a.c to@b.c')
  assert.deepEqual(smtp, { kind: 'smtp', host: 'mail.example.com', port: 587, from: 'from@a.c', to: 'to@b.c' })
  const authed = parseNotifyTarget('smtp [2606:4700::1]:2525 from@a.c to@b.c alice secret')
  assert.equal(authed.host, '2606:4700::1')
  assert.equal(authed.port, 2525)
  assert.equal(authed.user, 'alice')
  assert.equal(authed.password, 'secret')

  assert.deepEqual(parseNotifyTarget('local from@a.c to@b.c'), { kind: 'local', port: 25, from: 'from@a.c', to: 'to@b.c' })
  assert.equal(parseNotifyTarget('local 2525 from@a.c to@b.c').port, 2525)
  assert.equal(parseNotifyTarget('local 70000 from@a.c to@b.c'), undefined, 'a port past 65535 is not a port')
})

test('the smtp bridge is python that really sends', () => {
  // The bridge is generated as text and only runs later, on a jump host, so a
  // change to it is invisible to every other test. Parsing it here is what
  // catches an indentation or argument slip before a user configures it.
  for (const arg of ['smtp mail.example.com from@a.c to@b.c alice secret', 'local from@a.c to@b.c']) {
    // The script is the first shell word after `python3 -c`, and it quotes its
    // own quotes as `'\''`, so the word ends at the first unescaped close.
    const command = notifyTargetCommand(parseNotifyTarget(arg))
    const opening = command.indexOf("python3 -c '") + "python3 -c '".length
    const script = command.slice(opening, command.indexOf("' '", opening)).replaceAll("'\\''", "'")
    const parsed = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.argv[1])', script])
    assert.equal(parsed.status, 0, `${arg} does not parse:\n${parsed.stderr}`)
  }
})

test('the stored command carries no password, and the label names the target', () => {
  const authed = parseNotifyTarget('smtp mail.example.com:465 from@a.c to@b.c alice secret')
  const command = notifyTargetCommand(authed)
  assert.equal(command.includes('secret'), false, 'the password stays out of the command')
  assert.equal(command.includes('alice'), false, 'the username stays out of it too')
  assert.match(command, /^python3 -c /u)
  assert.match(command, /'mail\.example\.com' 465 'from@a\.c' 'to@b\.c'$/u)
  assert.equal(notifyTargetLabel(authed), 'mail.example.com:465 (alice) → to@b.c')

  const local = notifyTargetCommand(parseNotifyTarget('local from@a.c to@b.c'))
  assert.match(local, /'127\.0\.0\.1' 25 /u)
  assert.equal(local.includes('login'), false, 'the local mailer sends without authenticating')
})

test('windows runs the command under cmd', () => {
  assert.deepEqual(notifyShell('win32'), { command: 'cmd', flag: '/c' })
  assert.deepEqual(notifyShell('linux'), { command: 'sh', flag: '-c' })
})
