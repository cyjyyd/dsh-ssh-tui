# GitHub metadata: suggested values (maintainer applies them)

The repository carries its presentation in two places that **no file in this tree can
set**: the **About** box (description, website, topics) and the repository **name**.
Both are GitHub-side settings, so this page records the values to paste in, and the
reasoning, instead of a script that would need a token with admin scope and could
silently do the wrong thing outside a release window.

Status: **for manual application in the GitHub UI** (Settings → General → Social preview
is separate, see the end).

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

## Social preview image

GitHub's social card is generated from the repository; if a custom image is wanted, use
`docs/screenshots/workspace.png` (100×20 workspace frame, already in the package) rather
than a new asset — a card that does not look like the product is worse than the default.

## What is *not* set here

- **Website**: `https://github.com/cyjyyd/dsh-ssh-tui#readme` (already `homepage` in
  `package.json`). No separate site exists, and an empty placeholder would be worse.
- **Discussions**: not enabled. The contribution path this phase adds is the terminal
  compatibility issue form; enabling Discussions before there is traffic splits the same
  few reports across two places.
