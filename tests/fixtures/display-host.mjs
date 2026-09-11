// Minimal stand-in for a detached TUI Host: listens on the session display
// channel (a socket file on POSIX, a named pipe on Windows) until killed.
// Used by tests/display-host-e2e.test.mjs to cover the real spawn path.
import { DisplayHost, sessionSockPath } from '../../lib/display-sock.js'

const resume = process.argv.find(arg => arg.startsWith('--resume='))
const sessionId = resume === undefined ? 'unknown' : resume.slice('--resume='.length)

const host = new DisplayHost(sessionSockPath(sessionId), {
  onStdin: () => {},
  onResize: () => {},
  onDetach: () => {},
  onAttach: () => {},
})
await host.listen()

const stop = () => {
  void host.close().then(() => process.exit(0))
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
