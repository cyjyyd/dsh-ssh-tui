/**
 * The one place that branches on the operating system.
 *
 * Everything else in `src/` takes the decision as a parameter (or imports it
 * from here), because a raw `process.platform` comparison buried in feature code
 * is a Windows bug nobody runs until a user does. That is not hypothetical: a
 * bare `spawn('dsh')` could not resolve a `.cmd` shim, an unset `TERM` read as
 * "no terminal", and `detached: true` (DETACHED_PROCESS) silently disabled
 * `windowsHide` so every tool call flashed a console window. Each was one line
 * that no Linux test ever executed.
 *
 * `tests/platform-guards.test.mjs` scans for the banned shape — a `process.platform`
 * *comparison* outside this file — so the next one fails in review rather than on
 * a desktop.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** This process is running on Windows. */
export const IS_WINDOWS = process.platform === 'win32'

/** Windows delivers resizes on the stream; everyone else raises SIGWINCH. */
export function usesSigwinch(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

/** The launcher's environment file: a shell fragment or a `cmd` script. */
export function envFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'env.cmd' : 'env.sh'
}

/** The shell a Windows user has: PowerShell, where POSIX code would say bash. */
export function shellName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'PowerShell' : 'bash'
}

/**
 * Whether lock liveness is decided by asking the OS about the process (Windows:
 * `Get-Process` + creation time) rather than by reading `/proc` (Linux) or the
 * command line (darwin).
 *
 * `lockOwnerIsAlive` returns early into `windowsProcessMatchesLock` when this is
 * true; the POSIX body below it has no meaning there (`/proc` does not exist).
 */
export function usesProcessIdentity(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

/**
 * How to start the background Host so it outlives this process *and* does not
 * make its own children flash console windows on Windows.
 *
 * POSIX wants `detached: true` (setsid) so the Host survives the launcher and a
 * hung-up terminal.
 *
 * Windows is the opposite, and the trade-off is forced: `detached: true` maps to
 * DETACHED_PROCESS, and Windows ignores CREATE_NO_WINDOW (what `windowsHide`
 * sets) when DETACHED_PROCESS is present. Every console child the Host then
 * starts — each tool call, every shell, node, git — allocates its own console,
 * which is a visible window flashing over the TUI. So the Host is spawned
 * non-detached and inherits the launcher's console; descendants inherit it too
 * instead of creating one.
 *
 * The price *was* on the lifecycle side, and it was measured (on the Windows CI
 * leg by `scripts/tui-mock-probe.mjs --busy`, not reasoned about): libuv assigns
 * a non-detached child to its global job object, which is created with
 * KILL_ON_JOB_CLOSE. The launcher died, the job closed, and the Host was
 * terminated with it — a closed terminal window ended the session's compute.
 *
 * This function still returns `detached: false` there, because it describes a
 * *direct* spawn, and a direct spawn cannot have both properties: Node exposes
 * `detached` (DETACHED_PROCESS, which makes Windows ignore CREATE_NO_WINDOW) and
 * `windowsHide`, but not `CREATE_NEW_CONSOLE`. The way out is to not spawn the
 * Host directly on Windows: {@link hostBootstrapCommand} starts it through the
 * OS PowerShell, which *can* ask for a new console and hide it. This direct path
 * stays as the fallback for a Windows box without PowerShell.
 */
export function hostSpawnOptions(platform: NodeJS.Platform = process.platform): {
  detached: boolean
  windowsHide: boolean
} {
  const windows = platform === 'win32'
  return { detached: !windows, windowsHide: true }
}

/**
 * The Windows PowerShell that ships with the operating system.
 *
 * `powershell.exe` and not `pwsh.exe`: the latter is PowerShell 7, an optional
 * install, while 5.1 is part of Windows 10/11. `%SystemRoot%` is where it lives
 * (`%windir%` is the legacy spelling of the same thing); when neither is set
 * there is nothing to find, and the caller falls back to a direct spawn.
 */
export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.SystemRoot?.trim() || env.windir?.trim()
  if (raw === undefined || raw === '') return undefined
  // Spelled with backslashes explicitly rather than with `join`: this is a
  // Windows path no matter which platform is asking, and the tests assert it on
  // Linux. A trailing separator (or a forward slash, which Windows accepts) is
  // normalised away so the result is the same string everywhere.
  const root = raw.replaceAll('/', '\\').replace(/\\+$/u, '')
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/** A PowerShell single-quoted literal; `''` is the only escape inside one. */
export function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Quote one argv array into a Windows command line, the way `CreateProcess`
 * parses it back (the rule from "Everyone quotes command line arguments the
 * wrong way"): wrap in double quotes when the argument is empty or contains
 * whitespace or a quote, double the backslashes that precede a quote, and double
 * trailing backslashes before the closing quote. `Start-Process -ArgumentList`
 * joins its array with spaces and adds no quoting of its own, so the line has to
 * be right before it is handed over — a `DSH_HOME` with a space in it is the
 * normal case, not the exotic one.
 */
export function windowsCommandLine(argv: string[]): string {
  return argv.map(quoteWindowsArgument).join(' ')
}

function quoteWindowsArgument(argument: string): string {
  if (argument !== '' && !/[\s"]/u.test(argument)) return argument
  let quoted = '"'
  let backslashes = 0
  for (const character of argument) {
    if (character === '\\') {
      backslashes += 1
      continue
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    quoted += '\\'.repeat(backslashes) + character
    backslashes = 0
  }
  return quoted + '\\'.repeat(backslashes * 2) + '"'
}

/** `-EncodedCommand` wants base64 of UTF-16LE, which is also what dodges quoting. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * The bootstrap script: start the Host with **its own console, hidden**, and
 * print its pid so the launcher can watch it.
 *
 * `Start-Process -WindowStyle Hidden` is the only way to ask for this from a
 * Node process. It is ShellExecuteEx/CreateProcess with `CREATE_NEW_CONSOLE` and
 * `SW_HIDE`: the Host gets a console of its own, so closing the user's terminal
 * no longer takes it down, and that console is invisible, so the tool calls that
 * inherit it do not flash. `-PassThru` gives the object whose `Id` is printed;
 * `-RedirectStandardError` keeps the Host's stderr log, which the direct spawn
 * used to feed through an inherited fd.
 *
 * The whole script travels as an encoded command, so nothing in it is ever
 * re-parsed by a shell.
 */
export function hiddenConsoleHostScript(options: {
  execPath: string
  argv: string[]
  /** Where the Host's stderr goes; omitted only in tests. */
  stderrFile?: string
  /** Where the Host's pid is written for the launcher to read. */
  pidFile: string
}): string {
  const redirect = options.stderrFile === undefined
    ? ''
    : ` -RedirectStandardError ${psQuote(options.stderrFile)}`
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$dshHost = Start-Process -FilePath ${psQuote(options.execPath)}`
      + ` -ArgumentList ${psQuote(windowsCommandLine(options.argv))}`
      + ` -WindowStyle Hidden -PassThru${redirect}`,
    // Written to a file rather than to stdout: the launcher's pipe to this
    // script would be inherited by the Host, and whoever reads that pipe waits
    // for the Host to exit. A pid file has no such handle.
    `[IO.File]::WriteAllText(${psQuote(options.pidFile)}, [string]$dshHost.Id)`,
  ].join('; ')
}

/**
 * Set on the Host's environment by the bootstrap below, through
 * {@link bootstrapEnv}.
 *
 * The Host cannot ask whether it has a console of its own — Node exposes no such
 * question — so the launcher tells it. That is what lets the one build where the
 * lifecycle promise does not hold (Windows, no PowerShell, direct child) say so
 * at boot instead of letting the user discover it by closing the window.
 */
export const TUI_HOST_START_ENV = 'DSH_TUI_HOST_START'

/** Marker value for a Host started with a hidden console of its own. */
export const TUI_HOST_START_BOOTSTRAP = 'hidden-console'

/** The environment the bootstrap hands to the Host: the marker is added here. */
export function bootstrapEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, [TUI_HOST_START_ENV]: TUI_HOST_START_BOOTSTRAP }
}

/**
 * Whether this Host survives its terminal being closed.
 *
 * POSIX always does (`setsid`); Windows does exactly when the bootstrap started
 * it. A Windows Host without the marker is the fallback direct child, which
 * libuv's `KILL_ON_JOB_CLOSE` job takes down with the launcher — the one case
 * worth a boot notice.
 */
export function hostHasOwnConsole(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32' || env[TUI_HOST_START_ENV] === TUI_HOST_START_BOOTSTRAP
}

/** How the Host is started when it must not be a direct child. */
export interface HostBootstrapCommand {
  command: string
  args: string[]
}

/**
 * The hidden-console bootstrap for this platform, or `undefined` when the Host
 * should be spawned directly.
 *
 * Windows only, and only when the OS PowerShell is really there: the caller
 * falls back to {@link hostSpawnOptions}, which keeps the boot working (without
 * the survival property) on a machine where PowerShell is missing or blocked.
 * `exists` is injectable so the decision is assertable on Linux.
 */
export function hostBootstrapCommand(options: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
  execPath: string
  argv: string[]
  stderrFile?: string
  pidFile: string
}): HostBootstrapCommand | undefined {
  if ((options.platform ?? process.platform) !== 'win32') return undefined
  const powerShell = windowsPowerShellPath(options.env ?? process.env)
  if (powerShell === undefined) return undefined
  if (!(options.exists ?? existsSync)(powerShell)) return undefined
  const script = hiddenConsoleHostScript({
    execPath: options.execPath,
    argv: options.argv,
    pidFile: options.pidFile,
    ...options.stderrFile === undefined ? {} : { stderrFile: options.stderrFile },
  })
  return {
    command: powerShell,
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShellCommand(script),
    ],
  }
}

/**
 * A path a human can read, with the platform's own shorthand.
 *
 * `~/.dsh/env.sh` is the POSIX form; Windows users know `%USERPROFILE%`, and a
 * `C:\Users\...` prefix spelled out is noise in a one-line hint.
 */
export function displayHomePath(
  home: string,
  file: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; userHome?: string } = {},
): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform === 'win32') {
    const profile = env.USERPROFILE
    if (profile !== undefined && profile !== '' && home.toLowerCase().startsWith(profile.toLowerCase())) {
      return `%USERPROFILE%${home.slice(profile.length)}\\${file}`.replaceAll('/', '\\')
    }
    return `${home}\\${file}`.replaceAll('/', '\\')
  }
  const userHome = options.userHome ?? homedir()
  // `home` is the DSH home, so equality means DSH_HOME *is* the user's home (a
  // real, if unusual, configuration): the file sits directly in `~`, not in a
  // `.dsh` directory that is not there.
  if (home === userHome) return `~/${file}`
  if (home.startsWith(`${userHome}/`)) return `~/${home.slice(userHome.length + 1)}/${file}`
  return join(home, file)
}

/**
 * Who owns the files this plugin writes, and how to keep it that way.
 *
 * On POSIX the `mode` passed to `writeFile`/`mkdir` (`0o600`, `0o700`) is the
 * whole story. **On Windows it is silently ignored**, and the files that matter
 * here are not cosmetic: `env.cmd` carries API keys, the SuperGrok token file
 * carries an OAuth grant, and the lock/socket directories carry session
 * metadata. What they get instead is the ACL inherited from their parent — fine
 * under `%USERPROFILE%\.dsh`, and *not* fine when `DSH_HOME` points somewhere
 * shared (`C:\dsh`, a network share, a machine where `Users` can read the
 * directory), which is exactly when nobody notices.
 *
 * So the intent is applied explicitly: `icacls` with inheritance removed and a
 * single grant to the current user. The argv is built by a pure function so it
 * can be asserted on Linux; applying it is best-effort by design — a machine
 * without `icacls`, or a path held open by another process, must not fail the
 * write that just succeeded. Failing closed here would mean a TUI that cannot
 * save its own settings.
 */

/**
 * The account `icacls` should grant, or undefined when the environment has none.
 *
 * `%USERDOMAIN%\%USERNAME%` where both are present: on a domain-joined machine a
 * bare name can resolve to the machine-local account of the same name, and a
 * grant to the wrong account — with inheritance already removed — would leave
 * the user's own API keys inaccessible to them.
 */
export function aclUserName(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32') return undefined
  const name = (env.USERNAME ?? env.USER ?? '').trim()
  if (name === '') return undefined
  const domain = (env.USERDOMAIN ?? '').trim()
  // A name that already carries a domain (`DOMAIN\user`) is left alone.
  if (domain === '' || name.includes('\\')) return name
  return `${domain}\\${name}`
}

/**
 * The exact `icacls` arguments for one path.
 *
 * `/inheritance:r` drops what the parent offered (this is the part that matters:
 * adding a grant without removing inheritance leaves `Users` in place), and
 * `(OI)(CI)` makes a directory's grant apply to what is created inside it —
 * without it every new lock file would need its own call.
 */
export function restrictPathArgs(path: string, user: string, options: { directory?: boolean } = {}): string[] {
  const grant = options.directory === true ? `${user}:(OI)(CI)F` : `${user}:F`
  return [path, '/inheritance:r', '/grant:r', grant]
}

/** Directories and files whose contents must not be readable by other users. */
export interface RestrictDeps {
  /** Runner for `icacls`; injected by tests. Returns true on success. */
  run?: (command: string, args: string[]) => boolean
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

/**
 * Apply `mode` on POSIX, a single-user ACL on Windows.
 *
 * Returns whether the restriction was applied. Never throws: the caller has
 * already written the file, and a permission call is not worth losing it over.
 */
export async function restrictPathToUser(
  path: string,
  options: { mode: number; directory?: boolean } & RestrictDeps = { mode: 0o600 },
): Promise<boolean> {
  const platform = options.platform ?? process.platform
  try {
    if (platform !== 'win32') {
      const { chmod } = await import('node:fs/promises')
      await chmod(path, options.mode)
      return true
    }
    const user = aclUserName(options.env, platform)
    if (user === undefined) return false
    const args = restrictPathArgs(path, user, { directory: options.directory === true })
    if (options.run !== undefined) return options.run('icacls', args)
    return await runIcaclsAsync('icacls', args)
  } catch {
    return false
  }
}

/** Synchronous twin, for the sites that create their file with `openSync`. */
export function restrictPathToUserSync(
  path: string,
  options: { mode: number; directory?: boolean } & RestrictDeps = { mode: 0o600 },
): boolean {
  const platform = options.platform ?? process.platform
  try {
    if (platform !== 'win32') {
      chmodSync(path, options.mode)
      return true
    }
    const user = aclUserName(options.env, platform)
    if (user === undefined) return false
    const run = options.run ?? runIcaclsSync
    return run('icacls', restrictPathArgs(path, user, { directory: options.directory === true }))
  } catch {
    return false
  }
}

/**
 * Whether the terminal in front of us can paint UTF-8 at all.
 *
 * The chrome this TUI draws — rules, status dots, the warning glyph — is
 * Unicode. A console whose output code page is not UTF-8 (a legacy Windows
 * console left on CP936 or CP437) and a POSIX locale that is not UTF-8 both
 * render those bytes as mojibake, which is worse than plain ASCII: the frame
 * still has to line up. This answers only "can it decode UTF-8", never "which
 * terminal", so the capability table stays where it is.
 *
 * The decision is read from the environment, which is all a portable test can
 * assert: `DSH_TUI_ASCII=1` forces the fallback and `=0` forbids it; otherwise
 * a locale naming a non-UTF-8 charset (or the bare `C` / `POSIX`) opts in,
 * and so does a Windows console whose output code page is recorded as anything
 * but 65001. An unset locale is left alone — a UTF-8 SSH session often exports
 * nothing, and guessing "ASCII" there would strip the chrome from the audience
 * this TUI is built for.
 * @param env - the environment to read (tests pass their own).
 * @param platform - the platform the decision is for.
 * @returns true when chrome must be drawn in ASCII.
 */
export function asciiFallbackEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const forced = (env.DSH_TUI_ASCII ?? '').trim().toLowerCase()
  if (['1', 'true', 'on', 'yes', 'ascii'].includes(forced)) return true
  if (['0', 'false', 'off', 'no', 'utf8', 'utf-8'].includes(forced)) return false
  if (localeCharsetIsUtf8(env) === false) return true
  if (platform === 'win32' && windowsOutputIsUtf8(env) === false) return true
  return false
}

/**
 * `true` when a locale variable names UTF-8, `false` when it names something
 * else, and `undefined` when none of them says — so the caller can tell "the
 * user told us" apart from "nobody said".
 *
 * `LC_ALL` wins over `LC_CTYPE` over `LANG`, matching the order a libc consults
 * them in. `LC_MESSAGES` is deliberately absent: it picks the translation, not
 * the encoding the terminal decodes bytes with.
 */
function localeCharsetIsUtf8(env: NodeJS.ProcessEnv): boolean | undefined {
  for (const key of ['LC_ALL', 'LC_CTYPE', 'LANG'] as const) {
    const raw = (env[key] ?? '').trim()
    if (raw === '') continue
    const value = raw.toLowerCase().replace(/-/gu, '')
    if (value === 'c' || value === 'posix') return false
    const charset = value.split('.')[1] ?? ''
    if (charset === '') return undefined
    return charset === 'utf8'
  }
  return undefined
}

/**
 * `true` when a Windows console says its output code page is UTF-8 (65001),
 * `false` for any other recorded page, `undefined` when nothing was recorded.
 *
 * Node does not expose `GetConsoleOutputCP`, and spawning `chcp` on every paint
 * is not an option, so the decision reads the variables a launcher can set:
 * `DSH_TUI_CODEPAGE` (our own, for a wrapper that already asked) and
 * `PYTHONIOENCODING` (a `cp936`-style tag is the one portable signal the wider
 * ecosystem agrees on). An unset value is not evidence of a legacy page.
 */
function windowsOutputIsUtf8(env: NodeJS.ProcessEnv): boolean | undefined {
  const own = (env.DSH_TUI_CODEPAGE ?? '').trim().toLowerCase()
  if (own !== '') return own === '65001' || own === 'utf8' || own === 'utf-8'
  const python = (env.PYTHONIOENCODING ?? '').trim().toLowerCase()
  const charset = python.split(':')[0] ?? ''
  if (charset === '') return undefined
  if (charset === 'utf8' || charset === 'utf-8' || charset === 'cp65001') return true
  if (/^(cp|oem)\d+$/u.test(charset) || charset === 'mbcs' || charset === 'ascii') return false
  return undefined
}

/** `icacls`, synchronously, with a hidden window and a short leash. */
function runIcaclsSync(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { stdio: 'ignore', windowsHide: true, timeout: 5_000 })
  return result.status === 0
}

/** Async form, so a slow `icacls` never blocks a paint. */
function runIcaclsAsync(command: string, args: string[]): Promise<boolean> {
  return import('node:child_process').then(({ spawn }) => new Promise<boolean>(resolve => {
    try {
      const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
      const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } resolve(false) }, 5_000)
      child.on('error', () => { clearTimeout(timer); resolve(false) })
      child.on('exit', code => { clearTimeout(timer); resolve(code === 0) })
    } catch {
      resolve(false)
    }
  }))
}
