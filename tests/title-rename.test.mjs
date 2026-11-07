/**
 * TITLE.G1 — current-session `/rename`.
 *
 * The Host title service is faked here so these tests own the TUI boundary:
 * exact live Session identity, accepted snapshot, durability true/false/throw,
 * borrowed-field ownership, and the no-transcript/no-model rule. A separate
 * disposable-persistence test covers the real log flush and restart.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale, t } from '../lib/i18n/index.js'
import { commandSuggestions } from '../lib/commands.js'
import { resolveKeymap } from '../lib/keymap.js'
import { SshTui } from '../lib/tui.js'
import { waitFor } from './wait.mjs'

setLocale('en')

function invalidTitle(message = 'session title must contain visible characters') {
  const error = new Error(message)
  error.name = 'SessionTitleInvalidError'
  return error
}

function makeTui({ title, titleService, flush, service = true, sessions = true, sessionsErrorOnce, lineMode = false } = {}) {
  const calls = { rename: [], flush: 0, refresh: 0, get: 0, followup: 0 }
  const services = {}
  let sessionsLookupFailed = false
  if (sessions) {
    services.sessions = {
      flush: async () => {
        calls.flush += 1
        return flush === undefined ? true : await flush(calls.flush)
      },
    }
  }
  if (service) {
    services.sessionTitle = titleService ?? {
      rename(session, raw) {
        calls.rename.push({ session, raw })
        const normalized = raw.replace(/\s+/gu, ' ').trim()
        return {
          title: normalized,
          eventSeq: 100 + calls.rename.length,
          source: { kind: 'user' },
        }
      },
      get() {
        calls.get += 1
        throw new Error('sessionTitle.get must not be used for prefill')
      },
      refresh() {
        calls.refresh += 1
        throw new Error('sessionTitle.refresh must not be called by /rename')
      },
    }
  }
  const ctx = {
    get(name) {
      if (name === 'sessions' && sessionsErrorOnce && !sessionsLookupFailed) {
        sessionsLookupFailed = true
        throw new Error('synthetic sessions lookup failure')
      }
      return services[name]
    },
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: {
      id: 'main-session',
      header: { cwd: '/synthetic/workspace' },
      seq: 1,
      events: [],
    },
    cancel() {},
    followup() { calls.followup += 1 },
    steer() {},
  }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: false,
    headlessDisplay: true,
    lineMode,
  })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  if (title !== undefined) {
    tui.handleSessionEvent(agent.session, {
      type: 'session/title',
      seq: 0,
      time: 1,
      data: { title, source: { kind: 'user' } },
    })
  }
  return { tui, agent, calls, services }
}

async function settledNotice(tui, pattern) {
  await waitFor(() => pattern.test(tui.notice?.text ?? ''), {
    describe: `a notice matching ${pattern}`,
    detail: () => JSON.stringify(tui.notice),
  })
  return tui.notice.text
}

test('G1-12 /rename is in the local catalog while rename-retry stays hidden', () => {
  const names = commandSuggestions('/ren', []).map(item => item.name)
  assert.ok(names.includes('rename'), names.join(','))
  assert.equal(names.includes('rename-retry'), false, 'the flush-only retry is not a catalog command')
})

test('G1-1 missing sessionTitle fails closed without a rename, flush, or edit field', () => {
  const { tui, calls } = makeTui({ service: false })
  const rows = tui.rows.length
  tui.runCommand('/rename New title')
  tui.runCommand('/rename')
  assert.equal(calls.rename.length, 0)
  assert.equal(calls.flush, 0)
  assert.equal(tui.dialog, undefined, 'no editor is opened when the Host has no title service')
  assert.equal(tui.rows.length, rows, 'no transcript row')
  assert.match(tui.notice?.text ?? '', /unavailable/i)
})

test('G1-2 Saved appears only after the independent flush resolves true', async () => {
  let release
  const flush = () => new Promise(resolve => { release = resolve })
  const { tui, calls } = makeTui({ title: 'Old', flush })
  tui.runCommand('/rename New title')
  assert.equal(calls.rename.length, 1)
  assert.equal(calls.rename[0].session, tui.agent.session, 'the exact live Session is passed')
  assert.equal(calls.rename[0].raw, 'New title')
  assert.doesNotMatch(tui.notice?.text ?? '', /Saved/i)
  assert.match(tui.notice?.text ?? '', /Accepted/i)
  release(true)
  await settledNotice(tui, /Saved/i)
  assert.equal(calls.flush, 1)
  assert.equal(calls.refresh, 0)
  assert.equal(calls.get, 0, 'prefill uses the cached title, not sessionTitle.get()')
})

test('G1-3 false/throw are accepted-but-unconfirmed and /rename-retry flushes only', async () => {
  let result = false
  const { tui, calls } = makeTui({ title: 'Old', flush: async () => result })
  tui.runCommand('/rename New')
  await settledNotice(tui, /durability unconfirmed/i)
  assert.equal(calls.rename.length, 1)
  assert.equal(calls.flush, 1)
  assert.doesNotMatch(tui.notice?.text ?? '', /Saved/i)

  result = true
  tui.runCommand('/rename-retry')
  await settledNotice(tui, /Saved/i)
  assert.equal(calls.rename.length, 1, 'retry never issues a second rename')
  assert.equal(calls.flush, 2)
  assert.equal(calls.refresh, 0)

  const thrown = makeTui({
    title: 'Old',
    flush: async () => { throw new Error('synthetic flush failure') },
  })
  thrown.tui.runCommand('/rename New')
  await settledNotice(thrown.tui, /durability unconfirmed/i)
  assert.equal(thrown.calls.rename.length, 1)
  assert.equal(thrown.calls.flush, 1)
})

test('G1-4 empty title keeps the editor open and writes no event', async () => {
  const calls = { rename: 0, flush: 0 }
  const service = {
    rename(_session, raw) {
      calls.rename += 1
      if (raw.trim() === '') throw invalidTitle()
      return { title: raw.trim(), eventSeq: 7, source: { kind: 'user' } }
    },
    refresh() { throw new Error('refresh must not be called') },
  }
  const { tui } = makeTui({ title: 'Old', titleService: service })
  tui.runCommand('/rename')
  assert.equal(tui.dialog?.kind, 'rename')
  assert.equal(tui.borrowedText?.text, 'Old')
  tui.setField('   ', 3)
  tui.submit()
  assert.equal(tui.dialog?.kind, 'rename', 'invalid input does not close the editor')
  assert.match(tui.notice?.text ?? '', /visible characters/i)
  assert.equal(calls.rename, 1)
  assert.equal(calls.flush, 0)

  const direct = makeTui({ titleService: service })
  direct.tui.runCommand('/rename   ')
  assert.equal(direct.tui.dialog?.kind, 'rename', 'whitespace-only input is a bare command')
  assert.equal(direct.tui.borrowedText?.text, '')
  assert.equal(calls.rename, 1, 'no title event is attempted for the bare command')
})

test('G1-5 the Host accepted title is shown; CJK/emoji normalization is not reimplemented', async () => {
  const raw = '修复🚀 绘制残留 🚀'.repeat(12)
  const accepted = '修复🚀 绘制残留'
  const service = {
    rename(_session, input) {
      assert.equal(input, raw)
      return { title: accepted, eventSeq: 21, source: { kind: 'user' } }
    },
  }
  const { tui } = makeTui({ title: 'Old', titleService: service })
  tui.runCommand(`/rename ${raw}`)
  await settledNotice(tui, /Saved/i)
  assert.equal(tui.sessionTitle, accepted)
  assert.equal(tui.titleSnapshot?.title, accepted)
  assert.match(tui.notice?.text ?? '', new RegExp(accepted.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))
  assert.doesNotMatch(tui.notice?.text ?? '', /修复🚀 绘制残留 🚀修复🚀/u)
})

test('G1-6 an unchanged title is still a user rename and pins manual mode', async () => {
  const { tui, calls } = makeTui({ title: 'Same' })
  tui.runCommand('/rename Same')
  await settledNotice(tui, /Saved/i)
  assert.equal(calls.rename.length, 1, 'unchanged input still reaches the Host')
  assert.equal(calls.refresh, 0)
  assert.match(tui.notice?.text ?? '', /manual title remains pinned/i)
})

test('G1-7 Esc and Ctrl+C cancel the editor without touching the composer or queue', () => {
  for (const cancel of ['escape', 'ctrl-c']) {
    const { tui, calls } = makeTui({ title: 'Old' })
    tui.input = 'draft that must survive'
    tui.cursor = 5
    tui.runCommand('/rename')
    assert.equal(tui.dialog?.kind, 'rename')
    if (cancel === 'escape') tui.handleEscape()
    else tui.handleCtrlC()
    assert.equal(tui.dialog, undefined, cancel)
    assert.equal(tui.borrowedText, undefined, cancel)
    assert.equal(tui.input, 'draft that must survive', cancel)
    assert.equal(tui.cursor, 5, cancel)
    assert.equal(calls.rename.length, 0)
    assert.equal(calls.flush, 0)
  }
})

test('G1-7 Enter saves from the borrowed field and preserves the composer draft', async () => {
  const { tui, calls } = makeTui({ title: 'Old' })
  tui.input = 'draft'
  tui.cursor = 5
  tui.runCommand('/rename')
  tui.setField('New title', 9)
  tui.submit()
  await settledNotice(tui, /Saved/i)
  assert.equal(tui.dialog, undefined)
  assert.equal(tui.borrowedText, undefined)
  assert.equal(tui.input, 'draft')
  assert.equal(tui.cursor, 5)
  assert.equal(calls.rename[0].raw, 'New title')
})

test('G1-7 a bare /rename submitted from the Composer consumes the command text', () => {
  const { tui, calls } = makeTui({ title: 'Old' })
  tui.input = '/rename'
  tui.cursor = 7
  tui.submit()
  assert.equal(tui.input, '', 'the executed command is not left as a draft')
  assert.equal(tui.cursor, 0)
  assert.equal(tui.dialog?.kind, 'rename')
  assert.equal(tui.borrowedText?.text, 'Old')
  tui.handleEscape()
  assert.equal(tui.input, '')
  tui.submit()
  assert.equal(tui.dialog, undefined, 'a second Enter has no command to reopen')
  assert.equal(calls.rename.length, 0)
})

test('G1-8 rename writes no transcript or model-visible row', async () => {
  const { tui, calls } = makeTui({ title: 'Old' })
  const rows = tui.rows.length
  tui.runCommand('/rename New')
  await settledNotice(tui, /Saved/i)
  assert.equal(tui.rows.length, rows)
  assert.equal(calls.followup, 0)
})

test('G1-10 line mode accepts an argument and bare /rename only prints usage', async () => {
  const { tui, calls } = makeTui({ title: 'Old', lineMode: true })
  tui.runCommand('/rename New')
  await waitFor(() => tui.rows.some(row => /Saved/i.test(row.text ?? '')), {
    describe: 'the line-mode Saved row',
    detail: () => JSON.stringify(tui.rows.map(row => row.text)),
  })
  assert.equal(calls.rename[0].raw, 'New')
  assert.equal(tui.dialog, undefined, 'line mode never opens a framed editor')
  const rows = tui.rows.length
  tui.runCommand('/rename')
  assert.equal(tui.dialog, undefined)
  assert.equal(tui.rows.length, rows + 1)
  assert.match(tui.rows.at(-1)?.text ?? '', /Usage: \/rename/)
  assert.equal(calls.rename.length, 1)
})

test('G1-9 the durable title source is tracked and refresh is never called', async () => {
  const { tui, calls } = makeTui({ title: 'Old' })
  assert.equal(tui.titleSnapshot?.source?.kind, 'user')
  tui.runCommand('/rename New')
  await settledNotice(tui, /Saved/i)
  assert.equal(calls.refresh, 0, 'manual rename never unpins through refresh()')
  assert.match(tui.notice?.text ?? '', /manual title pinned/i)
})

test('G1-2 duplicate Enter after the editor closes issues no second rename', async () => {
  const { tui, calls } = makeTui({ title: 'Old' })
  tui.runCommand('/rename')
  tui.setField('One', 3)
  tui.submit()
  tui.submit()
  await settledNotice(tui, /Saved/i)
  assert.equal(calls.rename.length, 1)
  assert.equal(calls.flush, 1)
})

test('G1-2 a newer rename owns the pending flush; the older result cannot report Saved', async () => {
  const releases = []
  const { tui, calls } = makeTui({
    title: 'Old',
    flush: () => new Promise(resolve => { releases.push(resolve) }),
  })
  tui.runCommand('/rename First')
  tui.runCommand('/rename Second')
  assert.equal(calls.rename.length, 2)
  assert.equal(calls.flush, 2)
  releases[0](false)
  await waitFor(() => tui.notice?.text?.includes('Second') === true, {
    describe: 'the second accepted notice',
  })
  assert.doesNotMatch(tui.notice?.text ?? '', /Saved/i)
  releases[1](true)
  await settledNotice(tui, /Saved/i)
  assert.match(tui.notice?.text ?? '', /Second/)
  assert.doesNotMatch(tui.notice?.text ?? '', /First/)
})

test('G1-3 a missing sessions service is accepted-only and never claims Saved', async () => {
  const { tui, calls } = makeTui({ title: 'Old', sessions: false })
  tui.runCommand('/rename New')
  await settledNotice(tui, /no persistence listener/i)
  assert.equal(calls.flush, 0)
  assert.doesNotMatch(tui.notice?.text ?? '', /Saved/i)
  tui.runCommand('/rename-retry')
  assert.match(tui.notice?.text ?? '', /no persistence listener/i)
  assert.equal(calls.rename.length, 1)
})

test('G1-3 a raising sessions lookup settles the flush instead of staying Busy', async () => {
  const { tui, calls } = makeTui({ title: 'Old', sessionsErrorOnce: true })
  tui.runCommand('/rename New')
  await settledNotice(tui, /durability unconfirmed/i)
  assert.equal(calls.flush, 0, 'the lookup failed before any listener ran')
  assert.equal(tui.renamePending?.flushing, false, 'the failed lookup released the pending flush')
  tui.runCommand('/rename-retry')
  await settledNotice(tui, /Saved/i)
  assert.equal(calls.flush, 1, 'the retry reaches the now-available sessions service')
  assert.equal(calls.rename.length, 1, 'retry still never issues a second rename')
  assert.doesNotMatch(tui.notice?.text ?? '', /already in progress/i)
})

test('G1-11 F2 stays unbound and does not open the rename editor', () => {
  const sequences = resolveKeymap().sequences
  assert.equal([...sequences.keys()].includes('\x1bOQ'), false)
  assert.equal([...sequences.keys()].includes('\x1b[12~'), false)
  const { tui } = makeTui({ title: 'Old' })
  tui.handleData(Buffer.from('\x1bOQ'))
  assert.equal(tui.dialog, undefined)
  assert.equal(tui.input, '')
})

test('G1-7 the borrowed field supports CJK/emoji, caret movement and paste without touching the Composer', () => {
  const { tui, calls } = makeTui({ title: 'Old' })
  tui.input = 'composer draft'
  tui.cursor = 7
  tui.runCommand('/rename')
  tui.setField('A我🚀B', 1)
  tui.insertIntoField('中')
  assert.equal(tui.borrowedText?.text, 'A中我🚀B')
  assert.equal(tui.borrowedText?.cursor, 2)
  tui.moveFieldCursor('end')
  assert.equal(tui.borrowedText?.cursor, 6)
  tui.backspace()
  assert.equal(tui.borrowedText?.text, 'A中我🚀')
  tui.handlePasteText('粘贴\n标题')
  assert.match(tui.borrowedText?.text ?? '', /粘贴\n标题$/)
  assert.equal(tui.input, 'composer draft')
  assert.equal(tui.cursor, 7)
  assert.equal(calls.rename.length, 0, 'editing alone never calls the Host')
})

test('G1-12 /rename preserves the whole remainder for Host normalization', async () => {
  const { tui, calls } = makeTui({ title: 'Old' })
  tui.runCommand('/rename  Two  spaces  ')
  await settledNotice(tui, /Saved/i)
  assert.equal(calls.rename[0].raw, 'Two  spaces  ')
})

test('G1-3 /rename-retry with no pending rename is a no-op', () => {
  const { tui, calls } = makeTui({ title: 'Old' })
  tui.runCommand('/rename-retry')
  assert.match(tui.notice?.text ?? '', /No accepted rename/i)
  assert.equal(calls.rename.length, 0)
  assert.equal(calls.flush, 0)
})

test('G1-2 closing while the flush is pending clears the waiter and never reports Saved', async () => {
  let release
  const { tui } = makeTui({
    title: 'Old',
    flush: () => new Promise(resolve => { release = resolve }),
  })
  tui.runCommand('/rename New')
  assert.equal(tui.renamePending?.title, 'New')
  await tui.dispose()
  assert.equal(tui.renamePending, undefined)
  release(true)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.doesNotMatch(tui.notice?.text ?? '', /Saved/i)
})

test('G1-6 a synchronous session/title event during rename is not mistaken for unchanged', async () => {
  const { tui, services } = makeTui({ title: 'Old' })
  services.sessionTitle.rename = (_session, raw) => {
    // The real service appends synchronously; the TUI event handler updates
    // this.sessionTitle before rename() returns.
    tui.sessionTitle = raw
    return { title: raw, eventSeq: 9, source: { kind: 'user' } }
  }
  tui.runCommand('/rename New')
  await settledNotice(tui, /Saved/i)
  assert.doesNotMatch(tui.notice?.text ?? '', /unchanged/i)
  assert.match(tui.notice?.text ?? '', /manual title pinned/i)
})

test('G1-7 a queued rename waits behind an existing Surface and preserves the composer', () => {
  const { tui } = makeTui({ title: 'Old' })
  tui.input = 'draft'
  tui.cursor = 2
  tui.openConfirm('synthetic confirm', 'y/n', () => {})
  assert.equal(tui.dialog?.kind, 'confirm')
  tui.runCommand('/rename')
  assert.equal(tui.dialogQueue.length, 1, 'rename is queued, not placed over the confirm')
  tui.handleEscape()
  assert.equal(tui.dialog?.kind, 'rename', 'after the confirm closes, the queued editor opens')
  assert.equal(tui.borrowedText?.text, 'Old')
  assert.equal(tui.input, 'draft')
  tui.handleEscape()
  assert.equal(tui.dialog, undefined)
  assert.equal(tui.input, 'draft')
  assert.equal(tui.cursor, 2)
})

test('G1-2 only the literal true from flush is Saved', async () => {
  const { tui, calls } = makeTui({ title: 'Old', flush: async () => 1 })
  tui.runCommand('/rename New')
  await settledNotice(tui, /durability unconfirmed/i)
  assert.equal(calls.flush, 1)
  assert.doesNotMatch(tui.notice?.text ?? '', /Saved/i)
})
