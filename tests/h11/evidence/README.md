# H11 retained evidence

This is a **sanitized, synthetic** retained slice of the H11 run. The runner was
executed three times per exact Host line (6/6 PASS); one result per Host is kept
here so the assertions, TCP state, durable turn state and one-message/one-row
checks are reviewable without a multi-megabyte transcript.

- `combined.json` — both Hosts, contract version and candidate identity.
- `summary.json` — `win-auto-summarize.mjs --runner linux` result.
- `<host>/tcp-before.txt`, `tcp-during.txt` — real SSH flow around the DROP.
- `<host>/timeline.jsonl` — netns/veth, rules, host/turn state timestamps.
- `<host>/session-first.jsonl` — synthetic session log; marker appears once.
- `<host>/sshd.log`, `mock.log` — real sshd and netns-local mock server logs.

No private keys, production Home, real credentials, user text or paid model
calls are included. `/tmp/h11-*` paths are disposable runner paths.
