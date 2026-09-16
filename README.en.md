# dsh-ssh-tui

[![npm](https://img.shields.io/npm/v/dsh-ssh-tui?style=flat-square&color=4b6fff)](https://www.npmjs.com/package/dsh-ssh-tui)
[![npm downloads](https://img.shields.io/npm/dm/dsh-ssh-tui?style=flat-square)](https://www.npmjs.com/package/dsh-ssh-tui)
[![CI](https://github.com/cyjyyd/dsh-ssh-tui/actions/workflows/ci.yml/badge.svg)](https://github.com/cyjyyd/dsh-ssh-tui/actions/workflows/ci.yml)
[![dshfind](https://dshfind.com/api/badge/cyjyyd/dsh-ssh-tui)](https://dshfind.com/en/plugins/cyjyyd/dsh-ssh-tui?ref=badge)

A DeepSeek Harness terminal for jump hosts, headless servers, and high-latency
SSH. Plain ANSI and incremental redraws. No browser required.

中文部署指南：[README.md](README.md)

If you mostly work over SSH — a jump host, a test box, a keyboard-only
session — start here. A local desktop terminal with themes and layout
you already like can stay as it is.

Listed on the [dshfind plugin directory](https://dshfind.com/en/plugins/cyjyyd/dsh-ssh-tui):

[![dshfind](https://dshfind.com/api/card/cyjyyd/dsh-ssh-tui?lang=en)](https://dshfind.com/en/plugins/cyjyyd/dsh-ssh-tui?ref=badge)

Install with the official CLI (no clone):

```sh
dsh plugin --profile tui add dsh-ssh-tui@latest
dsh --profile tui
```

Current `dsh` requires `--profile` (`dsh plugin add …` errors without it).
Swap `tui` for another profile name.

**Updates must use `@latest`.** `dsh plugin` forwards the rest of the line to
pnpm in the profile directory. A bare `add dsh-ssh-tui` keeps the version
already pinned in `pnpm-lock.yaml` (often 0.3.7). Do not put `--profile`
after `add`: `dsh plugin add --profile tui add dsh-ssh-tui` is not valid.
Remove with `dsh plugin --profile tui remove dsh-ssh-tui`.

## Official headless vs this TUI

There is no shipped TUI. The default terminal entry on a remote box is
`dsh --profile headless`: one task, then the **last assistant message** on
stdout. Reasoning, tool calls, subagents, and the plan stay in the session
log.

Both frames below are the **same task**. Top: official headless stdout
(`@deepseek-ai/dsh-headless` prints `outcome.text` only). Bottom: this plugin
painting the same events in an 88-column SSH window.

![Official headless stdout vs dsh-ssh-tui](docs/screenshots/compare.png)

Top: `$ dsh --profile headless "…"` then the final markdown.  
Bottom: reasoning collapsed, full-row red/green diff, each subagent on its
own card, the plan strip pinned above the input.

Singles: [headless stdout](docs/screenshots/headless.png) · [dsh-ssh-tui](docs/screenshots/workspace.png)

## Still visible on a slow SSH pipe

Same task, replayed at **2 kB/s** through the real incremental painter
(88×30, one `stdout.write` per frame). Official headless on that pipe
would stay blank until the final markdown. Here reasoning, the edit
diff, subagent cards, and the plan strip appear as the bytes arrive.

![Same task replayed at 2 kB/s SSH](docs/screenshots/slow-link.gif)

Reproducible, no model in the loop: `npm run screenshots:slow` writes
`docs/screenshots/slow-link.json`. This capture is 14 paints, about
**18.0 KB**, **8.8 s** at 2 kB/s. Byte ledger for this event sequence.

0.7 highlights: drag-select any part of a model reply to copy it (OSC 52 into your local
clipboard; a tool card still expands on click) · the footer is one priority-ordered chip
strip, and `⚠` opens `/doctor` · the quota bar is on screen from the first frame and names
its window (`5Hr`/`1Wk`/`1Mo`, smallest window by default, `?%` with a 15-second retry until
a reading arrives) · `/mode` groups presets and filters with `/` · the compact view names
every changed file · tool diffs are line-level, emphasise only what changed, and go
side-by-side at 100 columns or more · `DSH_TUI_LINE_MODE=1` appends plain lines for screen
readers and `tee` · `ssh-tui.keys` rebinds keys, refusing conflicts · `DSH_TUI_COLOR_DEPTH`
pins the palette (truecolor / 256 / 8 / none).

## Requirements

- Node.js >= 22.19
- `@deepseek-ai/dsh` CLI: `npm i -g @deepseek-ai/dsh` (verified on `0.1.2-rc.1` and `0.1.5-rc.1`. `0.1.5-alpha.1` / `0.1.5-alpha.2` / `0.1.3-alpha.2` share the same handle API + `agent/assistant-stream` shims. `0.1.3-alpha.1` exists only as a GitHub tag and was never published to npm)
- pnpm (used by `dsh plugin` to manage profile dependencies)

## Install

The recommended install is the command at the top of this README:
`dsh plugin --profile tui add dsh-ssh-tui@latest`. The CLI pulls npm, writes the
profile dependency, and appends this package to `dsh.profile.bundles`
because the manifest declares `dsh.bundle`.

Optional: reuse a SuperGrok / grok-bridge token already on the machine:

```sh
dsh plugin --profile tui add dsh-llm-xai-oauth
dsh plugin --profile headless add dsh-llm-xai-oauth
```

SuperGrok access tokens last about an hour. The TUI refreshes a due token on open, and `/usage` force-refreshes once after HTTP 401. If dsh is not running overnight, install the companion refresher or the next session starts with 401:

```sh
npx dsh-llm-xai-oauth daemon --install
```

See [dsh-llm-xai-oauth](https://github.com/cyjyyd/dsh-llm-xai-oauth).

Smoke the route before opening the TUI. The TUI exits immediately without a TTY:

```sh
dsh --profile headless "Reply with exactly: tui-install-ok. Do not use tools."
dsh --profile tui
```

From a checkout: `bash scripts/smoke-headless.sh` (prints an outcome summary, never a token).

### After an SSH drop

Closing the laptop or an idle jump host tears down the TTY. The TUI treats
SIGHUP, stdin close, and a failed TTY write as hangup: it drops the display
and flushes the session log. **Idle hangup does not keep the Host** (next
`--resume` replays the log). A busy turn — thinking, reply, tools, subagents —
**keeps the Host**. Reconnect with the same command — the picker prefers a live
process (labelled attachable). Do not start a second Host:

```sh
dsh --profile tui --resume                 # picker (live hosts first)
dsh --profile tui --resume <session-id>    # attach if live, else resume the log
```

A second Host on the same `sessionId` is refused (it would steal the jsonl
and approvals). Locks live under `$DSH_HOME/tui-locks/`; the display socket
under `$DSH_HOME/tui-socks/`. A leftover lock from a crash is stolen if the
pid is dead. `DSH_TUI_NO_SESSION_LOCK=1` skips this.

A busy hangup pauses the turn by default (cancelled). After attach, send another
message to continue. `/disconnect continue`, `ssh-tui.disconnect: continue`,
or `DSH_TUI_DISCONNECT=continue` leaves the turn running in the background;
approvals and questions wait until a Display attaches. Idle hangup exits
immediately. A leftover Host holds the session's kernel write lock
(`session.lock`), which is exactly what makes the Web UI refuse the same session
(`resume failed for session … is already owned by an active write handle`), so
once the turn it stayed for has finished it waits at most one more minute
(`DSH_TUI_IDLE_EXIT_MS`, or `ssh-tui.idleExit` in settings.yaml, in
milliseconds; `0`/`off` restores the old behavior) and then exits, handing the
lock back — long enough for the old window to reattach, after which `--resume`
reopens the flushed log. A Host that never finishes its turn still falls back to
`DSH_TUI_DETACHED_IDLE_MS` (6h). Optional: wrap the TUI in tmux.
Copy-paste recipes for keeping a session reachable (tmux, screen, systemd --user, long turns) are in [`docs/remote-ops.md`](docs/remote-ops.md) (Chinese for now), together with what the `reconnected N times · away X` and `away …` transcript lines mean.

New sessions inherit the directory you launched from. Resuming a session
`chdir`s into that session's recorded working directory. The footer shows
`目录:srv` (last path segment); click it to print the full path.

On start, if npm has a newer `dsh-ssh-tui`, a first-launch picker offers
**Update now / Later / Skip this version**. Update now runs
`dsh plugin --profile tui add dsh-ssh-tui@latest` and asks you to restart.
Set `DSH_TUI_NO_UPDATE_CHECK=1` to skip. `/status` also shows the plugin version, the link chip, the quota window, and whether the subagent model is in the same family as the parent route.

From git:

```sh
git clone https://github.com/cyjyyd/dsh-ssh-tui.git
cd dsh-ssh-tui
bash scripts/install.sh          # installs into the `tui` profile
```

Or manually:

```sh
npm install --no-audit --no-fund
npm run build
dsh plugin --profile tui add "link:$(pwd)"
```

### The preset roster `/mode` needs

A terminal profile built on `dsh-base` composes no preset roster (only the Web
bundle, `@deepseek-ai/dsh-web-app`, does), and DSH STORE accepts additive bundle
patches with plugin-owned ids and no `@deepseek-ai/*` module names — so this
plugin's own patch cannot mount the roster. The row belongs to the profile's
user layer, and it is not just the `/mode` menu: the preset owns
`ask_user_question`, `present`, PTC's presentation layer, and the subagent
model-selection rows, so without it those tools are absent from the agent's
catalog.

Three ways to repair it (idempotent, pick one):

1. **In-app**: `/mode fix` writes the block below and tells you to restart.
   This is the generic path — an npm install and the in-app "Update now" both go
   through `dsh plugin add` and never run the repository scripts.
2. From a checkout: `bash scripts/ensure-profile-rows.sh [profile]`
   (default `tui`).
3. By hand, in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard
```

The script also mounts `code-runtime` (the TypeScript runtime the `ptc` preset
needs) and `subagent-model-selection-settings` (the host-owned delegation
setting), and skips a profile that already composes the roster (one bundling
`@deepseek-ai/dsh-web-app`, for example). Restart the TUI to pick it up.
The reverse order bites: adding `dsh-web-app` to a profile that already carries
this block lists the roster row twice, and the second mount fails with
`service "agentPresets" has been registered` — delete the block first.

Without the row, the TUI prints a boot line ("No agent-preset roster is
composed…"), `/mode` reports the patch path plus the `/mode fix` entry point,
and `scripts/verify.sh` says the same. Preset identity is per module instance,
so a dsh install tree carrying two copies of `@deepseek-ai/dsh-scope` (an
npm-nested checkout can) fails the mount with `refusing to compose an unscoped
context`; a global `npm i -g` install is not affected.

For the optional **智能路由模式 (routing-suite)** mode, also run:

```sh
bash scripts/install-routing-suite.sh
```

The script adds `dsh-routing-suite`, registers its preset for the `/mode`
menu, and mounts the in-box loopback `webServer` service (`127.0.0.1` on an
OS-assigned port) that the plugin requires for its read-only status API.

Set `DEEPSEEK_API_KEY` (or a `$DSH_HOME/settings.yaml` / `.env` with the
credentials), then start:

```sh
dsh --profile tui
```

Verify and uninstall:

```sh
bash scripts/verify.sh
bash scripts/uninstall.sh
```

## First-launch setup

On first launch (when no API key is configured) the TUI opens a setup wizard:

1. choose a provider template, matching the official Models page:
   - DeepSeek official;
   - OpenCode Go (`opencode.ai/zen/go/v1`, Responses protocol);
   - Command Code (`api.commandcode.ai`, Completions protocol, with its own quota);
   - custom OpenAI-compatible gateway (Completions);
   - custom OpenAI Responses gateway;
   - Anthropic Messages-compatible gateway;
2. for custom providers, enter a lowercase Provider ID (permanent), base URL,
   API key (masked while typing), and one or more model IDs — each step has a
   sensible template default. On the models step, press `Ctrl+F` to fetch the
   current model list straight from the provider endpoint;
3. confirm and save.

The wizard sizes each model's context window automatically: the endpoint
`/models` capacities first, then the installed pi-ai catalog by model name
(stripping the thinking-level suffixes providers bake into an id — `-high`,
`-low`, `-thinking` — plus `vendor/` prefixes, `:free` tags, and date stamps).
Only when some pick still has no capacity does a route-default step appear,
pre-filled with the smallest window the route proved, so accepting it needs no
typing; when every pick matched, that step is skipped entirely. What is saved
is the route-level `defaultContextWindow`, which models added later through
`/model` inherit too — and `/model` itself looks the model up in the catalog
first, writing that model's `contextWindow` directly when it matches.

The wizard writes the key to `~/.dsh/.credentials.yaml` when no environment
variable shadows it; if the machine injects `DEEPSEEK_API_KEY` from
`/etc/profile.d` or similar, it writes `~/.dsh/env.sh` (sourced by
`~/.profile` / `~/.bashrc` / `~/.zshenv` / `~/.zshrc` automatically,
idempotently) so your
value wins on the next launch. On Windows it runs `setx` and writes
`%USERPROFILE%\.dsh\env.cmd` as a fallback. Custom gateway base URLs are saved
to `$DSH_HOME/settings.yaml` as an `llm-pi-ai.providers.<id>` route (the same
shape the official custom-provider form writes). After saving a custom
provider, exit and launch with:

The wizard also remembers the selected provider/model in
`agent-default-model` (the same settings memory the official Models page
uses), so after setup you can just run:

```sh
dsh --profile tui
```

`--provider <id> --model <id>` remains available as a temporary override.

You can reopen the wizard at any time with:

```sh
/setup
```

## Cross-platform support

- **Windows**: the display channel is a named pipe
  (`\\.\pipe\dsh-tui-<8-hex DSH_HOME>-<session name>-<8-hex session id>`) — the only
  local socket Windows can listen on — and it is reclaimed when the Host exits. Readiness
  is probed with a real connect, and a Host that exits early is reported at once with its
  stderr (`%USERPROFILE%\.dsh\tui-socks\<session>.err`). Session locks check a live pid
  with `Get-Process` (image name plus creation time), so a recycled pid is recognised as
  stale instead of reported as a phantom zombie Host.
- **Legacy Windows consoles without VT support**: set `DSH_TUI_NO_ALT_SCREEN=1` (and
  `--no-color` if needed) to skip the alternate-screen escape sequences.
- **Footer speed** (`135 tok/s`) is measured from the first token the model emits to the
  settled step, and is rebuilt when a session is replayed with `--resume`. A step with no
  usable timing shows `首字 1.2s` instead.
- **Emoji / CJK width**: BMP symbols carrying the Unicode `Emoji` property are budgeted two
  cells, and the painter asks for the narrow text form (VS15) plus a reserving space. A
  monospace font that lacks the glyph still makes the terminal fall back to a wider colour
  emoji, so pick a font that covers what you use (Noto Sans Mono CJK, for instance).
- **Keyboard input** accepts both `\x7f` and `\x08` backspace, and both `\r` / `\r\n`
  line endings.
- **Subagent route**: the identity row always carries `sub:<model>` — the route every child
  inherits — with the effort in parentheses when `/subeffort` set one, e.g.
  `sub:grok-4.5(xhigh)`. Only the model name is shown; the provider and the full route are
  in `/status`.

## Usage

| Key | Action |
| --- | --- |
| `Enter` | send; while running, steer; with empty input, toggle the selected card. Oversized tool bodies open a dedicated inspect view; `Esc` returns |
| `Tab` | complete the highlighted slash command |
| `↑` / `↓` | empty input: move among cards; otherwise history (↓ past the newest item restores the live draft). Same as `Ctrl+N` / `Ctrl+P` |
| `Ctrl+R` | expand the latest card; once a card is selected, expand or collapse all |
| `Ctrl+T` | fold the input box (display-only) |
| `Alt+1` / `2` / `3` / `4` | jump to latest thinking / plan / subagent / reply |
| `/find [kind] query` | search and jump to the full matching message (`thinking` `plan` `subagent` `reply` `prompt` `tool`). `Ctrl+/` or `Alt+/` opens it |
| `/copy` | copy the focused card as plain text to the local clipboard (latest reply if none; OSC 52) |
| `Ctrl+G` / `Alt+N` | next search hit; `Alt+P` previous |
| `Esc` | drop selection → scroll to bottom → cancel the running turn |
| `Ctrl+C` | cancel the running turn; press twice when idle to exit |
| `Ctrl+D` | exit |
| `Ctrl+L` | redraw |
| `y` / `n` / `Esc` | answer an approval prompt |
| `1..9` + `Enter` | answer an `ask_user_question` dialog: `1..9` picks directly, `Enter` takes the highlighted option (the first by default), `Esc` cancels |

Type `/` to see slash-command suggestions — the panel merges the TUI's own
commands (`/find`, `/copy`, `/model`, `/effort`, `/provider`, `/language`, `/view`, `/disconnect`, `/approval`, `/help`, ...) with every command the harness
registers (`/goal`, `/plan`, `/compact`, `/permission`, `/feedback`, ...).
`/approval auto` allows low-risk shapes (reads/builds/tests, workspace
`edit`/`write`/`read`), auto-rejects danger (`rm -rf`, `sudo`, `curl|sh`,
`git push --force`, sensitive-path reads) and feeds the reason back to the
model, and sends unrecognized shapes (`npm publish`, interpreter `-c`/`-e`)
to the subagent-model reviewer (user message + args/reason/sandbox; English
UI uses the English reviewer; `authorization=yes` required). `/approval
status` also reports how many AI reviews ran this session.
The identity footer row shows a one-cell Braille ring after the
remaining-quota bar for occupancy of the routed model's context window
(DSH `contextPressure`, provider-agnostic); green / yellow / red map
to ok / 80% / 95%.
`/status` prints the same figures. Warnings fire near 80%/95%; idle
auto-`/compact` starts near 72% so recovery is not left to a mid-turn
overflow. `/compact` shows a spinning compact card and footer until it
finishes, then the tokens recovered. `Tab` completes, `Enter` runs.
`/help` lists everything. `/language` (alias `/lang`) opens a picker, or
`/language zh` / `/language en` switches immediately. `DSH_TUI_LANG` wins,
then `ssh-tui.language` in `$DSH_HOME/settings.yaml`, then `LANG` /
`LC_MESSAGES`. Unknown and `C` locales stay Chinese.
`/view` switches the workspace between **detailed** (default: thinking and
per-tool cards) and **compact**. Compact follows Codex: thinking is hidden
and the transcript interleaves as "reply → called N tools → edited N files →
next reply"; merged cards carry a git-style red/green `-13 +24` line stat,
expand with `Enter` (edits list files and paint the diff), the state dot
goes red only when everything failed, and a live plan stays pinned above
the composer. This is not `/mode` (agent presets). The choice is stored as
`ssh-tui.view`.

`/model` lists models for the **current** provider only. On SuperGrok that
is `grok-4.6` / `grok-4.5` plus reasoning effort (`xhigh` on 4.6). `/provider`
switches provider, then model; it takes effect on the **next request** — no
restart. Each provider’s last model and effort is remembered. `/setup` adds
or updates one API-key provider without wiping the others. SuperGrok / X
Premium uses local OAuth and does not need a key.

For OpenCode and other third-party providers, `/model` queries the provider's
endpoint (`GET {baseURL}/models`) for a live model list, falling back to the
configured catalog when the endpoint cannot be reached. Picking a model that
is not stored in the provider profile automatically adds it to
`llm-pi-ai.providers.<id>.models` so the harness can serve it.

Subagents follow the parent session's provider by default. Switching
provider/model persists the subagent model automatically (closest name to
the parent's, `flash`-suffixed ids first — `deepseek-v4-flash`,
`grok-4.5`); no dialog is shown, and `/submodel` still overrides it.
`/submodel [model-id]` picks (or directly sets) the subagent model, and
`/subeffort` picks the subagent reasoning effort or restores the provider
default. Both commands are remembered under `ssh-tui-subagent` in
`$DSH_HOME/settings.yaml`.
`/subagents` lists active subagents, and `/subagents kill <session-id> [more ids...]`
releases selected continuable children using the harness 0.1.1
`drainContinuableChildren` capability.

Each subagent is its own collapsible card. One or many children start collapsed,
so the parent transcript stays readable; `Enter`, click, empty-input `↑`/`↓`,
and `Ctrl+R` expand or collapse them independently. Running cards show a spinner,
and the status/title line shows `⠋ 子代理 N` instead of mixing child output
into the parent stream.

The plan strip pins only the **latest incomplete plan**. When the model
opens a new plan in the same turn, the previous one archives into the
scrolling transcript and the dock shows the new one. A finished plan says
「计划任务已全部完成」, not 「计划模式已关闭」. If a turn ends with open todos, the strip says 「本轮未收尾」, stops
spinning, and sends one follow-up asking the model to `todo_write` the
real statuses. The `/` menu and
approval/question dialogs yield that bottom space. `exit_plan_mode` is
markdown. `ask_user_question` still opens a dialog and leaves a collapsed
`提问用户` card. `/goal` is a collapsed `目标` card. `/find thinking foo`
or `Alt+1..4` jumps to the matching category.

Interrupted streaming output keeps the already-generated prefix and is marked
`⚠ interrupted`; team collaboration session events (`team/*`) are surfaced as
system messages. Harness slash commands that accept image attachments are
labelled `(images ok)` in the command list and completion hints.

`/usage` (alias `/balance`; `/quota` still works) follows the **current** provider:

- **DeepSeek official** `GET {baseURL}/user/balance`;
- **OpenAI Completions gateways** probe `/user/balance` and `credit_grants`;
- **SuperGrok** reads `GET cli-chat-proxy.grok.com/v1/billing` (weekly remaining %);
- **OpenCode Go** reads the official `/v1/usage` windows (5-hour / week / month);
- **Command Code** reads `/alpha/billing/credits` (5-hour / week windows plus the USD credit pool);
- **OpenCode Zen** is metered — the TUI points at `https://opencode.ai/zen`.

OpenCode Go / Command Code / SuperGrok quota is fetched silently at start and every 10
model steps (every 4 when an hourly window is near a threshold). The footer
shows plan name + remaining bar + percent; on a narrow row the plan name
drops first. DeepSeek official and queryable OpenAI-compatible gateways put
remaining prepaid balance on the footer (`bal 86.42 CNY`). A ⚠ transcript
line appears only when remaining crosses 50% / 25% / 10% / 5%. `/usage` or
`/balance` still prints the full snapshot.

The startup screen shows the official DeepSeek whale logo (rendered from the
harness favicon) in the DeepSeek brand color, with the wordmark below it. The
logo scales to the terminal width — a 52-column variant on wide terminals,
down to a compact variant on narrow ones — so it never looks squeezed. A
horizontal rule separates the workspace (transcript, reasoning, tool cards)
from the input area.

While the turn runs, a Codex-style `⠋ Working  (1s · Esc to interrupt)`
card sits at the bottom of the workspace. The shimmer header is the first
closed `**bold**` line of the model's thinking — it stays `Working` until
one arrives — and the live tool summary word-wraps under `  └ ` for up to
three rows with an ellipsis on the last. The card yields as soon as the
reply itself starts streaming.

Model reasoning blocks are collapsed by default: while thinking a compact
`▸ 思考中 ⠹ · N 字 · Ns` line with a spinner replaces the raw stream, and
after the turn each block collapses to a `▸ 已思考 · N 行` summary without
its content. The thinking block can be expanded live while streaming to watch
the raw reasoning as it arrives. Assistant replies render in normal white with
terminal markdown support: heading levels (H1 enlarged/underlined, H2
underlined, H3 colored), bold (bright white so it still contrasts on CJK fonts), italic, inline code, fenced code blocks,
lists, quotes, and links all get ANSI styling while remaining
width-wrapped for the terminal. System-prompt / `<system-reminder>` / `AGENTS.md` injections collapse to a
`提示词注入:系统预设 AGENTS.MD` card (sources joined when several match).
Reasoning, tool, subagent, plan, question, and prompt cards are
each expandable/collapsible independently. Empty input: `↑`/`↓` (same as
`Ctrl+N`/`Ctrl+P`) move the highlight, `Enter` toggles, `Ctrl+R` expands the latest card (or all once selected),
`Esc` drops the selection. Click a card header to toggle it. Subagent cards
start collapsed even when several run at once. `Alt+1..4` jumps to the latest
thinking / plan / subagent / reply.

The transcript is scrollable: `PgUp`/`PgDn` or the mouse wheel move back
through earlier reasoning blocks and tool calls, a `↑ 已回看 N 行` indicator
shows the scroll position, and `Esc` (or sending a message) returns to the
live bottom.

The terminal window title mirrors the session state while unfocused: an
animated spinner plus `运行中 · 工具 N` while working, `✓ 已完成` for a few
seconds after completion, and `待命` when idle. A terminal bell rings on
completion (`DSH_TUI_NO_BELL=1` disables it).

Tool calls render as compact cards instead of raw argument JSON. The title
stays the default foreground; the status dot is yellow / green / red for
running / ok / error. A successful call shows the dot alone — no `[ok]`
suffix — while a failure still carries `[error]` and an in-flight call
`[running…]` (plus `[退出码 N]` / `[信号 X]` when a shell exits). Consecutive
reads or edits of the same path fold into one card (`×N`, cumulative
chars/lines, appended diffs, a brief flip animation).
Shell tools show the command as dim-grey `$ command`. File mutations
(`edit` / `write` / `str_replace_editor`) carry a git-style red/green
deletions/additions stat in the header (` -13 +24`; zero parts drop out)
and start collapsed like every other card. Expanding one paints the
applied change git-style: a path header, `-` lines on a dark-red
background, `+` lines on a dark-green background, and a
`└ +N -M · K file(s)` footer. If the body would overflow the workspace, a
dedicated inspect view opens (`Esc` returns to the session). Other tools
show a short argument summary and start collapsed. Expanded generic calls
convert their JSON arguments and JSON results into readable indented
content — key/value fields, bullet lists, and multiline blocks for
code/content — instead of raw JSON text.

A web-aligned session stats line sits below the input box: turn/step counts,
model and tool wall time, first-token latency, tokens/second, cache-hit
percentage, and billed input/output tokens (`输入 12.3K · 输出 1.2K`), updated
as the session progresses.

While a turn is waiting on the provider, the status line shows
`等待响应 Ns`; if nothing arrives for 60s a warning appears and `Esc` /
`Ctrl+C` cancels the turn. Follow-ups sent while a turn is running are
acknowledged immediately (`⚡ … 排队 N`) and take effect at the next step
boundary, so the UI never looks frozen. Long-running work is not
misclassified: while tools are executing the status shows `工具执行中 N`,
and while subagents are running it shows `⠋ 子代理 N` (no
`等待响应`/stall warning). Plan mode adds `计划模式`, and a pending question
adds `等待用户回答` / `计划待审`. Child output stays inside that child's
collapsed card instead of being prefixed onto parent transcript lines;
`/subagents` lists active runs.

`/mode` opens the agent-mode picker backed by dsh's official preset roster:
标准模式 (standard), PTC 模式 (ptc; `code` on dsh 0.1.1), 极简模式 (minimal), 创造模式 (cordis),
智能路由模式 (routing-suite, from `dsh-routing-suite`),
plus any locally authored presets (e.g. `whoami-standard`). On a session that
has not produced work the switch applies immediately; otherwise it is remembered
as the default for the next launch. The active mode is shown in the
header/status line.

Shipped presets are labelled in the active `/language` (Standard / Minimal /
PTC / Cordis in English, 标准模式 / 极简模式 / PTC 模式 / 创造模式 in Chinese); a
preset you authored keeps the name in its own `preset.yml`. `/mode <id|label>`
switches directly, e.g. `/mode minimal` or `/mode 极简模式`. When the roster row
is missing, the TUI says so at boot and `/mode` reports the profile patch path
plus the `/mode fix` repair — see
[The preset roster `/mode` needs](#the-preset-roster-mode-needs).

```sh
dsh --profile tui --model deepseek-v4-flash
dsh --profile tui --no-color
dsh --profile tui --resume <session-id>
```

`dsh --profile tui` starts a fresh session directly in the main interface.
`dsh --profile tui --resume` (or `dsh --profile tui resume`) opens the
history-session picker before the main interface; `dsh --profile tui --resume
<session-id>` (or `dsh --profile tui resume <session-id>`) skips the picker
and resumes directly. `dsh --profile tui --new` explicitly starts fresh
without the picker. Resuming happens at launch: there is no in-app session
switch.

Picker keys: the visible page is nine rows so `1-9` always map onto every
on-screen item (`0` starts a new session). `↑`/`↓` (or `Ctrl+P`/`Ctrl+N`)
move the highlight; `Enter` resumes the focused row. Typing (or `/` /
`Ctrl+F`) filters by title, session id, or cwd; `PgUp`/`PgDn` page; `Esc`
first leaves the filter, then cancels. The history list itself is not
capped. Reading is lazy: the first nine sessions are inspected and painted
only once their titles are known — no raw id is ever shown and then
replaced — and older sessions are read when you reach for them (press
`↓`/`PgDn`/`End` past the last row, or filter, which looks deeper on its
own). Labels are cached in `$DSH_HOME/tui-session-index.json`.
New and resume launches paint a splash immediately; the frontend relay
spawns the Host without waiting for the plugin loader. Resuming a session
skips token chunks and lays out only the visible tail on the first paint.

## Jump-host / proxied SSH

Each paint is one `stdout.write` of dirty rows only, so a jump host or
corporate proxy does not see one SSH packet per line. Local ttys use 80 ms.
Over SSH the TUI probes CSI 6n once and picks 80 / 160 / 250 / 400 ms from
the round-trip. `DSH_TUI_PAINT_MS` always wins (40–1000). The stats line
starts with `SSH ●●●○ 90ms` (1 pip red, 2 yellow, 3+ green). The probe
does not write into the transcript.

Idle hangup exits the Host. A busy turn keeps it; `--resume` attaches to that
process. Do not start a second Host.

## Troubleshooting (Q&A)

Find your symptom; each answer is what to do, not a change log.

### Start-up and install

- **`dsh-ssh-tui: both stdin and stdout must be TTYs`** — start it from a real terminal or
  SSH session; a pipe, CI, or `&` background job will not do.
- **Windows: `host display socket did not appear`** — upgrade
  (`dsh plugin --profile tui add dsh-ssh-tui@latest`); older builds waited 15 seconds and
  timed out on the named pipe. If it still fails, attach `/diag` to an issue.
- **Windows: the in-app update reports `spawn dsh ENOENT`** — an older updater spawned a
  bare `dsh`, which on Windows is a `dsh.cmd` shim. Run the same upgrade once from the
  command line (`dsh plugin --profile tui add dsh-ssh-tui@latest`); the in-app update works
  from then on.
- **pnpm refuses to run the build script of a git dependency** — add the key pnpm prints to
  `allowBuilds` in the profile's `pnpm-workspace.yaml`, then reinstall.
- **After an upgrade `/mode` reports a missing service, or the preset tools vanish** — run
  `/doctor`: it judges the deployment composition item by item (patch parses, roster and
  code-runtime composed, no row mounted twice, host version inside the compatibility table,
  two `@deepseek-ai/dsh-scope` installs) and gives a verdict, its evidence and the command
  that acts on it. `/doctor --fix` writes the missing rows into `cordis.patch.yml`, keeping
  a `.bak-<timestamp>`; a restart picks it up.
- **"session is already running on pid N / attachable"** — that Host is alive: attach with
  `dsh --profile tui --resume`. Do not open a second window; clear `$DSH_HOME/tui-locks/`
  only once the pid is really gone.

### Sessions and locks

- **The Web UI refuses a session (`already owned by an active write handle`)** — the Host
  left over from an SSH drop still holds the write lock; it exits within a minute of the
  turn settling (`DSH_TUI_IDLE_EXIT_MS` / `ssh-tui.idleExit`). You can also attach to it
  with `--resume` and keep working.
- **The first `--resume` fails with `write EPIPE`, the second works** — the launcher waits
  and retries once by itself. If it keeps failing, `/diag` prints the channel and lock
  verdict chain, including the leftover-socket-file case.
- **Too many history sessions to tell apart** — filter the `--resume` picker by title,
  session id or working directory (`/` or `Ctrl+F`); older history is read on demand when
  you filter or page to the end, and the counter shows how many are still unloaded.

### Display and terminal

- **Windows: no colour at all, just black and white** — 0.7.0 read the unset `TERM` of a
  Windows session as "no terminal". Pin the palette to recover it:
  `set DSH_TUI_COLOR_DEPTH=8` (or `256` / `truecolor`); `/diag` prints the resolved palette
  and the hints behind it.
- **Colours look wrong, or a diff is one solid block you cannot read** — pin the palette
  with `DSH_TUI_COLOR_DEPTH=truecolor|256|8|none`. At `256` a diff is dark grey with green
  or red text; at `none` there is no colour at all, but `+`/`-`, `●`, `⚠` and `✖` remain —
  status is never carried by colour alone.
- **CJK or emoji crowd the characters next to them** — use a monospace font that covers
  them (Noto Sans Mono CJK, for instance). Those symbols are budgeted two cells and the
  painter asks for the narrow text form; a font without the glyph still makes the terminal
  fall back to a wider colour emoji.
- **The screen cannot keep up on a slow link** — `DSH_TUI_PAINT_MS` sets the paint interval
  (40–1000 ms: smaller is snappier and sends more); unset, it follows the round-trip
  measured at start-up (80 / 160 / 250 / 400 ms).
- **Screen reader, or you want a log** — start with `DSH_TUI_LINE_MODE=1`: plain appended
  lines, no cursor control, safe to `tee`.
- **Title bar or bell does nothing** — the terminal needs OSC 0 and BEL; `DSH_TUI_NO_BELL=1`
  turns the bell off.
- **Whole-row backgrounds are too loud on a dark terminal** — `DSH_TUI_COLOR_DEPTH=none`
  drops them; diffs still read through `+`/`-`.

### Status line and quota

- **The quota widget shows `░░░░░░░░ ?%`** — no reading has arrived yet (the API is slow or
  unreachable). It is not `0%`. The TUI asks again every 15 seconds and replaces it with the
  real number and window; if it never does, `/quota` reports the error.
- **There is no quota widget** — only SuperGrok, OpenCode Go and Command Code report quota;
  DeepSeek shows a balance line and a metered Zen route shows none.
- **What do `5Hr` / `1Wk` / `1Mo` mean?** — the window the number belongs to. The smallest
  window is shown by default (5-hour → weekly → monthly); `/quota` lists every window with
  its remaining share and reset time. Threshold alerts still fire on the tightest window.
- **The model name has no provider prefix** — the status line shows the model alone
  (`provider/model` is truncated to the model); the full route is in the header and
  `/status`, and a `sub:` chip shows the child's model the same way.
- **The subagent model is not what you want** — `/submodel` picks the model, `/subeffort`
  the reasoning effort, `/status` shows the current pair.
- **No `tok/s`** — that turn had no measurable model tokens; a step with only a first-token
  time shows `首字 1.2s`.
- **The plan strip asked for leftover todos only once** — that is deliberate: one reminder
  per open list, so a turn end never spawns another turn forever. To see it again, complete
  the list and start a new one.

### Drops and proxies

- **What happens when SSH drops** — idle: flush and exit. Busy (thinking, replying, a tool,
  a subagent): the turn is cancelled by default and the Host stays, so
  `dsh --profile tui --resume` attaches to it; `/disconnect continue` lets it run to
  completion instead. Do not start a second Host.
- **After reconnecting there is an extra notice line, `^[[17;1R` flashes, and the link chip
  goes hollow** — upgrade; the automatic retry stays in raw mode and drops queued bytes, so
  those replies are no longer echoed.
- **Model requests must go through a proxy** — start dsh with `--use-env-proxy` (not via
  `NODE_OPTIONS`) and split by domain with `NO_PROXY`, keeping domestic hosts that are faster
  direct and every local/intranet address in the list. The recipe and its revert are in
  [docs/remote-ops.md §4.7](docs/remote-ops.md).

### Asking for help

- **You need a readable report for a supporter** — type **`/diag`** in the session (local and
  read-only): versions, platform, session id, `DSH_HOME`, the display channel and whether it
  answers, the Host pid and lock state, link RTT, log format and size, and a verdict chain
  ("attaches to the leftover Host (pid N), do not open a second window"). Deployment
  questions go to **`/doctor`**. Paste both into an issue.

## Development

Platform-sensitive changes (environment variables, child processes, paths, terminal
capability) have their own note: [docs/platform.md](docs/platform.md). The rule is to put the
platform decision in an injectable pure function and assert the Windows branch in a test, so
it reddens on Linux too; `tests/platform-guards.test.mjs` statically rejects a new bare
`spawn('name')`, and CI's `test-windows` leg runs the same suite on a real Windows runner.

```text
src/picker.ts             launch history picker (9-row page, uncapped list, filter)
src/tui.ts                SshTui (re-exports leaf helpers)
src/paint.ts              incremental paint, SSH cadence, picker window
src/stats.ts              session stats ledger (turns/steps, LLM and tool time, TTFT, decode counts)
src/rows.ts               transcript row operations and the visible window (the row array stays in tui.ts)
src/dialogs.ts            dialog key rules (questions, confirm, inspect overlay)
src/commands.ts           slash-command catalog and suggestions
src/auto-approval.ts      rule-table first pass
src/approval-reviewer.ts  AI review prompt and JSON parse
src/i18n/                 zh/en UI catalogs
```

```sh
npm install
npm run build
```

## Privacy

All sessions, credentials, and settings live under `$DSH_HOME` (default
`~/.dsh`) — never inside this repository. `.gitignore` excludes
`node_modules/`, build output, `.env*`, keys, session logs, and local state, so
cloning or uploading the repo never carries user sessions or secrets.

## License

MIT
