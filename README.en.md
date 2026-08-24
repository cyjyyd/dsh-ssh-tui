# dsh-ssh-tui

An SSH-friendly interactive terminal (TUI) plugin for [DeepSeek
Harness](https://github.com/deepseek-ai/deepseek-harness). It renders the agent
session as a plain-ANSI chat transcript, streams model output, shows tool calls,
answers approvals and `ask_user_question` prompts from the keyboard, and lets
you resume persisted sessions. No browser, no mouse, no heavy terminal
framework — designed for slow/remote SSH links.

中文部署指南：[README.md](README.md)

## Requirements

- Node.js >= 22.19
- `@deepseek-ai/dsh` CLI: `npm i -g @deepseek-ai/dsh`
- pnpm (used by `dsh plugin` to manage profile dependencies)

## Install

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

Or install the published npm package directly (requires `@deepseek-ai/dsh` and
`pnpm`, no local clone needed):

```sh
dsh plugin --profile tui add dsh-ssh-tui
# or from a repo checkout: bash scripts/install-npm.sh
```

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
   - custom OpenAI-compatible gateway (Completions);
   - custom OpenAI Responses gateway;
   - Anthropic Messages-compatible gateway;
2. for custom providers, enter a lowercase Provider ID (permanent), base URL,
   API key (masked while typing), and one or more model IDs — each step has a
   sensible template default. On the models step, press `Ctrl+F` to fetch the
   current model list straight from the provider endpoint;
3. confirm and save.

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

The plugin runs on Linux, macOS, and Windows (Node ≥ 22.19):

- Linux/macOS: same command as above; the wizard persists credentials in
  `~/.dsh/.credentials.yaml`, or `~/.dsh/env.sh` when a system-injected
  environment variable must be overridden.
- Windows (PowerShell or Windows Terminal): install with the same npm/dsh
  commands — `dsh` is on PATH via npm's global bin. The wizard stores the key
  through the dsh credential store, or runs `setx` (plus `env.cmd`) when an
  environment variable shadows the store. Agent shell tools automatically use
  PowerShell on Windows (the harness disables bash there).
- Legacy Windows consoles without VT support: set `DSH_TUI_NO_ALT_SCREEN=1`
  (and `--no-color` if needed) to skip the alternate-screen escape sequences.
- Keyboard input accepts both `\x7f` and `\x08` backspace, and both `\r` /
  `\r\n` line endings.

## Usage

| Key | Action |
| --- | --- |
| `Enter` | send the message; while the agent is running, steers it |
| `Tab` | complete the highlighted slash command |
| `↑` / `↓` | navigate slash-command suggestions (or input history) |
| `Esc` / `Ctrl+C` | cancel the running turn |
| `Ctrl+D` | exit |
| `Ctrl+L` | redraw |
| `Ctrl+T` | fold/unfold the input box (display-only; submission keeps the full text) |
| `↑` / `↓` | input history |
| `y` / `n` / `Esc` | answer an approval prompt |
| `1..9` + `Enter` | answer an `ask_user_question` dialog |

Type `/` to see slash-command suggestions — the panel merges the TUI's own
commands with every command the harness registers (`/goal`, `/plan`,
`/compact`, `/permission`, `/feedback`, ...). `Tab` completes, `Enter` runs.
`/help` lists everything.

`/model` opens a two-step selector: pick a model from the current provider's
catalog, then pick its reasoning effort (`off` / `high` / `max` when the
provider exposes them). The change applies to the next request without
changing the provider, updates the header/status line, and is remembered in
`agent-default-model` for future launches.

For OpenCode and other third-party providers, `/model` queries the provider's
endpoint (`GET {baseURL}/models`) for a live model list, falling back to the
configured catalog when the endpoint cannot be reached. Picking a model that
is not stored in the provider profile automatically adds it to
`llm-pi-ai.providers.<id>.models` so the harness can serve it.

Subagents follow the parent session's provider by default and run on the
lightweight `deepseek-v4-flash` model. `/submodel [model-id]` picks (or
directly sets) the subagent model, and `/subeffort` picks the subagent
reasoning effort or restores the provider default. Both commands are
remembered under `ssh-tui-subagent` in `$DSH_HOME/settings.yaml`.
`/subagents` lists active subagents, and `/subagents kill <session-id> [more ids...]`
releases selected continuable children using the harness 0.1.1
`drainContinuableChildren` capability.

Interrupted streaming output keeps the already-generated prefix and is marked
`⚠ interrupted`; team collaboration session events (`team/*`) are surfaced as
system messages. Harness slash commands that accept image attachments are
labelled `(images ok)` in the command list and completion hints.

`/usage` (alias `/quota`) works when the current provider is an OpenCode
source and keeps the two billing models distinct:

- **OpenCode Go** queries the official quota endpoint and shows rolling
  5-hour / weekly / monthly usage percentages, limit state, and reset times;
- **OpenCode Zen** is metered per API bill and has no fixed quota, so the TUI
  points to `https://opencode.ai/zen` for balance/billing and shows the
  session token usage it has recorded instead of inventing a quota.

The startup screen shows the official DeepSeek whale logo (rendered from the
harness favicon) in the DeepSeek brand color, with the wordmark below it. The
logo scales to the terminal width — a 52-column variant on wide terminals,
down to a compact variant on narrow ones — so it never looks squeezed. A
horizontal rule separates the workspace (transcript, reasoning, tool cards)
from the input area.

Model reasoning blocks are collapsed by default: while thinking a compact
`▸ 思考中 ⠹ · N 字 · Ns` line with a spinner replaces the raw stream, and
after the turn each block collapses to a `▸ 已思考 · N 行` summary without
its content. The thinking block can be expanded live while streaming to watch
the raw reasoning as it arrives. Assistant replies render in bold white with
terminal markdown support: heading levels (H1 enlarged/underlined, H2
underlined, H3 colored), bold, italic, inline code, fenced code blocks,
lists, quotes, and links all get ANSI styling while remaining
width-wrapped for the terminal. Reasoning and tool cards are
each expandable/collapsible independently — `Ctrl+N` / `Ctrl+P` move the
selection highlight between them, `Ctrl+R` expands/collapses all blocks at once
(individual blocks use `↑`/`↓` + `Enter`), and `Esc` drops the selection. With
the input box empty, `↑`/`↓` move the selection and `Enter` toggles the
selected block directly. Clicking a reasoning or tool header in the transcript
also toggles it.

The transcript is scrollable: `PgUp`/`PgDn` or the mouse wheel move back
through earlier reasoning blocks and tool calls, a `↑ 已回看 N 行` indicator
shows the scroll position, and `Esc` (or sending a message) returns to the
live bottom.

The terminal window title mirrors the session state while unfocused: an
animated spinner plus `运行中 · 工具 N` while working, `✓ 已完成` for a few
seconds after completion, and `待命` when idle. A terminal bell rings on
completion (`DSH_TUI_NO_BELL=1` disables it).

Tool calls render as compact cards instead of raw argument JSON. A colored
dot leads each card — yellow while running, green on success, red on failure
(a shell command with a non-zero exit or signal also turns red, with a
`[退出码 N]` / `[信号 X]` suffix). Shell tools show the command as
`$ command`, file mutations (`edit` / `write` / `str_replace_editor`) render
the applied change git-style: a path header, `-` lines on a light-red
background, `+` lines on a light-green background, and a `└ +N -M · K file(s)`
footer. File-mutation diffs are shown in full (never collapsed to a `… more`
line) and their cards start expanded. Other tools show a short argument
summary and start collapsed to a single line (the command, truncated with
`…` when long); expand to reveal output or the result body. Expanded generic
calls convert their JSON arguments and JSON results into readable indented
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
and while subagents are running it shows `子代理执行中 N` (no
`等待响应`/stall warning). Subagent start/end, child assistant output, child
tool calls/results, approvals, and `ask_user_question` prompts are all
rendered with a `[子代理 …]` label; `/subagents` lists active runs.

`/mode` opens the agent-mode picker backed by dsh's official preset roster:
标准模式 (standard), PTC 模式 (code), 极简模式 (minimal), 创造模式 (cordis),
智能路由模式 (routing-suite, from `dsh-routing-suite`),
plus any locally authored presets (e.g. `whoami-standard`). On a session that
has not produced work the switch applies immediately; otherwise it is remembered
as the default for the next launch. The active mode is shown in the
header/status line.

`/resume` switches the running TUI to a past session. With no argument it
opens a picker of recent sessions (excluding subagents), labeled by the user's
first message with a time/cwd description; `/resume <session-id>` switches
directly. Switching is refused while a turn is running.

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
without the picker. The in-app `/resume` command remains available for
switching while running.

## Development

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
