/**
 * TITLE.G1 — the Composer path through the real title service into real JSONL.
 *
 * The TUI is real, the SessionStore/title service are the shipped plugins, and
 * the JSONL backend owns the live write handle. No fake flush participates:
 * `sessions.flush()` must reach the backend's `session/flush` listener, persist
 * the title event, and only then report Saved.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SessionTitleService } from '@deepseek-ai/dsh-session-title'
import * as jsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setLocale } from '../lib/i18n/index.js'
import { listResumableSessionsProgressive } from '../lib/session-list.js'
import { SshTui } from '../lib/tui.js'
import { waitFor } from './wait.mjs'

setLocale('en')

async function mount(root) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionTitleService, {
    fallbackMaxWords: 5,
    fallbackMaxBytes: 40,
    maxTitleBytes: 80,
  })
  // 0.2.1-rc.2 exports the apply() seeder; the earlier 0.2.0 lines ship the
  // plugin class as the default export. The synthetic test must run on both.
  if (typeof jsonlPersistence.apply === 'function') await jsonlPersistence.apply(ctx, { root, compression: 'none' })
  else await ctx.plugin(jsonlPersistence.default, { root, compression: 'none' })
  return ctx
}

test('the real Composer, title service and JSONL backend persist one rename across reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-title-g1-e2e-'))
  const id = 'synthetic-title-g1-e2e'
  let tui
  let writer
  try {
    const ctx = await mount(root)
    const live = ctx.sessions.create(id, { meta: { cwd: root } })
    writer = await ctx.sessionPersistence.create(live.header, {
      inheritedEventCount: live.inheritedEventCount,
    })
    // A real session has a prompt and an existing title before the user renames
    // it: the prompt keeps the picker from pruning a blank log, and the pinned
    // title keeps automatic fallback out of the event count.
    ctx.sessionTitle.rename(live, 'Initial title')
    live.append('user/message', {
      id: 'm0',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'synthetic prompt' }],
    }, { surfaceOp: 'append' })

    const agent = {
      id,
      options: {},
      status: 'idle',
      session: live,
      cancel() {},
      followup() {},
      steer() {},
    }
    tui = new SshTui(ctx, agent, {
      sessionId: id,
      color: false,
      headlessDisplay: true,
    })
    tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
    tui.write = () => {}

    // The command is typed into the Composer, not injected through runCommand:
    // the command text itself must be consumed before the borrowed editor opens.
    tui.input = '/rename'
    tui.cursor = 7
    tui.submit()
    assert.equal(tui.input, '', 'the executed bare command is not left in the Composer')
    assert.equal(tui.dialog?.kind, 'rename')

    const title = '  端到端 🚀  '
    tui.setField(title, title.length)
    tui.submit()
    await waitFor(() => /Saved/i.test(tui.notice?.text ?? ''), {
      describe: 'Saved after the real JSONL flush',
      detail: () => JSON.stringify(tui.notice),
    })

    assert.equal(tui.sessionTitle, '端到端 🚀')
    const titleEvents = live.snapshotEvents().filter(event => event.type === 'session/title')
    assert.equal(titleEvents.at(-1)?.data?.title, '端到端 🚀')
    assert.equal(titleEvents.at(-1)?.data?.source?.kind, 'user')
    assert.equal(titleEvents.at(-1)?.data?.messageSeqs?.length, 0)

    assert.equal(readdirSync(root, { recursive: true })
      .filter(name => String(name).endsWith('.jsonl')).length, 1,
    'the real backend materialized one JSONL artifact')

    await writer.close()
    writer = undefined

    const reader = await ctx.sessionPersistence.open(id, 'read')
    const stored = await reader.read()
    await reader.close()
    const storedTitle = stored.events.filter(event => event.type === 'session/title').at(-1)
    assert.equal(storedTitle?.data?.title, '端到端 🚀')
    assert.equal(storedTitle?.data?.source?.kind, 'user')

    const indexPath = join(root, 'picker-index.json')
    const firstListing = await listResumableSessionsProgressive(ctx.sessionPersistence, '', {
      listHosts: async () => [],
      indexPath,
    })
    assert.equal(firstListing.complete[0]?.label, '端到端 🚀')

    // Open the same Session for writing again, then let the real TUI/Title
    // service append a second title. The already-primed picker index must miss
    // on the changed artifact and show the new label, not the cached one.
    writer = await ctx.sessionPersistence.open(id, 'write')
    tui.runCommand('/rename 第二个标题')
    await waitFor(() => /Saved/i.test(tui.notice?.text ?? '') && (tui.notice?.text ?? '').includes('第二个标题'), {
      describe: 'Saved for the second real JSONL flush',
      detail: () => JSON.stringify(tui.notice),
    })
    await writer.close()
    writer = undefined

    const secondListing = await listResumableSessionsProgressive(ctx.sessionPersistence, '', {
      listHosts: async () => [],
      indexPath,
    })
    assert.equal(secondListing.complete[0]?.label, '第二个标题')

    const secondReader = await ctx.sessionPersistence.open(id, 'read')
    const secondStored = await secondReader.read()
    await secondReader.close()
    const secondTitle = secondStored.events.filter(event => event.type === 'session/title').at(-1)
    assert.equal(secondTitle?.data?.title, '第二个标题')
    assert.equal(secondTitle?.data?.source?.kind, 'user')
  } finally {
    if (tui !== undefined) await tui.dispose()
    if (writer !== undefined) await writer.close().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})
