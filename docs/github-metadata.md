# GitHub metadata: suggested values (maintainer applies them)

The repository carries its presentation in two places that **no file in this tree can
set**: the **About** box (description, website, topics) and the repository **name**.
Both are GitHub-side settings, so this page records the values to paste in, and the
reasoning, instead of a script that would need a token with admin scope and could
silently do the wrong thing outside a release window.

Status: the values below were **applied by the maintainer** (description, topics, website);
the applied state is recorded further down, and the reasoning is kept so a later change
can be judged against it. Anything still pending is listed as a manual action.

## Repository description

```
DSH Relay — remote-first terminal UI for DeepSeek Harness coding agents. SSH reconnect, Windows/ConPTY, plain ANSI, incremental redraws.
```

Notes:

- It leads with the product name (`DSH Relay`) and keeps the package/install coordinate
  (`dsh-ssh-tui`) out of the description: the description is what the product *is*, and
  the install command is in the README's first screen.
- The em dash is intentional; GitHub's About box renders plain text.

## Topics

```
deepseek
deepseek-harness
coding-agent
cli
tui
terminal
ssh
remote-development
windows-terminal
conpty
```

Notes:

- `deepseek-harness` and `coding-agent` are the two that describe the category rather than
  the implementation: without them the repository looks like a terminal library.
- `conpty` and `windows-terminal` mark the Windows path as first-class; on GitHub those
  topics are sparsely used, so a search for them currently returns almost nothing — which
  is exactly why they are worth having.
- Deliberately **not** included: `ai`, `llm`, `productivity`, `developer-tools`. They are
  broad enough to be noise, and the topic list is a filter, not an SEO surface.

## Repository name (not this phase)

`cyjyyd/dsh-ssh-tui` stays as it is through P1 and P2. A rename is the P3 decision in
[`decisions/brand-dsh-relay.md`](decisions/brand-dsh-relay.md), evaluated against
[`brand-metrics.md`](brand-metrics.md); if it ever happens, GitHub keeps redirects for
the old slug, and every badge/link in this tree is rewritten in that one commit.

## Applied state (verified against the API, 2026-10-05)

The About box, the topic list and the Discussions switch are repository settings, so this
section records what is **actually applied** — the file must not describe an intended
state as if it were the current one. Evidence: `GET /repos/cyjyyd/dsh-ssh-tui`.

| Setting | Applied value |
|---|---|
| Description | *DSH Relay — remote-first terminal UI for DeepSeek Harness coding agents. SSH reconnect, Windows/ConPTY, plain ANSI, incremental redraws.* |
| Topics | `cli` `coding-agent` `conpty` `deepseek` `deepseek-harness` `deepseek-harness-plugins` `dsh-plugin` `remote-development` `tui` `windows-terminal` |
| Website | `https://www.npmjs.com/package/dsh-ssh-tui` |
| Discussions | **enabled** (`has_discussions: true`) |
| Issues | enabled; the `terminal-compatibility` label exists |
| Default branch | `main` |

Topics differ from the list above this section (`terminal` and `ssh` were not applied;
`deepseek-harness-plugins` and `dsh-plugin` were): the suggestion and the applied set are
both valid, and the applied one is what a reader sees — so it is the one recorded here.
If the maintainer changes it again, change this table in the same pass.

## Social preview image

GitHub's social card is generated from the repository; if a custom image is wanted, use
`docs/screenshots/workspace.png` (100×20 workspace frame, already in the package) rather
than a new asset — a card that does not look like the product is worse than the default.

## Discussions: enabled, but not the front door for compatibility reports

The repository **has Discussions enabled**. This phase deliberately does not move terminal
compatibility feedback into it:

- **Compatibility reports stay on the issue form**
  (`.github/ISSUE_TEMPLATE/terminal-compatibility.yml`): the fields are the point — OS,
  terminal, transport, `TERM`, versions, the capability checklist — and an issue form
  collects them structurally, into the `terminal-compatibility` label that
  [`terminals.md`](terminals.md) links back from. A free-form Discussion post does not.
- **Discussions keep the traffic it is good at**: usage questions, "is this a bug or my
  terminal", longer-running threads that do not belong in an issue tracker. Nothing needs
  to be closed down for that — the two do not compete, they are sorted by whether the
  answer has to be structured.
- **No maintainer action required** for Discussions in P1/P2; keep it enabled.

## What is *not* set here

- **A separate website**: the About website field points at the npm page, which is where a
  reader can actually install from. No site exists, and a placeholder would be worse.
- **A custom social preview image**: see below.
