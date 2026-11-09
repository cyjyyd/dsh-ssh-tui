# H11 — real SSH silent-cut acceptance (Linux)

This is the `H11-SSH-01` runner for `REL085-WIN-AUTO/v1`. It replaces the old
manual "pull the network cable" step with a reproducible isolated-link test; it
is **not** a paused proxy and does not modify the production host's routes or
firewall.

## Topology

```
host namespace                          disposable network namespace
┌──────────────────────────┐            ┌──────────────────────────────┐
│ ssh client (node-pty)    │  veth      │ sshd :2222                   │
│ 10.231.0.1  ─────────────┼────────────┼─ 10.231.0.2                 │
│                          │            │ DSH TUI + Host               │
│                          │            │ mock Messages on 127.0.0.1   │
└──────────────────────────┘            └──────────────────────────────┘
```

The mock provider lives **inside** the namespace on loopback, so the blackhole
only cuts SSH. `iptables` rules are installed only in the disposable namespace,
matching the veth and TCP/2222, and both directions are `DROP` (no FIN/RST).

## Run

Requires Linux, root or `CAP_NET_ADMIN`, `unshare`, `ip`, `iptables`, `sshd`,
`ssh`, `ssh-keygen`, `zstd`, `curl`-free Node, and `node-pty` in the selected
Host install.

```bash
node tests/h11/h11-ssh-cut.mjs \
  --host 0.2.2-rc.1 \
  --install /path/to/exact-host-install \
  --template /path/to/disposable-profile-template \
  --iterations 3 \
  --blackhole-ms 5000
```

`--template` is a disposable DSH profile containing `dsh-ssh-tui@0.8.5` from the
candidate tarball. The runner copies it, writes a synthetic credential, and
disables only the optional first-prompt title plugin for the duration of H11 so
a title request cannot queue behind the main turn.

Evidence lands in `--evidence` (default `.h11-evidence/`): per-run JSON,
`tcp-before.txt`, `tcp-during.txt`, `session-first.jsonl`, `timeline.jsonl`,
`sshd.log`, `mock.log`. Each result includes the contract's machine-readable
assertions and a `json` evidence entry for the summarizer.

## PASS means

- real SSH TCP is `ESTABLISHED` before, during and after the drop;
- both directions are `DROP`ped; no FIN/RST is observed;
- the TUI's durable log has a `turn/start` with no matching `turn/end` during
  the blackhole;
- the Host pid is alive and the session remains running;
- the client is alive and quiet after already-queued frames drain;
- removing the rules lets the same connection answer `/diag`;
- the pre-cut user message appears exactly once, and a second SSH session adds
  no duplicate user message.

A paused TCP proxy, a closed terminal, a process kill, a FIN/RST teardown, or a
Host restart is **not** H11 PASS.
