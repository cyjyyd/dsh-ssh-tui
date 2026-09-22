import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bootstrapEnv,
  encodePowerShellCommand,
  hiddenConsoleHostScript,
  hostBootstrapCommand,
  hostHasOwnConsole,
  hostSpawnOptions,
  psQuote,
  TUI_HOST_START_BOOTSTRAP,
  TUI_HOST_START_ENV,
  windowsCommandLine,
  windowsPowerShellPath,
} from '../lib/platform.js'
import {
  sessionBootstrapPidPath,
  sessionSockPath,
  spawnDetachedHost,
  spawnHostThroughBootstrap,
} from '../lib/display-sock.js'

/**
 * P1-4: the Windows Host has to survive the launcher *and* not flash console
 * windows. A direct spawn cannot do both (libuv's `KILL_ON_JOB_CLOSE` job takes
 * a non-detached child with it; `detached` is DETACHED_PROCESS, which makes
 * Windows ignore `CREATE_NO_WINDOW`), so on Windows the Host is started through
 * the OS PowerShell with `Start-Process -WindowStyle Hidden`: a console of its
 * own, invisible, outside this process's job.
 *
 * Everything up to the spawn is pure and asserted here on Linux. What only a
 * real Windows run can prove — that the Host really does outlive the window —
 * is asserted by `scripts/tui-mock-probe.mjs --busy` on the `test-windows` leg.
 */

test('a Windows command line is quoted the way CreateProcess parses it back', () => {
  assert.equal(windowsCommandLine(['node.exe', '--resume=abc']), 'node.exe --resume=abc')
  // A DSH_HOME with a space is the normal case, not the exotic one.
  assert.equal(
    windowsCommandLine(['C:\\Program Files\\dsh\\node.exe', 'C:\\Users\\me\\my home\\bin.js']),
    '"C:\\Program Files\\dsh\\node.exe" "C:\\Users\\me\\my home\\bin.js"',
  )
  assert.equal(windowsCommandLine(['']), '""')
  // Backslashes before a quote are doubled, and so are trailing ones (the
  // closing quote would otherwise be escaped by the argument's own backslash).
  assert.equal(windowsCommandLine(['a"b']), '"a\\"b"')
  assert.equal(windowsCommandLine(['a b\\']), '"a b\\\\"')
  assert.equal(windowsCommandLine(['a\\"b']), '"a\\\\\\"b"')
  // No whitespace or quote: left exactly as it came in, backslashes untouched.
  assert.equal(windowsCommandLine(['C:\\x\\y']), 'C:\\x\\y')
})

test('PowerShell literals are single-quoted with the one escape it has', () => {
  assert.equal(psQuote('C:\\Users\\me'), "'C:\\Users\\me'")
  assert.equal(psQuote("it's"), "'it''s'")
  // A command injection attempt stays inside the literal.
  assert.equal(psQuote("'; Remove-Item C:\\ -Recurse; '"), "'''; Remove-Item C:\\ -Recurse; '''")
})

test('the bootstrap script asks for a hidden console and prints the pid', () => {
  const script = hiddenConsoleHostScript({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    argv: ['C:\\Users\\me\\my home\\bin.js', '--resume=s1'],
    pidFile: 'C:\\pids\\s.pid',
  })
  assert.match(script, /Start-Process -FilePath 'C:\\Program Files\\nodejs\\node\.exe'/u)
  assert.match(script, /-WindowStyle Hidden -PassThru/u)
  assert.match(script, /-ArgumentList '"C:\\Program Files\\nodejs\\node\.exe"\.\.\./u.test(script) ? /./u : /-ArgumentList/u)
  // The Host's own argv travels as one already-quoted command line, because
  // Start-Process adds no quoting of its own.
  assert.ok(script.includes(`"C:\\Users\\me\\my home\\bin.js" --resume=s1`), script)
  // The pid goes to a file, never to stdout: whoever reads a pipe the Host
  // inherited would wait for the Host to exit instead of the bootstrap.
  assert.match(script, /\[IO\.File\]::WriteAllText\('C:\\pids\\s\.pid', \[string\]\$dshHost\.Id\)/u)
  assert.doesNotMatch(script, /\[Console\]::Out/u)
  // `$host` is a PowerShell automatic variable; the script must not shadow it.
  assert.doesNotMatch(script, /\$host\b/u)
  assert.doesNotMatch(script, /RedirectStandardError/u)
  assert.match(
    hiddenConsoleHostScript({
      execPath: 'n.exe', argv: [], pidFile: 'p.pid', stderrFile: "C:\\log's\\s.err",
    }),
    /-RedirectStandardError 'C:\\log''s\\s\.err'/u,
  )
})

test('the encoded command is base64 of UTF-16LE, so no shell re-parses the script', () => {
  const script = hiddenConsoleHostScript({ execPath: 'n.exe', argv: ['a b'], pidFile: 'p.pid' })
  const encoded = encodePowerShellCommand(script)
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script)
  assert.match(encoded, /^[A-Za-z0-9+/]+=*$/u)
})

test('the OS PowerShell is found from SystemRoot, and only when it exists', () => {
  assert.equal(
    windowsPowerShellPath({ SystemRoot: 'C:\\Windows' }),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  )
  assert.equal(
    windowsPowerShellPath({ windir: 'D:\\Win' }),
    'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  )
  assert.equal(windowsPowerShellPath({}), undefined)
  assert.equal(windowsPowerShellPath({ SystemRoot: '   ' }), undefined)
})

test('the bootstrap is Windows-only and falls back when PowerShell is absent', () => {
  const base = {
    execPath: 'C:\\node.exe',
    argv: ['bin.js'],
    pidFile: 'C:\\pids\\s.pid',
    env: { SystemRoot: 'C:\\Windows' },
  }
  assert.equal(hostBootstrapCommand({ ...base, platform: 'linux' }), undefined)
  assert.equal(hostBootstrapCommand({ ...base, platform: 'darwin' }), undefined)
  assert.equal(hostBootstrapCommand({ ...base, platform: 'win32', exists: () => false }), undefined)
  const windows = hostBootstrapCommand({ ...base, platform: 'win32', exists: () => true })
  assert.equal(windows.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.deepEqual(windows.args.slice(0, 5), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
  ])
  const script = Buffer.from(windows.args[5], 'base64').toString('utf16le')
  assert.ok(script.includes("C:\\node.exe"), script)
  assert.ok(script.includes('bin.js'), script)
})

test('a bootstrap that reports a pid is taken, and its pid is what gets watched', async () => {
  const pidFile = sessionBootstrapPidPath('bootstrap-pid-test')
  const spawned = spawnDetachedHost('bootstrap-pid-test', 'linux', {
    // A real, long-lived process this process did not spawn: the shell writes
    // the pid of the backgrounded sleep, exactly like the bootstrap writes the
    // Host's id.
    bootstrap: {
      command: '/bin/sh',
      args: ['-c', `sleep 30 & echo $! > ${pidFile}`],
    },
  })
  assert.equal(Number.isInteger(spawned.pid) && spawned.pid > 0, true)
  assert.equal(spawned.exitWatch !== undefined, true)
  let alive = true
  try {
    process.kill(spawned.pid, 0)
  } catch {
    alive = false
  }
  assert.equal(alive, true, 'the pid the bootstrap printed must be a live process')
  // The watch is what reports a Host that dies before its display socket
  // appears; with no ChildProcess handle the pid is all there is.
  process.kill(spawned.pid, 'SIGKILL')
  assert.equal(await spawned.exitWatch.exited, null)
  spawned.exitWatch.dispose()
  assert.equal(spawned.sock, sessionSockPath('bootstrap-pid-test'))
})

test('a bootstrap that starts nothing falls back instead of reporting a failure', () => {
  // Exit 0 with no pid: `Start-Process` never ran (it throws rather than
  // returning nothing), so there is no Host to duplicate.
  const options = pidFile => ({ env: {}, platform: 'linux', timeoutMs: 5_000, pidFile })
  assert.equal(
    spawnHostThroughBootstrap({ command: '/bin/sh', args: ['-c', 'true'] }, options('/tmp/nope.pid')),
    undefined,
  )
  // A missing interpreter is the same story.
  assert.equal(
    spawnHostThroughBootstrap({ command: '/nonexistent/powershell', args: [] }, options('/tmp/nope.pid')),
    undefined,
  )
  // A non-zero exit is PowerShell failing before it started anything.
  assert.equal(
    spawnHostThroughBootstrap({ command: '/bin/sh', args: ['-c', 'exit 3'] }, options('/tmp/nope.pid')),
    undefined,
  )
})

test('a bootstrap that hangs reports instead of starting a second Host', () => {
  // The one case that must not fall back: a Host may exist and its pid was
  // lost. Starting another one would put two Hosts on one session.
  assert.throws(
    () => spawnHostThroughBootstrap(
      { command: '/bin/sh', args: ['-c', 'sleep 30'] },
      { env: {}, platform: 'win32', timeoutMs: 400, pidFile: '/tmp/hang.pid' },
    ),
    /did not report a host pid in 400ms; refusing to start a second host/u,
  )
})

test('the fallback spawn keeps the properties the direct path always had', () => {
  // `detached: false` + `windowsHide: true` is what the bootstrap exists to
  // work around; it must stay the documented shape of the fallback.
  assert.deepEqual(hostSpawnOptions('win32'), { detached: false, windowsHide: true })
  assert.deepEqual(hostSpawnOptions('linux'), { detached: true, windowsHide: true })
})

test('the Host is told how it was started, and only the fallback build warns', () => {
  // The marker the bootstrap adds rides `Start-Process`'s inherited environment.
  const env = bootstrapEnv({ DSH_HOME: 'C:\\dsh' })
  assert.equal(env[TUI_HOST_START_ENV], TUI_HOST_START_BOOTSTRAP)
  assert.equal(env.DSH_HOME, 'C:\\dsh', 'the rest of the environment must pass through')
  // POSIX survives its terminal whatever the marker says; a bootstrapped
  // Windows Host survives too. The direct Windows child is the one that dies
  // with the window, so it is the one the TUI warns about at boot.
  assert.equal(hostHasOwnConsole(env, 'linux'), true)
  assert.equal(hostHasOwnConsole({}, 'darwin'), true)
  assert.equal(hostHasOwnConsole(env, 'win32'), true)
  assert.equal(hostHasOwnConsole({}, 'win32'), false)
  assert.equal(hostHasOwnConsole({ [TUI_HOST_START_ENV]: 'something-else' }, 'win32'), false)
})
