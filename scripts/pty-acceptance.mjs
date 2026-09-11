/**
 * Child half of the PTY acceptance check (see `pty-acceptance.py`).
 *
 * Runs the real `runDisplayRelay` on a real TTY against a fake Host and prints
 * what the Host received plus the measured round-trip. Requires a built `lib/`
 * (`npm run build`).
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  decodeRtt,
  encodeFrame,
  FRAME_GOODBYE,
  FRAME_HELLO,
  FRAME_RTT,
  FRAME_STDIN,
  FrameReader,
  runDisplayRelay,
  sessionSockPath,
} from '../lib/display-sock.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-pty-'))
const path = sessionSockPath('pty-session', home)
mkdirSync(dirname(path), { recursive: true, mode: 0o700 })

const received = []
let rtt
let socket
let sawHello = false
const server = createServer(connection => {
  socket = connection
  const reader = new FrameReader()
  connection.on('data', chunk => {
    for (const frame of reader.push(chunk)) {
      if (frame.type === FRAME_STDIN) received.push(frame.payload.toString())
      if (frame.type === FRAME_RTT) rtt = decodeRtt(frame.payload)
      if (frame.type === FRAME_HELLO) sawHello = true
    }
  })
})

server.listen(path, async () => {
  // End the attachment from the Host side once the relay has actually handed
  // over and the captured typing has arrived; a fixed timer would cut a slow
  // link's measurement short.
  const started = Date.now()
  const goodbyes = setInterval(() => {
    const ready = sawHello && (received.length > 0 || Date.now() - started > 6_000)
    if (!ready) return
    clearInterval(goodbyes)
    try {
      socket?.write(encodeFrame(FRAME_GOODBYE))
    } catch {
      // the relay may already be gone
    }
  }, 100)
  goodbyes.unref?.()
  const result = await runDisplayRelay(path, { ssh: true })
  process.stderr.write(`\nRESULT ${JSON.stringify({ received, rtt, reason: result.reason })}\n`)
  server.close()
  setTimeout(() => process.exit(0), 50)
})
