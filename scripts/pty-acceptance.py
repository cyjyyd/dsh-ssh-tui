#!/usr/bin/env python3
"""Acceptance check for the display relay, on a real PTY.

`npm test` drives the relay with fake streams. This drives it the way an SSH
window does: a real PTY, a terminal that answers CSI 6n one round-trip later,
and - like a terminal whose previous launcher died mid-probe - a leftover reply
that is already on the wire when this relay starts, plus a second one that lands
*inside* the measuring window. Those replies used to be read as the measurement
(~2 ms) and then forwarded to the Host, where they appeared in the prompt as
`[17;1R`; a request queued behind a full repaint reported the repaint
(1900 ms) instead of the link. Keys are typed while the probe is still running,
so the capture-then-forward path is exercised too.

The kernel echoes anything that arrives while the TTY is back in cooked mode,
so a leaked reply also shows up as `^[[17;1R` in the captured output, which is
the garbage that used to scroll over a reconnecting session.

Run it after `npm run build`:

    python3 scripts/pty-acceptance.py            # simulated 40 ms link
    python3 scripts/pty-acceptance.py 0.12       # simulated 120 ms link

Exit code 0 means: the Host received the typing and nothing else, the measured
round-trip is the simulated one, and no reply was echoed to the screen.
"""
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CHILD = os.path.join(HERE, 'pty-acceptance.mjs')
ROOT = os.path.dirname(HERE)


def run(rtt_seconds: float) -> dict:
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
    proc = subprocess.Popen(
        ['node', CHILD],
        stdin=slave, stdout=slave, stderr=slave,
        close_fds=True, cwd=ROOT,
    )
    os.close(slave)

    out = b''
    pending = []
    requests = 0
    typed = False
    start = time.time()
    while time.time() - start < 25.0 and proc.poll() is None:
        now = time.time()
        for due, payload in list(pending):
            if now >= due:
                os.write(master, payload)
                pending.remove((due, payload))
        # Typed while the relay is still measuring: the keystrokes have to be
        # kept and delivered once the Host is up, not dropped.
        if not typed and now - start > 0.15:
            os.write(master, b'ls\r')
            typed = True
        ready, _, _ = select.select([master], [], [], 0.02)
        if not ready:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        seen = out.decode('utf8', 'replace').count('\x1b[6n')
        while requests < seen:
            requests += 1
            if requests == 1:
                # A reply from whoever asked before us: already on the wire when
                # this relay started, and one that lands *inside* our window -
                # the pair that used to be read as "2 ms".
                pending.append((time.time(), b'\x1b[17;1R'))
                pending.append((time.time() + max(0.005, rtt_seconds * 0.35), b'\x1b[17;1R'))
            pending.append((time.time() + rtt_seconds, b'\x1b[17;1R'))
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()

    rendered = out.decode('utf8', 'replace')
    result = {'requests': requests, 'echoed_garbage': rendered.count('^[[17;1R')}
    marker = rendered.rfind('RESULT ')
    if marker == -1:
        result['error'] = 'child produced no RESULT line'
        result['output'] = rendered[-400:]
        return result
    tail = rendered[marker + len('RESULT '):].splitlines()[0]
    result.update(json.loads(tail))
    return result


def main() -> int:
    rtt = float(sys.argv[1]) if len(sys.argv) > 1 else 0.04
    expected_ms = round(rtt * 1000)
    result = run(rtt)
    print(json.dumps(result, ensure_ascii=False, indent=2))

    problems = []
    if result.get('error'):
        problems.append(result['error'])
    if result.get('received') != ['ls\r']:
        problems.append(f"the Host received {result.get('received')!r}, expected only the typing ['ls\\r']")
    measured = result.get('rtt')
    if not isinstance(measured, int):
        problems.append(f'the relay reported rtt={measured!r} instead of a measurement')
    elif not (expected_ms * 0.5 <= measured <= expected_ms * 2 + 15):
        problems.append(f'the relay reported rtt={measured}ms for a simulated {expected_ms}ms link')
    if result.get('echoed_garbage'):
        problems.append('a cursor reply was echoed to the screen')
    if result.get('reason') != 'goodbye':
        problems.append(f"the relay ended with {result.get('reason')!r}")

    if problems:
        print('\nFAIL')
        for problem in problems:
            print(f'  - {problem}')
        return 1
    print(f'\nOK: typing forwarded verbatim, rtt={measured}ms for a {expected_ms}ms link '
          f'(with two leftover replies per probe), no stray replies, no echoed garbage')
    return 0


if __name__ == '__main__':
    sys.exit(main())
