import test from 'node:test'
import assert from 'node:assert/strict'

import {
  actionsForInput,
  pickerWantsMorePage,
  showSessionPicker,
  clampPickerCursor,
  feedPicker,
  filterResumableSessions,
  pickerCapacity,
  pickerStateUnchanged,
  SESSION_PICKER_WINDOW,
  sessionMatchesQuery,
  stepPicker,
} from '../lib/picker.js'
import { pickerWindowStart } from '../lib/paint.js'

function session(id, overrides = {}) {
  return {
    id,
    label: overrides.label ?? `task ${id}`,
    updatedAt: overrides.updatedAt ?? 1000,
    cwd: overrides.cwd ?? '/root/work',
    ...overrides,
  }
}

function state(sessions, overrides = {}) {
  return {
    sessions,
    query: '',
    cursor: 0,
    filterActive: false,
    ...overrides,
  }
}

function continueState(current, action, windowSize = SESSION_PICKER_WINDOW) {
  const step = stepPicker(current, action, windowSize)
  assert.equal(step.kind, 'continue')
  return step.state
}

test('filter matches title, id, cwd, and attach pid (every token)', () => {
  const live = session('live-host', {
    label: '修复绘制残留',
    cwd: '/root/genshin/srv',
    attach: { pid: 4242, sock: '/tmp/x.sock', state: 'paused' },
  })
  const other = session('other', { label: '写 README', cwd: '/tmp' })
  assert.equal(sessionMatchesQuery(live, '绘制'), true)
  assert.equal(sessionMatchesQuery(live, 'LIVE-HOST'), true)
  assert.equal(sessionMatchesQuery(live, 'genshin 4242'), true)
  assert.equal(sessionMatchesQuery(live, 'pid'), true)
  assert.equal(sessionMatchesQuery(live, '绘制 missing'), false)
  assert.deepEqual(filterResumableSessions([live, other], 'srv').map(item => item.id), ['live-host'])
  assert.deepEqual(filterResumableSessions([live, other], '').map(item => item.id), ['live-host', 'other'])
})

test('arrows and page keys move the highlight without capping at nine', () => {
  const sessions = Array.from({ length: 20 }, (_, index) => session(`s${index}`))
  let current = state(sessions)
  current = continueState(current, { type: 'move', delta: 1 })
  assert.equal(current.cursor, 1)
  current = continueState(current, { type: 'page', delta: 1 }, 5)
  assert.equal(current.cursor, 6)
  current = continueState(current, { type: 'end' })
  assert.equal(current.cursor, 19)
  current = continueState(current, { type: 'move', delta: 1 })
  assert.equal(current.cursor, 19)
  current = continueState(current, { type: 'home' })
  assert.equal(current.cursor, 0)
  assert.equal(clampPickerCursor(-3, 20), 0)
  assert.equal(pickerWindowStart(19, 20, SESSION_PICKER_WINDOW), 11)
  const atEnd = stepPicker(state(sessions, { cursor: 19 }), { type: 'move', delta: 1 })
  assert.equal(atEnd.kind, 'continue')
  assert.equal(pickerStateUnchanged(state(sessions, { cursor: 19 }), atEnd.state), true)
})

test('empty-filter digits 1-9 pick the visible window; Enter picks the cursor', () => {
  const sessions = Array.from({ length: 15 }, (_, index) => session(`s${index}`))
  let current = state(sessions, { cursor: 10 })
  const start = pickerWindowStart(10, 15, SESSION_PICKER_WINDOW)
  assert.equal(pickerWindowStart(10, 15, SESSION_PICKER_WINDOW) + SESSION_PICKER_WINDOW - start, 9)
  const quick = stepPicker(current, { type: 'quick', key: '1' }, SESSION_PICKER_WINDOW)
  assert.equal(quick.kind, 'done')
  assert.deepEqual(quick.result, { kind: 'resume', id: `s${start}` })
  const ninth = stepPicker(current, { type: 'quick', key: '9' }, SESSION_PICKER_WINDOW)
  assert.equal(ninth.kind, 'done')
  assert.deepEqual(ninth.result, { kind: 'resume', id: `s${start + 8}` })

  const submit = stepPicker(current, { type: 'submit' })
  assert.equal(submit.kind, 'done')
  assert.deepEqual(submit.result, { kind: 'resume', id: 's10' })

  const attached = session('live', { attach: { pid: 7, sock: '/tmp/live.sock' } })
  const attach = stepPicker(state([attached]), { type: 'submit' })
  assert.deepEqual(attach, { kind: 'done', result: { kind: 'attach', id: 'live', sock: '/tmp/live.sock' } })
})

test('typing filters; digits type once the filter is active; Esc leaves the filter first', () => {
  const sessions = [
    session('alpha', { label: '修复绘制残留', cwd: '/root/a' }),
    session('beta', { label: '写文档', cwd: '/root/docs' }),
    session('gamma-9', { label: 'task 9', cwd: '/tmp/nine' }),
  ]
  let current = state(sessions)
  current = continueState(current, { type: 'type', text: '绘' })
  assert.equal(current.filterActive, true)
  assert.equal(current.query, '绘')
  assert.equal(current.cursor, 0)
  const resume = stepPicker(current, { type: 'submit' })
  assert.deepEqual(resume, { kind: 'done', result: { kind: 'resume', id: 'alpha' } })

  current = continueState(state(sessions), { type: 'startFilter' })
  assert.equal(current.filterActive, true)
  current = continueState(current, { type: 'quick', key: '9' })
  assert.equal(current.query, '9')
  const filtered = filterResumableSessions(current.sessions, current.query)
  assert.deepEqual(filtered.map(item => item.id), ['gamma-9'])

  current = continueState(current, { type: 'escape' })
  assert.equal(current.query, '')
  assert.equal(current.filterActive, false)
  const cancel = stepPicker(current, { type: 'escape' })
  assert.deepEqual(cancel, { kind: 'done', result: null })
})

test('0 starts a new session only when not filtering', () => {
  const sessions = [session('one')]
  const fresh = stepPicker(state(sessions), { type: 'new' })
  assert.deepEqual(fresh, { kind: 'done', result: { kind: 'new' } })
  assert.deepEqual(actionsForInput('0'), [{ type: 'new' }])
  assert.deepEqual(actionsForInput('0', { query: '', filterActive: true }), [{ type: 'type', text: '0' }])
  assert.deepEqual(actionsForInput('/'), [{ type: 'startFilter' }])
  assert.deepEqual(actionsForInput('\x1b[A'), [{ type: 'move', delta: -1 }])
  assert.deepEqual(actionsForInput('\x1b[6~'), [{ type: 'page', delta: 1 }])
  assert.deepEqual(actionsForInput('\r'), [{ type: 'submit' }])
  assert.deepEqual(actionsForInput('\x1b'), [{ type: 'escape' }])
  assert.deepEqual(actionsForInput('\x03'), [{ type: 'cancel' }])
})

test('pickerCapacity locks a full page at nine when the tty can fit it', () => {
  assert.equal(SESSION_PICKER_WINDOW, 9)
  assert.equal(pickerCapacity(8), 1)
  assert.equal(pickerCapacity(24), 8)
  assert.equal(pickerCapacity(25), 9)
  assert.equal(pickerCapacity(80), 9)
})

test('pasted text types digits instead of firing 1-9 shortcuts', () => {
  const sessions = [
    session('s1', { label: 'alpha' }),
    session('fix-2', { label: 'fix 2 the renderer' }),
  ]
  const typed = feedPicker(state(sessions), 'fix 2')
  assert.equal(typed.kind, 'continue')
  assert.equal(typed.state.query, 'fix 2')
  assert.equal(typed.state.filterActive, true)
  const picked = stepPicker(typed.state, { type: 'submit' })
  assert.deepEqual(picked, { kind: 'done', result: { kind: 'resume', id: 'fix-2' } })

  const arrow = feedPicker(state(sessions, { cursor: 1 }), '\x1b[A')
  assert.equal(arrow.kind, 'continue')
  assert.equal(arrow.state.cursor, 0)
})

test('pickerStateUnchanged treats loading as part of the frame', () => {
  const sessions = [session('a')]
  const idle = state(sessions)
  const loading = state(sessions, { loading: true })
  assert.equal(pickerStateUnchanged(idle, idle), true)
  assert.equal(pickerStateUnchanged(idle, loading), false)
})

test('pickerStateUnchanged treats the unloaded count as part of the frame', () => {
  const sessions = [session('a')]
  const idle = state(sessions)
  // The count line says how many sessions are still unread; a repaint that only
  // changes that number still has to happen.
  const more = state(sessions, { loading: false, more: 3 })
  assert.equal(pickerStateUnchanged(idle, more), false)
  assert.equal(pickerStateUnchanged(more, state(sessions, { loading: false, more: 4 })), false)
  assert.equal(pickerStateUnchanged(more, state(sessions, { loading: false, more: 3 })), true)
})

// The launcher keeps owning the TTY as the display relay for the whole
// session, so a picker that leaves its `resize` listener behind repaints its
// dead screen over the running TUI on every terminal resize (the "resize
// flashes the history-session picker" bug).
//
// The streams are injected: stubbing the process globals would swallow the
// node:test reporter's own output (it writes through process.stdout).
function pickerStreams() {
  const writes = []
  const listeners = new Map()
  const stdout = {
    columns: 100,
    rows: 30,
    write: (chunk) => { writes.push(String(chunk)); return true },
    on: (event, handler) => { listeners.set(event, [...(listeners.get(event) ?? []), handler]) },
    removeListener: (event, handler) => {
      listeners.set(event, (listeners.get(event) ?? []).filter(entry => entry !== handler))
    },
    emit: (event) => { for (const handler of listeners.get(event) ?? []) handler() },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  }
  const stdinHandlers = []
  const stdin = {
    isTTY: true,
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    on: (event, handler) => { if (event === 'data') stdinHandlers.push(handler) },
    removeListener: (event, handler) => {
      const at = stdinHandlers.indexOf(handler)
      if (event === 'data' && at >= 0) stdinHandlers.splice(at, 1)
    },
  }
  const type = (text) => { for (const handler of [...stdinHandlers]) handler(Buffer.from(text)) }
  return { stdout, stdin, writes, listeners, type }
}

test('a settled picker drops its resize listener and cannot repaint', { timeout: 5_000 }, async () => {
  const io = pickerStreams()
  // No persistence service: the picker settles immediately with `new`.
  const result = await showSessionPicker({ get: () => undefined }, false, undefined, io)
  assert.deepEqual(result, { kind: 'new' })
  assert.equal(io.stdout.listenerCount('resize'), 0, 'resize listener must be removed')
  assert.ok(io.writes.length > 0, 'the picker should have painted at least once')
  const painted = io.writes.length
  io.stdout.emit('resize')
  io.stdout.emit('resize')
  assert.equal(io.writes.length, painted, 'a settled picker must never paint again')
})

// The listener must also be present *and working* while the picker is live, and
// gone on every exit path — the cancel path included.
test('a live picker repaints on resize and stops after cancel', { timeout: 5_000 }, async () => {
  const io = pickerStreams()
  // A loader that never settles keeps the picker live without touching the
  // real persistence service or the lock directory.
  const pending = new Promise(() => {})
  const ctx = { get: (key) => key === 'loader' ? { await: () => pending } : undefined }
  const abort = new AbortController()
  const settled = showSessionPicker(ctx, false, abort.signal, io)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(io.stdout.listenerCount('resize'), 1, 'a live picker listens for resize')
  const before = io.writes.length
  io.stdout.emit('resize')
  assert.ok(io.writes.length > before, 'a live picker repaints on resize')
  abort.abort()
  await settled
  assert.equal(io.stdout.listenerCount('resize'), 0, 'cancel removes the resize listener')
  const after = io.writes.length
  io.stdout.emit('resize')
  io.stdout.emit('resize')
  assert.equal(io.writes.length, after, 'a cancelled picker must never paint again')
})

/** A pager over fixed pages; `remaining`/`done` are derived like the real one. */
function pagedSource(pages) {
  const all = pages.flat()
  let served = 0
  return {
    async page() {
      const page = pages[Math.min(served, pages.length - 1)] ?? []
      served = Math.min(served + 1, pages.length)
      const loaded = pages.slice(0, served).flat()
      return {
        sessions: loaded,
        remaining: all.length - loaded.length,
        done: served >= pages.length,
      }
    },
    async complete() { return all },
  }
}

function pagerOptions(pages, onPage) {
  return async () => {
    const source = pagedSource(pages)
    return {
      page: async (size) => {
        const page = await source.page(size)
        onPage?.(page)
        return page
      },
      complete: source.complete,
    }
  }
}

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

test('pickerWantsMorePage only fires when the user reaches for older sessions', () => {
  const loaded = [session('a'), session('b')]
  const idle = state(loaded, { cursor: 0 })
  const atEnd = state(loaded, { cursor: 1 })
  const down = [{ type: 'move', delta: 1 }]
  // Nothing left to read: never.
  assert.equal(pickerWantsMorePage({ previous: atEnd, next: atEnd, actions: down, more: 0 }), false)
  // Moving inside the loaded rows is not a request.
  assert.equal(pickerWantsMorePage({ previous: idle, next: atEnd, actions: down, more: 5 }), false)
  // Pressing down on the last loaded row is.
  assert.equal(pickerWantsMorePage({ previous: atEnd, next: atEnd, actions: down, more: 5 }), true)
  // Moving up is not.
  assert.equal(pickerWantsMorePage({
    previous: atEnd, next: idle, actions: [{ type: 'move', delta: -1 }], more: 5,
  }), false)
  // End asks for the end of the list from wherever the cursor is.
  assert.equal(pickerWantsMorePage({ previous: idle, next: atEnd, actions: [{ type: 'end' }], more: 5 }), true)
  // A filter with fewer matches than a page keeps looking; a full page does not.
  const short = { ...idle, query: 'zz', filterActive: true }
  assert.equal(pickerWantsMorePage({
    previous: idle, next: short, actions: [{ type: 'type', text: 'z' }], more: 5,
  }), true)
  const full = state(Array.from({ length: 9 }, (_, index) => session(`m-${index}`)), {
    query: 'm', filterActive: true,
  })
  assert.equal(pickerWantsMorePage({
    previous: full, next: full, actions: [{ type: 'type', text: 'm' }], more: 5,
  }), false)
})

// The first page is read in full before anything is painted: every row on
// screen carries a real title, and no id is ever shown and then replaced a
// moment later. This is what replaced the header sketch.
test('the picker paints nothing until the first page is steady', { timeout: 5_000 }, async () => {
  const io = pickerStreams()
  const page = [session('main-session-16531619', { label: '兼容0.1.5并修光标漂移' })]
  let release
  const gate = new Promise(resolve => { release = resolve })
  const openPager = async () => ({
    page: async () => {
      await gate
      return { sessions: page, remaining: 0, done: true }
    },
    complete: async () => page,
  })
  const ctx = { get: (key) => key === 'sessionPersistence' ? {} : undefined }
  const abort = new AbortController()
  const settled = showSessionPicker(ctx, false, abort.signal, { ...io, openPager })
  await tick()
  const loadingFrame = io.writes.join('')
  assert.equal(loadingFrame.includes('main-session-16531619'), false, 'raw ids must not be painted')
  assert.equal(loadingFrame.includes('正在读取历史会话'), true, 'the loading line holds the spot')
  release()
  await tick()
  const steady = io.writes.join('')
  assert.equal(steady.includes('兼容0.1.5并修光标漂移'), true, 'the title appears')
  assert.equal(steady.includes('main-session-16531619'), false, 'and never as an id')
  abort.abort()
  await settled
})

// Titles arrive with the page, not one by one: the page is one frame.
test('the first page is painted as one frame', { timeout: 5_000 }, async () => {
  const io = pickerStreams()
  const page = [
    session('main-session-a', { label: '第一条标题' }),
    session('main-session-b', { label: '第二条标题' }),
  ]
  const ctx = { get: (key) => key === 'sessionPersistence' ? {} : undefined }
  const abort = new AbortController()
  const settled = showSessionPicker(ctx, false, abort.signal, { ...io, openPager: pagerOptions([page]) })
  await tick()
  const frame = io.writes.find(write => write.includes('第一条标题'))
  assert.notEqual(frame, undefined, 'the page was painted')
  assert.equal(frame.includes('第二条标题'), true, 'both titles came in the same frame')
  abort.abort()
  await settled
})

test('the loading frame says what it is waiting for, not which sessions', { timeout: 5_000 }, async () => {
  const io = pickerStreams()
  const page = [session('main-session-9f1c', { label: '读取完成后才有' })]
  let release
  const gate = new Promise(resolve => { release = resolve })
  const openPager = async () => ({
    page: async () => { await gate; return { sessions: page, remaining: 0, done: true } },
    complete: async () => page,
  })
  const ctx = { get: (key) => key === 'sessionPersistence' ? {} : undefined }
  const abort = new AbortController()
  const settled = showSessionPicker(ctx, false, abort.signal, { ...io, openPager })
  await tick()
  const painted = io.writes.join('')
  assert.equal(painted.includes('正在读取历史会话'), true, `expected the loading line, got: ${painted.slice(-200)}`)
  assert.equal(painted.includes('main-session-9f1c'), false)
  release()
  await tick()
  abort.abort()
  await settled
})

// A row whose log cannot be read is resolved too (it carries its id and the
// unreadable note), so it still reaches the screen with the first page.
test('a page that only has unreadable rows still paints them', { timeout: 5_000 }, async () => {
  const io = pickerStreams()
  const page = [session('main-session-plain', { label: 'main-session-plain', unreadable: true })]
  const ctx = { get: (key) => key === 'sessionPersistence' ? {} : undefined }
  const abort = new AbortController()
  const settled = showSessionPicker(ctx, false, abort.signal, { ...io, openPager: pagerOptions([page]) })
  await tick()
  assert.equal(io.writes.join('').includes('main-session-plain'), true)
  abort.abort()
  await settled
})

// Item 1's rule, kept as a second line of defence: a placeholder label is
// never painted, whatever a reader hands back.
test('a placeholder label is held back even when a page carries one', { timeout: 5_000 }, async () => {
  const io = pickerStreams()
  const page = [
    session('main-session-plain', { label: 'main-session-plain', labelPending: true }),
    session('main-session-titled', { label: '已经有标题' }),
  ]
  const ctx = { get: (key) => key === 'sessionPersistence' ? {} : undefined }
  const abort = new AbortController()
  const settled = showSessionPicker(ctx, false, abort.signal, { ...io, openPager: pagerOptions([page]) })
  await tick()
  const painted = io.writes.join('')
  assert.equal(painted.includes('main-session-plain'), false, 'a raw id must not be painted')
  assert.equal(painted.includes('已经有标题'), true, 'the resolved row is painted')
  abort.abort()
  await settled
})

// The whole point of the lazy read: reaching the last loaded row is not a
// request for more, pressing past it is.
test('reaching the last row does not read more; pressing past it does', { timeout: 5_000 }, async () => {
  const io = pickerStreams()
  const pageOne = Array.from({ length: 3 }, (_, index) => session(`loaded-${index}`, { label: `已加载 ${index}` }))
  const pageTwo = [session('older-0', { label: '更早的一条' })]
  let pages = 0
  const openPager = pagerOptions([pageOne, pageTwo], () => { pages += 1 })
  const ctx = { get: (key) => key === 'sessionPersistence' ? {} : undefined }
  const abort = new AbortController()
  const settled = showSessionPicker(ctx, false, abort.signal, { ...io, openPager })
  await tick()
  assert.equal(pages, 1, 'only the first page was read')
  assert.equal(io.writes.join('').includes('还有 1 条未加载'), true, 'the count says what is left')
  io.type('\x1b[B')
  io.type('\x1b[B')
  await tick(10)
  assert.equal(pages, 1, 'arriving at the last row is not a request for more')
  io.type('\x1b[B')
  await tick()
  assert.equal(pages, 2, 'a press past the end reads the next page')
  assert.equal(io.writes.join('').includes('更早的一条'), true)
  abort.abort()
  await settled
})

test('End reads the next page', { timeout: 5_000 }, async () => {
  const io = pickerStreams()
  const pageOne = Array.from({ length: 3 }, (_, index) => session(`loaded-${index}`, { label: `已加载 ${index}` }))
  const pageTwo = [session('older-0', { label: '更早的一条' })]
  let pages = 0
  const openPager = pagerOptions([pageOne, pageTwo], () => { pages += 1 })
  const ctx = { get: (key) => key === 'sessionPersistence' ? {} : undefined }
  const abort = new AbortController()
  const settled = showSessionPicker(ctx, false, abort.signal, { ...io, openPager })
  await tick()
  io.type('\x1b[F')
  await tick()
  assert.equal(pages, 2, 'End asks for the end of the list')
  abort.abort()
  await settled
})

// Filtering is the other way to reach older sessions: a query that matches
// fewer rows than fit on screen keeps reading, page by page.
test('a filter deepens the search until a page of matches is loaded', { timeout: 5_000 }, async () => {
  const io = pickerStreams()
  const pageOne = Array.from({ length: 9 }, (_, index) => session(`noise-${index}`, { label: `杂项 ${index}` }))
  const pageTwo = [session('match-0', { label: '命中目标' })]
  const pageThree = [session('never', { label: '不该再读' })]
  let pages = 0
  const openPager = pagerOptions([pageOne, pageTwo, pageThree], () => { pages += 1 })
  const ctx = { get: (key) => key === 'sessionPersistence' ? {} : undefined }
  const abort = new AbortController()
  const settled = showSessionPicker(ctx, false, abort.signal, { ...io, openPager })
  await tick()
  io.type('命中')
  await tick(40)
  assert.ok(pages >= 2, `the filter had to look past the first page (read ${pages})`)
  assert.equal(io.writes.join('').includes('命中目标'), true)
  abort.abort()
  await settled
})

test('a filter that already has a page of matches reads no further', { timeout: 5_000 }, async () => {
  const io = pickerStreams()
  const pageOne = Array.from({ length: 9 }, (_, index) => session(`hit-${index}`, { label: `命中 ${index}` }))
  const pageTwo = [session('never', { label: '不该再读' })]
  let pages = 0
  const openPager = pagerOptions([pageOne, pageTwo], () => { pages += 1 })
  const ctx = { get: (key) => key === 'sessionPersistence' ? {} : undefined }
  const abort = new AbortController()
  const settled = showSessionPicker(ctx, false, abort.signal, { ...io, openPager })
  await tick()
  io.type('命中')
  await tick(30)
  assert.equal(pages, 1, 'nine matches already fill the page')
  assert.equal(io.writes.join('').includes('不该再读'), false)
  abort.abort()
  await settled
})

// Enter on a row that was read lazily still resumes it.
test('a session read by a lazy page can be resumed', { timeout: 5_000 }, async () => {
  const io = pickerStreams()
  const pageOne = Array.from({ length: 2 }, (_, index) => session(`loaded-${index}`, { label: `已加载 ${index}` }))
  const pageTwo = [session('older-9', { label: '更早的一条' })]
  const openPager = pagerOptions([pageOne, pageTwo])
  const ctx = { get: (key) => key === 'sessionPersistence' ? {} : undefined }
  const abort = new AbortController()
  const settled = showSessionPicker(ctx, false, abort.signal, { ...io, openPager })
  await tick()
  io.type('\x1b[B')       // row 2
  io.type('\x1b[B')       // past the last loaded row: reads the next page
  await tick()
  io.type('\x1b[B')       // now the newly loaded row
  io.type('\r')
  assert.deepEqual(await settled, { kind: 'resume', id: 'older-9' })
})
