#!/usr/bin/env node
/**
 * One real boot used to let the product repair a profile before a PTY probe.
 *
 * The first-install repair runs in the TUI, not in `dsh plugin add`. A probe that
 * starts immediately on a fresh home therefore sees the one boot before the
 * repaired composition exists — and HMR may be recomposing the tree while the
 * probe is typing. This boot is not a pre-fill: it runs the same TUI the user
 * gets, waits for the workspace (or the wizard), then exits through `/exit`.
 * The actual probe starts after it, as a normal restart, and sees the rows the
 * product wrote.
 *
 * `probe-home.mjs` runs this only for a configured home; an unconfigured home
 * must reach the wizard itself.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const home = process.env.PROBE_HOME ?? process.env.DSH_HOME
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function loadPty() {
  try {
    return await import(require.resolve('node-pty', { paths: [process.cwd()] })).then(mod => mod.default ?? mod)
  } catch {
    return undefined
  }
}

if (home === undefined) {
  console.log('SKIP: tui-prime-probe needs PROBE_HOME')
  process.exit(0)
}
const pty = await loadPty()
if (pty === undefined) {
  // The real probe treats a missing pty as a skip too; do not turn a machine
  // without node-pty into a bootstrap failure.
  console.log('SKIP: node-pty is unavailable')
  process.exit(0)
}

const term = pty.spawn(process.execPath, [CLI, '--profile', 'tui'], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSH_HOME: home,
    TERM: 'xterm-256color',
    DSH_TUI_NO_UPDATE_CHECK: '1',
    SSH_CONNECTION: '10.0.0.2 55555 10.0.0.1 22',
    SSH_TTY: '/dev/pts/9',
  },
})
let output = ''
let exited
term.onData(chunk => { output += chunk })
term.onExit(event => { exited = event })
const waitFor = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(100)
  }
  return false
}

try {
  const started = await waitFor(
    () => /目录:|目录：|❯|安装向导|Setup \d\/9/u.test(output),
    60_000,
  )
  if (!started) {
    console.error('FAIL: the prime boot painted neither the workspace nor the wizard')
    console.error(output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, '').slice(-1200))
    process.exitCode = 1
  } else if (/安装向导|Setup \d\/9/u.test(output)) {
    // This home is unconfigured. The setup probe owns that path; leave without
    // pretending the prime boot repaired anything.
    console.log('SKIP: the home is unconfigured, so the wizard owns this boot')
  } else {
    // Let the boot repair and its notification settle before `/exit`: the next
    // process is the restart the user would perform after reading it.
    await delay(2_000)
    term.write('/exit\r')
    const done = await waitFor(() => exited !== undefined, 20_000)
    if (!done) {
      console.error('FAIL: the prime boot did not exit after /exit')
      console.error(output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, '').slice(-1200))
      process.exitCode = 1
    } else if (exited.exitCode !== 0) {
      console.error(`FAIL: the prime boot exited ${exited.exitCode}`)
      process.exitCode = 1
    } else {
      console.log('OK: prime boot reached the workspace and exited; the probe will start on the restart')
    }
  }
} finally {
  try { term.kill() } catch { /* already gone */ }
}
