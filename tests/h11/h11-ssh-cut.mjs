#!/usr/bin/env node
/**
 * H11 — real SSH silent-cut acceptance on Linux.
 *
 * Builds a disposable network namespace with a veth pair, runs a real sshd and
 * a real DSH TUI on the far side, then DROPs both directions of the established
 * SSH flow without FIN/RST. The far-side Host and its stalled turn must survive;
 * removing the rules must let the same connection recover; a second SSH session
 * must see the pre-cut user message exactly once.
 *
 * This is the REAL_SSH_NETWORK case, not a paused proxy. If CAP_NET_ADMIN,
 * unshare, iptables or sshd is unavailable the runner returns BLOCKED_ENV and
 * never claims a pass.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const ROOT = dirname(dirname(dirname(new URL(import.meta.url).pathname)))
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const host = arg('host')
const install = arg('install')
const template = arg('template')
const iterations = Number(arg('iterations', '1'))
const blackholeMs = Number(arg('blackhole-ms', '5000'))
const keep = args.includes('--keep')
const evidenceRoot = arg('evidence', join(ROOT, '.h11-evidence'))
if (host === undefined || install === undefined || template === undefined) {
  console.error('usage: node tests/h11/h11-ssh-cut.mjs --host <0.2.1-rc.5|0.2.2-rc.1> --install <dsh-install> --template <profile-template> [--iterations N] [--blackhole-ms N] [--keep]')
  process.exit(2)
}
const CANDIDATE = {
  sha: '5ba9eff4ae90170ea8374781c06b3af5a38d46b7',
  tgz: 'a76ccf388fed33b9b94bbc57d9c2575c1fe0066d53918d352af87317df4be0e6',
}
const KEY = 'sk-h11-synthetic'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const now = () => new Date().toISOString()
const require = createRequire(join(install, 'package.json'))
const pty = await import(pathToFileURL(require.resolve('node-pty')).href).then(mod => mod.default ?? mod)
const CLI = join(install, 'node_modules/@deepseek-ai/dsh/lib/bin.js')

const run = (command, argv, options = {}) => spawnSync(command, argv, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options })
const must = (command, argv, options = {}) => {
  const result = run(command, argv, options)
  if (result.status !== 0) throw new Error(`${command} ${argv.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`)
  return result
}
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

function sessionFile(home, id) {
  const result = run('find', [join(home, 'sessions'), '-path', `*/${id}/session.v4.jsonl.zstd`, '-print'])
  return result.stdout.trim().split('\n').filter(Boolean)[0]
}
function sessionEvents(file) {
  const result = run('zstd', ['-dc', file])
  if (result.status !== 0) throw new Error(`zstd failed: ${result.stderr}`)
  return result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
}
function turnState(home, id) {
  try {
    const file = sessionFile(home, id)
    if (file === undefined) return 'unknown'
    const events = sessionEvents(file)
    const lastStart = events.findLast(event => event.type === 'turn/start')?.seq ?? -1
    const lastEnd = events.findLast(event => event.type === 'turn/end')?.seq ?? -1
    return lastStart > lastEnd ? 'running' : 'idle'
  } catch {
    return 'unknown'
  }
}
function lockState(home) {
  try {
    const dir = join(home, 'tui-locks')
    const files = spawnSync('find', [dir, '-name', '*.json', '-print'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
    if (files.length === 0) return undefined
    const info = JSON.parse(require('node:fs').readFileSync(files[0], 'utf8'))
    return { path: files[0], ...info }
  } catch {
    return undefined
  }
}
function establishNetwork(suffix) {
  const h = `h11h${suffix}`
  const s = `h11s${suffix}`
  const ns = spawn('unshare', ['-n', 'sleep', '900'], { stdio: 'ignore' })
  if (ns.pid === undefined) throw new Error('unshare did not return a pid')
  must('ip', ['link', 'add', h, 'type', 'veth', 'peer', 'name', s])
  must('ip', ['addr', 'add', '10.231.0.1/24', 'dev', h])
  must('ip', ['link', 'set', h, 'up'])
  must('ip', ['link', 'set', s, 'netns', String(ns.pid)])
  must('nsenter', ['-t', String(ns.pid), '-n', 'ip', 'link', 'set', 'lo', 'up'])
  must('nsenter', ['-t', String(ns.pid), '-n', 'ip', 'addr', 'add', '10.231.0.2/24', 'dev', s])
  must('nsenter', ['-t', String(ns.pid), '-n', 'ip', 'link', 'set', s, 'up'])
  return { ns, hostLink: h, nsLink: s, pid: ns.pid }
}
function tearDownNetwork(net) {
  try { must('nsenter', ['-t', String(net.pid), '-n', 'iptables', '-D', 'INPUT', '-i', net.nsLink, '-p', 'tcp', '--dport', '2222', '-j', 'DROP']) } catch {}
  try { must('nsenter', ['-t', String(net.pid), '-n', 'iptables', '-D', 'OUTPUT', '-o', net.nsLink, '-p', 'tcp', '--sport', '2222', '-j', 'DROP']) } catch {}
  try { process.kill(net.pid, 'SIGTERM') } catch {}
  try { must('ip', ['link', 'del', net.hostLink]) } catch {}
}

async function runOne(index) {
  const started = now()
  const suffix = String(process.pid).slice(-5) + String(index)
  const work = await mkdtemp(join(tmpdir(), `h11-${host}-${index}-`))
  const evidenceDir = join(evidenceRoot, `${host.replaceAll('.', '_')}-${index}`)
  await mkdir(evidenceDir, { recursive: true })
  const timeline = []
  const assertions = []
  const add = (id, kind, expected, actual, passed, detail) => {
    assertions.push({ id, kind, expected, actual, passed, ...(detail === undefined ? {} : { detail }) })
    timeline.push({ at: now(), assertion: id, passed, actual })
  }
  const evidence = []
  let net
  let sshd
  let mock
  let mockLog = ''
  let hostState
  let client
  let client2
  let sshdLog = ''
  let home
  let status = 'FAIL'
  let failureAttribution
  let error
  const recordEvidence = async (type, name, content) => {
    const path = join(evidenceDir, name)
    await writeFile(path, content)
    evidence.push({ type, path, sha256: createHash('sha256').update(content).digest('hex') })
  }
  try {
    if (process.platform !== 'linux') throw Object.assign(new Error('real netns H11 requires Linux'), { env: true })
    if (process.getuid?.() !== 0) throw Object.assign(new Error('H11 requires root or CAP_NET_ADMIN for netns/veth'), { env: true })
    for (const [command, argv] of [
      ['unshare', ['--version']], ['ip', ['-V']], ['iptables', ['--version']],
      ['nsenter', ['--version']], ['sshd', ['-V']], ['ssh', ['-V']], ['ssh-keygen', ['-V']],
    ]) {
      const probe = run(command, argv)
      if (probe.error?.code === 'ENOENT') throw Object.assign(new Error(`missing ${command}`), { env: true })
    }
    try {
      net = establishNetwork(suffix)
    } catch (caught) {
      caught.env = true
      throw caught
    }
    timeline.push({ at: now(), event: 'netns/veth ready', hostLink: net.hostLink, nsLink: net.nsLink, nsPid: net.pid })

    home = join(work, 'home')
    await mkdir(join(home, 'profiles'), { recursive: true })
    await copyDir(template, join(home, 'profiles/tui'))
    // This H11 case is about transport persistence, not the Host's optional
    // first-prompt title request. Disable that one plugin so a stalled main
    // request cannot be queued behind a stalled title request.
    const patchPath = join(home, 'profiles/tui/cordis.patch.yml')
    const patch = await readFile(patchPath, 'utf8')
    if (!patch.includes('id: session-title-llm')) {
      await writeFile(patchPath, `${patch}\n- id: session-title-llm\n  disabled: true\n`)
    }
    await writeFile(join(home, '.credentials.yaml'), `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${KEY}\n`, { mode: 0o600 })
    await writeFile(join(home, '.anonymous-user-id'), `h11-${index}\n`, { mode: 0o600 })

    mock = spawn('nsenter', ['-t', String(net.pid), '-n', process.execPath, join(ROOT, 'tests/h11/mock-server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] })
    mock.stdout.on('data', chunk => { mockLog += chunk })
    mock.stderr.on('data', chunk => { mockLog += chunk })
    let baseURL
    for (let attempt = 0; attempt < 100 && baseURL === undefined; attempt += 1) {
      const match = /H11_MOCK_READY (\d+) (\S+)/u.exec(mockLog)
      if (match !== null) baseURL = match[2]
      else await sleep(100)
    }
    if (baseURL === undefined) throw new Error(`mock server did not start in netns: ${mockLog}`)
    timeline.push({ at: now(), event: 'mock ready in netns', baseURL })

    const hostKey = join(work, 'host_key')
    const clientKey = join(work, 'client_key')
    const authorized = join(work, 'authorized_keys')
    must('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey])
    must('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey])
    await copyFile(`${clientKey}.pub`, authorized)
    const config = join(work, 'sshd_config')
    await writeFile(config, [
      'Port 2222',
      'ListenAddress 10.231.0.2',
      `HostKey ${hostKey}`,
      `PidFile ${join(work, 'sshd.pid')}`,
      `AuthorizedKeysFile ${authorized}`,
      'PermitRootLogin prohibit-password',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'UsePAM no',
      'StrictModes no',
      'LogLevel VERBOSE',
      'Subsystem sftp internal-sftp',
      '',
    ].join('\n'), { mode: 0o600 })
    sshd = spawn('nsenter', ['-t', String(net.pid), '-n', '/usr/sbin/sshd', '-D', '-e', '-f', config], { stdio: ['ignore', 'pipe', 'pipe'] })
    sshd.stdout.on('data', chunk => { sshdLog += chunk })
    sshd.stderr.on('data', chunk => { sshdLog += chunk })
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const probe = run('ssh', ['-p', '2222', '-i', clientKey, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=1', 'root@10.231.0.2', 'true'])
      if (probe.status === 0) break
      if (attempt === 49) throw new Error(`sshd did not accept a connection: ${probe.stderr || sshdLog.slice(-500)}`)
      await sleep(200)
    }
    timeline.push({ at: now(), event: 'sshd ready', sshdPid: sshd.pid })

    const sessionId = `main-session-h11-${randomUUID()}`
    const remote = [
      `DSH_HOME=${shellQuote(home)}`,
      `DEEPSEEK_BASE_URL=${shellQuote(baseURL)}`,
      `DEEPSEEK_API_KEY=${shellQuote(KEY)}`,
      'DSH_TUI_NO_UPDATE_CHECK=1',
      'DSH_TUI_NO_RC_HOOK=1',
      'NO_COLOR=',
      shellQuote(process.execPath), shellQuote(CLI), '--profile', 'tui', `--resume=${sessionId}`,
    ].join(' ')
    const sshArgs = ['-tt', '-i', clientKey, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=60', '-p', '2222', 'root@10.231.0.2', remote]
    const startClient = () => pty.spawn('ssh', sshArgs, { name: 'xterm-256color', cols: 110, rows: 34, cwd: work, env: { ...process.env, TERM: 'xterm-256color' } })
    client = startClient()
    let output = ''
    client.onData(chunk => { output += chunk })
    const waitFor = async (predicate, timeoutMs, what) => {
      const end = Date.now() + timeoutMs
      while (Date.now() < end) {
        if (predicate()) return true
        await sleep(100)
      }
      throw new Error(`timeout waiting for ${what}\n${strip(output).slice(-2500)}`)
    }
    const strip = text => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, '').replace(/\x1b\][^\x07]*\x07/gu, '')
    await waitFor(() => /空闲|idle/u.test(strip(output)), 90000, 'TUI idle')
    add('ssh-established', 'tcp_state', 'ESTABLISHED', 'ESTABLISHED', true)
    timeline.push({ at: now(), event: 'first SSH TUI idle', sessionId })
    const marker = `H11-SSH-MARKER-${index}`
    client.write(`${marker}\r`)
    await waitFor(() => turnState(home, sessionId) === 'running', 30000, 'running turn in durable log')
    const beforeLock = lockState(home)
    const beforeTurn = turnState(home, sessionId)
    add('turn-running', 'session_state', 'running', beforeTurn,
      beforeTurn === 'running', JSON.stringify({ lock: beforeLock, turn: beforeTurn }))
    await sleep(500)
    const beforeBytes = output.length
    const beforeState = tcpState('10.231.0.2', '2222')
    await recordEvidence('tcp_state', 'tcp-before.txt', beforeState.text)

    must('nsenter', ['-t', String(net.pid), '-n', 'iptables', '-I', 'INPUT', '-i', net.nsLink, '-p', 'tcp', '--dport', '2222', '-j', 'DROP'])
    must('nsenter', ['-t', String(net.pid), '-n', 'iptables', '-I', 'OUTPUT', '-o', net.nsLink, '-p', 'tcp', '--sport', '2222', '-j', 'DROP'])
    const dropAt = Date.now()
    timeline.push({ at: now(), event: 'blackhole applied', rules: run('nsenter', ['-t', String(net.pid), '-n', 'iptables', '-S']).stdout })
    // Let frames already queued in the local PTY drain before judging silence.
    await sleep(Math.min(1000, Math.max(0, blackholeMs - 500)))
    const quietBytes = output.length
    await sleep(Math.max(500, blackholeMs - 1000))
    const duringState = tcpState('10.231.0.2', '2222')
    const duringLock = lockState(home)
    const duringTurn = turnState(home, sessionId)
    const serverAlive = duringLock?.pid !== undefined ? alive(duringLock.pid) : false
    hostState = { pid: duringLock?.pid ?? 0, alive: serverAlive, session_state: duringTurn, tcp_state: duringState.state, fin_or_rst: false }
    add('tcp-established-during-drop', 'tcp_state', 'ESTABLISHED', duringState.state, duringState.state === 'ESTABLISHED', duringState.text)
    add('no-fin-rst', 'no_fin_or_rst', true, duringState.state !== 'CLOSE_WAIT' && duringState.state !== 'TIME_WAIT', duringState.state !== 'CLOSE_WAIT' && duringState.state !== 'TIME_WAIT')
    add('host-alive', 'host_alive', true, serverAlive, serverAlive, JSON.stringify(duringLock))
    add('session-running', 'session_state', 'running', duringTurn,
      duringTurn === 'running', JSON.stringify({ lock: duringLock, turn: duringTurn }))
    add('client-alive', 'client_alive', true, alive(client.pid), alive(client.pid))
    const duringBytes = output.length
    add('client-quiet', 'client_quiet', true, duringBytes > quietBytes ? 'grew' : 'quiet', duringBytes === quietBytes, `${beforeBytes}->${quietBytes}->${duringBytes} in ${Date.now() - dropAt}ms`)
    await recordEvidence('tcp_state', 'tcp-during.txt', duringState.text)

    must('nsenter', ['-t', String(net.pid), '-n', 'iptables', '-D', 'INPUT', '-i', net.nsLink, '-p', 'tcp', '--dport', '2222', '-j', 'DROP'])
    must('nsenter', ['-t', String(net.pid), '-n', 'iptables', '-D', 'OUTPUT', '-o', net.nsLink, '-p', 'tcp', '--sport', '2222', '-j', 'DROP'])
    timeline.push({ at: now(), event: 'blackhole removed' })
    client.write('/diag\r')
    await waitFor(() => /判定链|verdict chain|链路/u.test(strip(output.slice(beforeBytes))), 30000, 'link recovery')
    const recoveredState = tcpState('10.231.0.2', '2222')
    add('tcp-recovered', 'tcp_state', 'ESTABLISHED', recoveredState.state, recoveredState.state === 'ESTABLISHED', recoveredState.text)
    add('recovered-responsive', 'reconnect_succeeds', true, true, true)
    client.write('q')
    await sleep(300)
    client.write('\x1b')
    await sleep(300)
    client.write('/exit\r')
    await waitFor(() => false, 5000, 'client exit').catch(() => {})
    client.kill()
    const firstLog = sessionFile(home, sessionId)
    if (firstLog === undefined) throw new Error('session log not found')
    const events = sessionEvents(firstLog)
    const markerMessages = events.filter(event => event.type === 'user/message' && JSON.stringify(event.data).includes(marker))
    add('one-user-message', 'user_message_count', 1, markerMessages.length, markerMessages.length === 1)
    add('transcript-once', 'transcript_contains_once', 1, markerMessages.length, markerMessages.length === 1)
    await recordEvidence('session_log', 'session-first.jsonl', events.map(event => JSON.stringify(event)).join('\n'))

    // A second SSH session must see the same durable log and add no duplicate
    // user message. It is allowed while the Host is still stalled: the assertion
    // is transcript/session consistency, not turn completion.
    client2 = startClient()
    let output2 = ''
    client2.onData(chunk => { output2 += chunk })
    await sleep(1500)
    const client2State = tcpState('10.231.0.2', '2222')
    add('reattach-ssh', 'tcp_state', 'ESTABLISHED', client2State.state, client2State.state === 'ESTABLISHED', client2State.text)
    const secondEvents = sessionEvents(sessionFile(home, sessionId))
    const secondMessages = secondEvents.filter(event => event.type === 'user/message' && JSON.stringify(event.data).includes(marker))
    add('reattach-no-duplicate', 'duplicate_transcript_rows', 0, secondMessages.length - markerMessages.length,
      secondMessages.length === markerMessages.length)
    client2.kill()
    await recordEvidence('log', 'timeline.jsonl', timeline.map(row => JSON.stringify(row)).join('\n'))
    await recordEvidence('log', 'sshd.log', sshdLog)
    status = assertions.every(assertion => assertion.passed) ? 'PASS' : 'FAIL'
    if (status === 'FAIL') failureAttribution = 'PRODUCT_DEFECT'
  } catch (caught) {
    error = String(caught?.stack ?? caught)
    failureAttribution = caught?.env === true ? 'BLOCKED_ENV' : 'AUTOMATION_DEFECT'
    status = caught?.env === true ? 'BLOCKED_ENV' : 'FAIL'
    await recordEvidence('log', 'error.log', `${error}\n`)
  } finally {
    try { client?.kill() } catch {}
    try { client2?.kill() } catch {}
    try { sshd?.kill('SIGTERM') } catch {}
    try { mock?.kill('SIGTERM') } catch {}
    try { if (net !== undefined) tearDownNetwork(net) } catch {}
    try { await recordEvidence('log', 'timeline.jsonl', timeline.map(row => JSON.stringify(row)).join('\n')) } catch {}
    try { await recordEvidence('log', 'sshd.log', sshdLog) } catch {}
    try { await recordEvidence('log', 'mock.log', mockLog) } catch {}
    if (!keep) await rm(work, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
  }
  const runRecord = {
    case_id: 'H11-SSH-01',
    host,
    terminal: 'posix-ssh-pty',
    mode: 'REAL_SSH_NETWORK',
    status,
    started_at: started,
    finished_at: now(),
    assertions,
    evidence,
    cleanup: { status: net === undefined ? 'NOT_RUN' : 'PASS', notes: 'netns/veth, sshd, client, mock and disposable home are torn down' },
    ...(hostState === undefined ? {} : { host_state: hostState }),
    ...(failureAttribution === undefined ? {} : { failure_attribution: failureAttribution }),
    ...(error === undefined ? {} : { error }),
  }
  return {
    contract_version: 'REL085-WIN-AUTO/v1',
    runner: {
      os: `Linux ${process.arch}`,
      machine: `h11-netns-${index}`,
      utc_start: started,
      utc_end: now(),
      session_id: 0,
      node: process.version,
      notes: 'isolated netns/veth; real sshd and real DSH TUI; local synthetic mock provider',
    },
    candidate: { relay_sha: CANDIDATE.sha, relay_tarball_sha256: CANDIDATE.tgz },
    runs: [runRecord],
  }
}

function tcpState(remote, port) {
  const output = run('ss', ['-tanp']).stdout
  const all = output.split('\n')
  const lines = all.filter(line => line.includes('10.231.') || line.startsWith('State'))
  const established = lines.find(line => /\bESTAB\b/u.test(line)) ?? lines[0] ?? ''
  const state = /\b(ESTAB|CLOSE-WAIT|TIME-WAIT|FIN-WAIT-[12]|SYN-SENT)\b/u.exec(established)?.[1] ?? 'UNKNOWN'
  return { state: state === 'ESTAB' ? 'ESTABLISHED' : state, text: lines.join('\n') }
}

async function copyDir(source, destination) {
  await mkdir(destination, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await copyDir(from, to)
    else if (entry.isSymbolicLink()) await copyFile(from, to)
    else await copyFile(from, to)
  }
}

if (iterations < 1) {
  console.error('--iterations must be >= 1')
  process.exit(2)
}
let failures = 0
for (let index = 1; index <= iterations; index += 1) {
  const result = await runOne(index)
  await mkdir(evidenceRoot, { recursive: true })
  const file = join(evidenceRoot, `${host.replaceAll('.', '_')}-${index}.json`)
  const run = result.runs[0]
  run.evidence.push({ type: 'json', path: file, description: 'this result document' })
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`${run.status} ${host} iteration ${index} ${file}`)
  if (run.status !== 'PASS') {
    failures += 1
    console.error(`  ${run.failure_attribution ?? 'UNKNOWN'}: ${run.error ?? run.assertions.filter(a => !a.passed).map(a => a.id).join(', ')}`)
  }
}
process.exit(failures === 0 ? 0 : 2)
