/**
 * TITLE.G1 — real Host title-domain service, no persistence and no model.
 *
 * This pins the contract the TUI consumes: exact live Session identity,
 * normalization/truncation by the Host, user-source pinning, and the fact that
 * a later user message does not schedule an automatic replacement.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SessionTitleService } from '@deepseek-ai/dsh-session-title'

let sequence = 0

async function service() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionTitleService, {
    fallbackMaxWords: 5,
    fallbackMaxBytes: 40,
    maxTitleBytes: 80,
  })
  return ctx
}

function session(ctx, text = 'synthetic first prompt') {
  const id = `title-g1-service-${++sequence}`
  return ctx.sessions.create(id, {
    seed: [{
      type: 'user/message',
      seq: 0,
      time: 1,
      surfaceOp: 'append',
      data: {
        id: 'm0',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      },
    }],
    meta: { cwd: '/synthetic/workspace' },
  })
}

test('the real sessionTitle.rename accepts normalized user text and pins it', async () => {
  const ctx = await service()
  const live = session(ctx)
  const accepted = ctx.sessionTitle.rename(live, '  新的  标题🚀  ')
  assert.equal(accepted.title, '新的 标题🚀')
  assert.equal(accepted.source.kind, 'user')
  assert.equal(accepted.messageSeqs.length, 0)
  assert.equal(live.snapshotEvents().at(-1)?.type, 'session/title')

  const unchanged = ctx.sessionTitle.rename(live, '新的 标题🚀')
  assert.equal(unchanged.title, '新的 标题🚀')
  assert.equal(live.snapshotEvents().filter(event => event.type === 'session/title').length, 2,
    'unchanged user input is still a new pin event')

  // A later human message must not schedule an automatic revision over the pin.
  live.append('user/message', {
    id: 'm1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'later prompt' }],
  }, { surfaceOp: 'append' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(live.snapshotEvents().filter(event => event.type === 'session/title').length, 2,
    'manual title remains the latest title event')
})

test('the Host truncates overlong UTF-8 without splitting a code point', async () => {
  const ctx = await service()
  const live = session(ctx)
  const accepted = ctx.sessionTitle.rename(live, '🚀'.repeat(30))
  assert.ok(Buffer.byteLength(accepted.title, 'utf8') <= 80)
  assert.equal(accepted.title, '🚀'.repeat(20))
  assert.equal(accepted.title.includes('\uFFFD'), false)
})

test('rename rejects an empty normalized title without appending', async () => {
  const ctx = await service()
  const live = session(ctx)
  assert.throws(
    () => ctx.sessionTitle.rename(live, '   \u001b[31m  '),
    (error) => error?.name === 'SessionTitleInvalidError',
  )
  assert.equal(live.snapshotEvents().some(event => event.type === 'session/title'), false)
})

test('a 55k-event live Session rename stays within the interactive budget', async () => {
  const ctx = await service()
  const N = 55_000
  const seed = Array.from({ length: N }, (_, index) => ({
    type: 'turn/start',
    seq: index,
    time: index,
    data: { turn: index },
  }))
  const live = ctx.sessions.create('title-g1-55k', {
    seed,
    meta: { cwd: '/synthetic/workspace' },
  })
  const started = performance.now()
  const accepted = ctx.sessionTitle.rename(live, '55k synthetic title')
  const elapsed = performance.now() - started
  assert.equal(accepted.title, '55k synthetic title')
  assert.equal(accepted.source.kind, 'user')
  assert.ok(elapsed < 250, `55k rename took ${elapsed.toFixed(1)} ms`)
})
