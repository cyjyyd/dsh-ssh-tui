# REL085-WIN-AUTO/v1 — Windows automated acceptance contract

This directory is **test-only**. It does not change the Relay candidate, its
package manifest, or the release gate. It is the Linux → Windows interface for
the real-GUI acceptance work in [#63](https://github.com/cyjyyd/dsh-ssh-tui/issues/63)
and [#64](https://github.com/cyjyyd/dsh-ssh-tui/issues/64).

## Frozen inputs

| Input | Value |
|---|---|
| Relay candidate SHA | `5ba9eff4ae90170ea8374781c06b3af5a38d46b7` |
| Candidate tarball | 260 files, 1,591,996 B |
| Candidate SHA-256 | `a76ccf388fed33b9b94bbc57d9c2575c1fe0066d53918d352af87317df4be0e6` |
| Node | `>=24.9.0` |
| Hosts | `@deepseek-ai/dsh@0.2.1-rc.5`, `@deepseek-ai/dsh@0.2.2-rc.1` |

The candidate is frozen. If either value differs at pickup, stop and notify
#63/#64; do not run the contract against a different tree.

## Files

- `gate-contract.v1.json` — versioned, machine-readable cases, exact inputs,
  assertions, timeouts, cleanup, failure attribution and minimum evidence.
- `fixtures/` — **pure synthetic** Chinese, emoji, multiline paste, mouse-copy,
  Escape/paste and session-ID samples. No user text, credentials or real IDs.
- `result.schema.json` — the result JSON Schema each runner writes.
- `scripts/win-auto-summarize.mjs` — common summarizer. It fails closed on
  unknown/duplicate cases, wrong host/terminal/mode, missing evidence, or a
  `PASS` with a failed assertion.

## Run

From the repository root:

```powershell
node scripts/win-auto-summarize.mjs `
  --contract tests/windows-auto/gate-contract.v1.json `
  --results C:\path\to\results.json `
  --runner windows --json
```

Exit code `0` means `REAL_GUI_PASS`; `2` means `HOLD`, `FAIL`, `BLOCKED_ENV` or
incomplete. `--runner linux` validates the H11 `REAL_SSH_NETWORK` case only.

Every `PASS` run must include a `json` evidence entry pointing at the result document itself (or an immutable snapshot); the summarizer also enforces each case's `min_evidence`. A result file has this shape (full schema in `result.schema.json`):

```json
{
  "contract_version": "REL085-WIN-AUTO/v1",
  "runner": {
    "os": "Windows 11 24H2 build 26100",
    "machine": "disposable-vm",
    "utc_start": "2026-11-09T00:00:00Z",
    "utc_end": "2026-11-09T00:10:00Z",
    "session_id": 2,
    "desktop_unlocked": true
  },
  "candidate": {
    "relay_sha": "5ba9eff4ae90170ea8374781c06b3af5a38d46b7",
    "relay_tarball_sha256": "a76ccf388fed33b9b94bbc57d9c2575c1fe0066d53918d352af87317df4be0e6"
  },
  "runs": []
}
```

Each run carries `case_id`, `host`, `terminal`, `mode`, `status`, timestamps,
machine-readable assertions (`expected` / `actual` / `passed`), evidence paths
and hashes, cleanup status, and optional `window`, `ime`, `host_state`.

## Hard rules

1. **Real evidence only.** A real GUI pass requires a real interactive desktop,
   a real HWND, `GetClassNameW`/process ancestry, and the case's minimum
   evidence. `WT_SESSION`, `TERM`, `SESSIONNAME`, a process name or a screenshot
   alone is not window proof.
2. **IME is not SendInput of the final glyph.** The composition stage must show
   the active Microsoft Pinyin IME and an active composition; the preedit must
   not reach composer, transcript or model request. Only the commit stage may
   assert the committed Chinese text and caret.
3. **A ConPTY `PASS` is not a real GUI pass.** `SIMULATED_CONPTY` results are
   accepted only in their own mode and can never satisfy a `REAL_GUI` case.
4. **No real data.** Use only the supplied fixtures and disposable profiles.
   Do not use a production DSH Home, real credentials, browser accounts or
   paid Provider calls.
5. **Cleanup.** Every run records cleanup (`PASS`/`FAIL`/`SKIP`/`NOT_RUN`) and
   must close/restore only its disposable terminal, Host and clipboard.
6. **H11 is Linux-only.** `H11-SSH-01` requires an isolated network namespace or
   equivalent packet-drop link. A paused proxy is not packet-drop H11 and must
   be reported as a limited fallback, never as PASS.

## Case matrix

| ID | Real GUI / terminal | What it proves |
|---|---|---|
| `WIN-ENV-01` | any | Unlocked interactive session, foreground window available |
| `WIN-CONHOST-01` | conhost | `ConsoleWindowClass` + `conhost.exe` ancestry + workspace/Screen |
| `WIN-WT-01` | Windows Terminal | `CASCADIA_HOSTING_WINDOW_CLASS` + `WindowsTerminal.exe` ancestry |
| `WIN-IME-01` | both | Pinyin preedit excluded until commit; committed text exact |
| `WIN-IME-02` | both | Chinese + emoji commit and caret |
| `WIN-PASTE-01` | both | Multiline Chinese paste does not submit; one Enter = one turn |
| `WIN-MOUSE-01` | Windows Terminal | Drag selection/copy returns exactly the synthetic line |
| `WIN-RESIZE-01` | both | Composer/footer remain visible at four sizes |
| `WIN-SCREEN-01` | both | Report Screen opens, Esc restores composer |
| `WIN-PICKER-01` | both | `/model` menu opens, Esc preserves the draft |
| `WIN-ATTACH-01` | Windows Terminal | Closing the window keeps Host alive; reattach is append-only |
| `H11-SSH-01` | Linux SSH PTY | Real bidirectional packet drop without FIN/RST; Host/session survive |

`REQUIRED` cases must be run for both Host lines on Windows. A missing case is
`HOLD`, never `PASS`.
