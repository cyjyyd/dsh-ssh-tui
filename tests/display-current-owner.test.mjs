/**
 * W6B.F0 — no formerly claimed Display Relay may deliver frames after another
 * Relay owns the Host. The first (RED) test runs the existing real
 * DisplayHost.accept frame path with deterministic held socket end callbacks,
 * not a wall-clock race with the OS socket scheduler.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import {
  DisplayHost,
  FRAME_HELLO,
  FRAME_QUERY_REPLY,
  FRAME_STDIN,
  FrameReader,
  decodeQueryReply,
  encodeFrame,
  encodeMetrics,
  encodeProbeReply,
  encodeQuery,
  encodeResize,
  encodeRtt,
} from '../lib/display-sock.js'

/** A real EventEmitter data path, with the replaced socket's close held open. */
class PendingEndSocket extends EventEmitter {
  outgoing = []
  destroyed = false
  onEnd = undefined

  write(payload) {
    this.outgoing.push(Buffer.from(payload))
    return true
  }

  end(payload, callback) {
    if (payload !== undefined) this.write(payload)
    this.onEnd = callback
    return this
  }

  destroy() {
    if (this.destroyed) return this
    this.destroyed = true
    this.emit('close')
    return this
  }

  frames() {
    const reader = new FrameReader()
    return this.outgoing.flatMap(chunk => reader.push(chunk))
  }
}

/** Claim two relays without letting the old socket finish its async goodbye. */
function claimPair(handlers, options = {}) {
  const host = new DisplayHost('unused-w6bf0-test-path', handlers, options)
  const oldRelay = new PendingEndSocket()
  const currentRelay = new PendingEndSocket()
  // TypeScript's private accept is a normal method in the emitted JS, letting
  // this fixture deliberately control a narrow state-machine race.
  host.accept(oldRelay)
  oldRelay.emit('data', encodeFrame(FRAME_HELLO))
  host.accept(currentRelay)
  currentRelay.emit('data', encodeFrame(FRAME_HELLO))
  assert.equal(host.attached, true)
  assert.equal(typeof oldRelay.onEnd, 'function', 'former relay goodbye must be pending')
  return { host, oldRelay, currentRelay }
}

test('W6B.F0 stale stdin, resize, RTT and glyph metrics cannot reach the new Relay owner', t => {
  const input = []
  const sizes = []
  const rtts = []
  const glyphs = []
  const attaches = []
  const detaches = []
  const { oldRelay, currentRelay, host } = claimPair({
    onStdin: bytes => { input.push(String(bytes)) },
    onResize: (columns, rows) => { sizes.push([columns, rows]) },
    onRtt: value => { rtts.push(value) },
    onMetrics: value => { glyphs.push(value) },
    onAttach: () => { attaches.push(1) },
    onDetach: info => { detaches.push(info) },
  })
  t.after(() => { oldRelay.destroy(); currentRelay.destroy() })
  assert.equal(host.attached, true)
  assert.equal(attaches.length, 2)
  assert.deepEqual(detaches, [{ replaced: true }])

  // These are syntactically valid frames from the former, *claimed* relay. It
  // has not received its delayed end callback, so sending them is deterministic.
  oldRelay.emit('data', Buffer.concat([
    encodeFrame(FRAME_STDIN, Buffer.from('STALE')),
    encodeResize(17, 9),
    encodeRtt(777),
    encodeMetrics({ wide: true, reserve: false }),
  ]))
  assert.deepEqual(input, [], 'stale input cannot reach the active session')
  assert.deepEqual(sizes, [], 'stale resize cannot rewrite current terminal geometry')
  assert.deepEqual(rtts, [], 'stale RTT cannot overwrite the active link measurement')
  assert.deepEqual(glyphs, [], 'stale glyph metrics cannot be called current terminal evidence')

  currentRelay.emit('data', Buffer.concat([
    encodeFrame(FRAME_STDIN, Buffer.from('CURRENT')),
    encodeResize(100, 30),
    encodeRtt(45),
    encodeMetrics({ wide: false, reserve: true }),
  ]))
  assert.deepEqual(input, ['CURRENT'])
  assert.deepEqual(sizes, [[100, 30]])
  assert.deepEqual(rtts, [45])
  assert.deepEqual(glyphs, [{ wide: false, reserve: true }])
})

test('W6B.F0 old Relay cannot settle a live probe; non-claiming queries remain available', async t => {
  const { host, oldRelay, currentRelay } = claimPair({
    onStdin: () => {},
    onResize: () => {},
    onAttach: () => {},
    onDetach: () => {},
  }, { probeTimeoutMs: 200 })
  const query = new PendingEndSocket()
  t.after(() => { oldRelay.destroy(); currentRelay.destroy(); query.destroy() })

  const answer = host.attachmentVerdict()
  oldRelay.emit('data', encodeProbeReply('live'))
  // The current Relay did not answer the probe, so the old claim of 'live'
  // must not satisfy it. Its own 'unknown' response remains authoritative.
  currentRelay.emit('data', encodeProbeReply('unknown'))
  assert.equal(await answer, 'unknown')

  host.accept(query)
  query.emit('data', encodeQuery())
  // A non-claiming query must still round-trip the *current* terminal.
  currentRelay.emit('data', encodeProbeReply('live'))
  await nextTurn()
  const replies = query.frames().filter(frame => frame.type === FRAME_QUERY_REPLY)
  assert.equal(replies.length, 1, 'liveness query must get one reply')
  assert.equal(decodeQueryReply(replies[0].payload), 'attached')
  assert.equal(host.attached, true, 'query must not steal the display')
})
