# Upstream report: the desktop Harness cannot host terminal profiles

> Copy-paste-ready issue text for `deepseek-ai/deepseek-harness`.
> Verified 2026-09-29 against the Desktop stable (Windows 11, runtime CLI `0.2.0-rc.2`)
> by the reporter of the original defect report, with the registry checks and the
> plugin-side behaviour re-verified here. Our own side of the fix is in
> [`desktop.md`](desktop.md); this file is only what belongs upstream.
> Chinese summary: [`desktop.md`](desktop.md) §P1/§P2.

## Title

Desktop app: `dsh` on PATH has no console, so terminal profiles cannot start (and two rows the TUI profile
comment recommends have no 0.2.x release)

## Environment

- Windows 11, Desktop Harness stable (runtime CLI `0.2.0-rc.2`)
- Profile: the bundled `tui` profile, with `dsh-ssh-tui` installed through the desktop plugin manager
- Also reproducible with the desktop `dsh` shim and any plugin that needs a TTY

## Summary

1. **P1 — the desktop launcher never provides a TTY**, so *any* terminal profile fails under it. The PATH
   shim runs `DeepSeek Harness.exe` (GUI subsystem) with `ELECTRON_RUN_AS_NODE=1`, so `process.stdin.isTTY` and
   `process.stdout.isTTY` are `undefined` and `dsh --profile tui` cannot start. `dsh web` / `dsh headless` are
   unaffected because they do not need a TTY.
2. **P2 — two rows recommended by the bundled TUI profile's own comment cannot be installed on 0.2.x.**
   `@deepseek-ai/dsh-agent-presets` and `@deepseek-ai/dsh-code-runtime-worker-thread` have no `0.2.0-*`
   release at all, and `@deepseek-ai/dsh-base@0.2.0-rc.2` neither depends on nor needs them.

## P1 — reproduction

In a real console (Windows Terminal, PowerShell, cmd — all the same):

```
> dsh --profile tui --new

dsh: warning: 1 entry did not activate
ssh-tui (dsh-ssh-tui): Error: dsh-ssh-tui: both stdin and stdout must be TTYs; use a terminal/SSH session
    at new apply (…/profiles/tui/node_modules/dsh-ssh-tui/lib/index.js:94:15)
    at Fiber.execute (…/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js:1068:24)
```

`resources\runtime\cli\bin\dsh.cmd`:

```bat
@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
exit /b %errorlevel%
```

Diagnostic probe in the same console, through both runtimes:

```console
$ set ELECTRON_RUN_AS_NODE=1
$ "D:\Deepseek-harness\DeepSeek Harness.exe" --expose-internals isTTY-probe.cjs
RUNTIME=electron-as-node isTTY=undefined exec=D:\Deepseek-harness\DeepSeek Harness.exe

$ set ELECTRON_RUN_AS_NODE=
$ "D:\Program Files\nodejs\node.exe" isTTY-probe.cjs
RUNTIME=node isTTY=undefined exec=D:\Program Files\nodejs\node.exe
```

**Root cause.** A GUI-subsystem process started from a console does not attach to that console, so the CRT has no
console handles, `GetConsoleMode` fails, and Electron's Node builtin never marks stdio as a TTY. Both plausible
readings (Electron-specific, or "this console did not expose stdio") point at the same class of fix.

**Evidence that it is the runtime, not the machine.** With the npm-installed `@deepseek-ai/dsh` (whose shim
calls `node.exe` directly) the same profile runs, and `~/.dsh/tui-locks` / `tui-socks` exist from those runs.
The only variable is the runtime the shim picks.

### Requested fix (any one of these)

1. **Preferred:** give terminal profiles a real console-subsystem Node runtime. Unpack the CLI and its
   `@deepseek-ai/*` dependencies from the asar into a stable directory (e.g.
   `resources\runtime\cli\runtime\`) and have `dsh.cmd` call the bundled `node.exe`. TTYs work, and the
   `--expose-internals` + asar-read requirements disappear.
2. If the Electron binary must stay: `AttachConsole(ATTACH_PARENT_PROCESS)` (with `AllocConsole` as a fallback)
   and re-bind the stdio handles before `ELECTRON_RUN_AS_NODE` starts. Note that `-e` / `--expose-internals`
   combined with handle re-binding still needs verification on Windows.
3. At minimum, document that the desktop `dsh` cannot run TTY-requiring terminal profiles, and point users at
   the npm CLI (`npm i -g @deepseek-ai/dsh`).

**Plugin-side note (informational).** Plugins cannot detect their way out of this, and a plugin must not be
able to break its host, so the TUI plugin now logs one line and mounts nothing when there is no terminal
instead of throwing. That removes the "1 entry did not activate" noise — but it does not make the TUI run under
the desktop launcher, and it means a desktop user sees a line they should not have to read at all.

## P2 — two recommended rows cannot be installed on 0.2.x

The bundled `tui` profile's `cordis.patch.yml` comment recommends:

```yaml
- insert:
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard
    - id: code-runtime
      name: '@deepseek-ai/dsh-code-runtime-worker-thread'
```

On `0.2.0-rc.2` that yields `failed to import` (package absent) or, with the newest published version:

```
dsh: disabling profile plugin row "agent-presets": Plugin @deepseek-ai/dsh-agent-presets@0.1.5-rc.2
  is incompatible with dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh-agent":"^0.1.5-rc.2", …}
```

Registry facts (checked 2026-09-29, `registry.npmjs.org`):

| Package | dist-tags | `0.2.x` |
| --- | --- | --- |
| `@deepseek-ai/dsh-agent-presets` | `latest=0.0.1-rc.1` · `next=0.1.5-rc.3` · `alpha=0.1.6-alpha.2` | **none** |
| `@deepseek-ai/dsh-code-runtime-worker-thread` | `latest=0.0.1-rc.3` · `next=0.1.5-rc.3` | **none** |
| `@deepseek-ai/dsh-base@0.2.0-rc.2` | — | 93 family dependencies, **neither of the two**; the only remaining preset-ish package is `@deepseek-ai/dsh-permission-presets` (permissions, not the agent roster) |

Neither package is present inside the desktop's `app.asar` either (`readFileSync` → `ENOENT`), so the 0.2.x
runtime genuinely no longer ships them. On that line a terminal profile needs only `tool-ask-user` and
`present` (the plugin's `/doctor` reports exactly which rows are missing and `/doctor --fix` writes them), so the
comment is a 0.1.5-era recipe that no longer applies.

### Requested fix (any one of these)

- Publish both packages for the 0.2.x line with peers aligned to `dsh-base@0.2.0-rc.*`, **or**
- fold the agent-preset roster / code-runtime host service back into `dsh-base` (or the terminal bundle) so
  profiles do not need user-inserted rows, **or** at minimum
- delete those two rows from the TUI profile template comment, so users following it do not hit
  "package does not exist" / "incompatible" on a fresh install.

## Other observations (not part of the defect)

- `dsh plugin --profile <name> …` forwards its arguments to the profile's pnpm, so `dsh plugin --help` prints
  pnpm's help, and exemptions like `allow-version` are not reachable through it (desktop plugin manager UI only).
  Worth documenting rather than changing.
- The PATH registration mechanism (`resources\runtime\cli\command-path.ps1` + `command-manager.js`) behaves as
  intended on Windows; it is unrelated to both defects above.
