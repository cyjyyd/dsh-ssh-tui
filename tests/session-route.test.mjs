import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadSessionRoute,
  loadSessionRoutes,
  parseSessionRoutes,
  pruneSessionRoutes,
  resolveLaunchRoute,
  restoreSessionRoute,
  sameSessionRoute,
  saveSessionRoute,
  sessionRouteInput,
  sessionRoutePath,
  SESSION_ROUTE_LIMIT,
} from '../lib/session-route.js'

/**
 * Per-session route memory: what a conversation was spending on, so resuming it
 * comes back on the same supplier — subagent route included.
 */

async function tempPath() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-route-'))
  return sessionRoutePath(home)
}

test('a route record round-trips, and one session cannot drop another', async () => {
  const path = await tempPath()
  assert.equal(await loadSessionRoute('s1', path), undefined)
  const route = {
    provider: 'xai',
    model: 'grok-4.6',
    reasoningEffort: 'xhigh',
    subagent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  }
  assert.equal(await saveSessionRoute('s1', route, path), true)
  const stored = await loadSessionRoute('s1', path)
  assert.equal(stored.provider, 'xai')
  assert.equal(stored.model, 'grok-4.6')
  assert.equal(stored.reasoningEffort, 'xhigh')
  assert.deepEqual(stored.subagent, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  assert.ok(stored.updatedAt > 0)

  // A second session's write is a read-modify-write, not a replacement.
  await saveSessionRoute('s2', { provider: 'opencode', model: 'zen-1' }, path)
  assert.equal((await loadSessionRoute('s1', path)).model, 'grok-4.6')
  assert.equal((await loadSessionRoute('s2', path)).provider, 'opencode')
  assert.equal((await loadSessionRoute('', path)), undefined)
  assert.equal(await saveSessionRoute('s3', { provider: '', model: '' }, path), false)
})

test('a record that cannot name a route is not a record', () => {
  assert.equal(parseSessionRoutes({ version: 1, entries: { a: { provider: 'xai', model: 'grok' } } }).size, 1)
  // Another version's file is ignored rather than guessed at.
  assert.equal(parseSessionRoutes({ version: 2, entries: { a: { provider: 'xai', model: 'grok' } } }).size, 0)
  const entries = parseSessionRoutes({
    version: 1,
    entries: {
      ok: { provider: ' xai ', model: ' grok-4.6 ', reasoningEffort: ' xhigh ', updatedAt: 5 },
      'no-model': { provider: 'xai' },
      'no-provider': { model: 'grok' },
      junk: 'not an object',
      '': { provider: 'xai', model: 'grok' },
    },
  })
  assert.deepEqual([...entries.keys()], ['ok'])
  assert.deepEqual(entries.get('ok'), {
    provider: 'xai',
    model: 'grok-4.6',
    reasoningEffort: 'xhigh',
    updatedAt: 5,
  })
})

test('a record with a bad shape reads as no record at all', async () => {
  const path = await tempPath()
  await writeFile(path, 'not json at all')
  assert.equal(await loadSessionRoute('s1', path), undefined)
  await writeFile(path, JSON.stringify({ version: 1, entries: null }))
  assert.equal(await loadSessionRoute('s1', path), undefined)
  await writeFile(path, JSON.stringify({ version: 1, entries: { s1: { provider: 'xai' } } }))
  assert.equal(await loadSessionRoute('s1', path), undefined)
})

test('the oldest records are pruned so the file cannot grow forever', () => {
  const entries = new Map()
  for (let at = 0; at < SESSION_ROUTE_LIMIT + 5; at += 1) {
    entries.set(`s${at}`, { provider: 'xai', model: 'grok', updatedAt: at })
  }
  const pruned = pruneSessionRoutes(entries)
  assert.equal(pruned.size, SESSION_ROUTE_LIMIT)
  assert.equal(pruned.has(`s${SESSION_ROUTE_LIMIT + 4}`), true, 'the newest survive')
  assert.equal(pruned.has('s0'), false, 'the oldest go first')
  // Under the limit nothing is dropped.
  assert.equal(pruneSessionRoutes(new Map([...entries].slice(0, 3))).size, 3)
})

test('a launch takes the session record, but a flag still wins', () => {
  const session = { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'xhigh', updatedAt: 1 }
  const saved = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  // A resumed conversation comes back on the supplier it was using…
  assert.deepEqual(
    resolveLaunchRoute({ session, saved }),
    { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'xhigh' },
  )
  // …while a new session still starts from the global default.
  assert.deepEqual(resolveLaunchRoute({ saved }), { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  // An explicit flag is this launch's ask, so it outranks the record.
  assert.deepEqual(
    resolveLaunchRoute({ cli: { provider: 'opencode', model: 'zen-1' }, session, saved }),
    { provider: 'opencode', model: 'zen-1' },
  )
  // An in-process change outranks even the flag.
  assert.deepEqual(
    resolveLaunchRoute({
      live: { provider: 'opencode-go', model: 'go-1' },
      cli: { provider: 'opencode', model: 'zen-1' },
      session,
    }),
    { provider: 'opencode-go', model: 'go-1' },
  )
  // Nothing remembered: the built-in default.
  assert.deepEqual(resolveLaunchRoute({}), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
})

test('the effort belongs to the route it was chosen for', () => {
  const session = { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'xhigh', updatedAt: 1 }
  // A flag that moves half the route must not inherit the recorded effort.
  assert.deepEqual(
    resolveLaunchRoute({ cli: { model: 'grok-4.5' }, session }),
    { provider: 'xai', model: 'grok-4.5' },
  )
  // A flag that restates the same route keeps it.
  assert.deepEqual(
    resolveLaunchRoute({ cli: { provider: 'xai', model: 'grok-4.6' }, session }),
    { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'xhigh' },
  )
  // The session's effort also wins over the global default's, not just the route.
  assert.deepEqual(
    resolveLaunchRoute({ session, saved: { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'low' } }),
    { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'xhigh' },
  )
  // A record with no effort leaves the route without one.
  assert.deepEqual(
    resolveLaunchRoute({ session: { provider: 'xai', model: 'grok-4.6', updatedAt: 1 } }),
    { provider: 'xai', model: 'grok-4.6' },
  )
  // An in-process selection decides alone: `/model` picking "provider default"
  // means no effort, not the effort that route happened to carry before.
  assert.deepEqual(
    resolveLaunchRoute({
      live: { provider: 'xai', model: 'grok-4.6' },
      saved: { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'max' },
      session,
    }),
    { provider: 'xai', model: 'grok-4.6' },
  )
})

test('the record builder keeps what can name a route and drops the rest', () => {
  assert.deepEqual(
    sessionRouteInput({
      provider: ' xai ',
      model: ' grok-4.6 ',
      reasoningEffort: ' xhigh ',
      subagent: { provider: ' deepseek-official ', model: ' deepseek-v4-flash ', reasoningEffort: 'max' },
    }),
    {
      provider: 'xai',
      model: 'grok-4.6',
      reasoningEffort: 'xhigh',
      subagent: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    },
  )
  // An inherited subagent route carries no provider: it follows the parent.
  assert.deepEqual(
    sessionRouteInput({ provider: 'xai', model: 'grok-4.6', subagent: { model: 'grok-4.5' } }),
    { provider: 'xai', model: 'grok-4.6', subagent: { model: 'grok-4.5' } },
  )
  // Nothing that cannot name a route is written.
  assert.equal(sessionRouteInput({ provider: '', model: 'grok' }), undefined)
  assert.equal(sessionRouteInput({ provider: 'xai', model: '  ' }), undefined)
  assert.deepEqual(
    sessionRouteInput({ provider: 'xai', model: 'grok', subagent: { model: '' } }),
    { provider: 'xai', model: 'grok' },
  )
})

test('an unchanged route is recognised, so a repaint writes nothing', () => {
  const stored = {
    provider: 'xai',
    model: 'grok-4.6',
    reasoningEffort: 'xhigh',
    subagent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    updatedAt: 42,
  }
  assert.equal(sameSessionRoute(stored, {
    provider: 'xai',
    model: 'grok-4.6',
    reasoningEffort: 'xhigh',
    subagent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  }), true)
  assert.equal(sameSessionRoute(stored, { provider: 'xai', model: 'grok-4.5' }), false)
  assert.equal(sameSessionRoute(stored, { provider: 'xai', model: 'grok-4.6', reasoningEffort: 'xhigh' }), false)
  assert.equal(sameSessionRoute(stored, {
    provider: 'xai',
    model: 'grok-4.6',
    reasoningEffort: 'xhigh',
    subagent: { model: 'deepseek-v4-flash' },
  }), false)
  assert.equal(sameSessionRoute(undefined, undefined), true)
  assert.equal(sameSessionRoute(stored, undefined), false)
  assert.equal(sameSessionRoute(undefined, { provider: 'xai', model: 'grok' }), false)
})

test('the whole file loads as the sessions the picker knows', async () => {
  const path = await tempPath()
  await saveSessionRoute('s1', { provider: 'xai', model: 'grok-4.6' }, path)
  await saveSessionRoute('s2', { provider: 'opencode', model: 'zen-1' }, path)
  const all = await loadSessionRoutes(path)
  assert.deepEqual([...all.keys()].sort(), ['s1', 's2'])
})

test('resuming applies the record, and a new session is left alone', async () => {
  const path = await tempPath()
  await saveSessionRoute('s1', {
    provider: 'xai',
    model: 'grok-4.6',
    reasoningEffort: 'xhigh',
    subagent: { provider: 'xai', model: 'grok-4.5' },
  }, path)
  const ref = { current: { model: 'deepseek-v4-flash' } }
  // A new session keeps the global default…
  assert.equal(await restoreSessionRoute({ sessionId: 's1', resume: false, subagentSelection: ref, path }), undefined)
  assert.deepEqual(ref.current, { model: 'deepseek-v4-flash' })
  // …and a resume brings the session's own route back, subagent included.
  const restored = await restoreSessionRoute({ sessionId: 's1', resume: true, subagentSelection: ref, path })
  assert.equal(restored.provider, 'xai')
  assert.equal(restored.model, 'grok-4.6')
  assert.deepEqual(ref.current, { provider: 'xai', model: 'grok-4.5' })
  // A resumed session with no record starts from the default, untouched.
  const fresh = { current: { model: 'deepseek-v4-flash' } }
  assert.equal(await restoreSessionRoute({ sessionId: 'never-seen', resume: true, subagentSelection: fresh, path }), undefined)
  assert.deepEqual(fresh.current, { model: 'deepseek-v4-flash' })
  // A record that pinned the parent's own provider stays pinned after resume:
  // `/submodel` said so for this conversation.
  await saveSessionRoute('s2', { provider: 'xai', model: 'grok-4.6', subagent: { model: 'grok-4.5' } }, path)
  const inherited = { current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }
  await restoreSessionRoute({ sessionId: 's2', resume: true, subagentSelection: inherited, path })
  assert.deepEqual(inherited.current, { model: 'grok-4.5' })
})
