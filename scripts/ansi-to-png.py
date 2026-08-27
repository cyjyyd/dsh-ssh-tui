#!/usr/bin/env python3
"""Render a captured ANSI TUI frame to PNG with ImageMagick -draw."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

SGR_RE = re.compile(r"\x1b\[([0-9;]*)m")
ESC_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b].*?(?:\x07|\x1b\\)")

FONT = "Noto-Sans-Mono-CJK-SC"
POINT = 15
BG = "#1a1b26"
FG = "#c0caf5"
CELL_W = 9
CELL_H = 20
PAD_X = 16
PAD_Y = 28

PALETTE_256 = [
    "#1a1b26", "#f7768e", "#9ece6a", "#e0af68",
    "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
    "#414868", "#f7768e", "#9ece6a", "#e0af68",
    "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
]


def color_256(index: int) -> str:
    if 0 <= index < 16:
        return PALETTE_256[index]
    if 16 <= index <= 231:
        index -= 16
        r = index // 36
        g = (index % 36) // 6
        b = index % 6
        ramp = [0, 95, 135, 175, 215, 255]
        return f"#{ramp[r]:02x}{ramp[g]:02x}{ramp[b]:02x}"
    gray = 8 + (index - 232) * 10
    return f"#{gray:02x}{gray:02x}{gray:02x}"


def apply_sgr(codes: list[int], state: dict) -> None:
    if not codes:
        codes = [0]
    i = 0
    while i < len(codes):
        code = codes[i]
        if code == 0:
            state.update(fg=FG, bg=None, bold=False, dim=False, italic=False, inverse=False)
        elif code == 1:
            state["bold"] = True
            state["dim"] = False
        elif code == 2:
            state["dim"] = True
        elif code == 3:
            state["italic"] = True
        elif code == 7:
            state["inverse"] = True
        elif code == 22:
            state["bold"] = False
            state["dim"] = False
        elif code == 23:
            state["italic"] = False
        elif code == 27:
            state["inverse"] = False
        elif 30 <= code <= 37:
            state["fg"] = PALETTE_256[code - 30]
        elif 90 <= code <= 97:
            state["fg"] = PALETTE_256[code - 90 + 8]
        elif 40 <= code <= 47:
            state["bg"] = PALETTE_256[code - 40]
        elif 100 <= code <= 107:
            state["bg"] = PALETTE_256[code - 100 + 8]
        elif code == 39:
            state["fg"] = FG
        elif code == 49:
            state["bg"] = None
        elif code == 38 and i + 2 < len(codes) and codes[i + 1] == 5:
            state["fg"] = color_256(codes[i + 2])
            i += 2
        elif code == 48 and i + 2 < len(codes) and codes[i + 1] == 5:
            state["bg"] = color_256(codes[i + 2])
            i += 2
        i += 1


# Noto Sans Mono CJK SC is missing several TUI ornaments; keep cell width.
GLYPH_FALLBACK = {
    "❯": ">",
    "›": ">",
    "▸": ">",
    "▾": "v",
    "▶": ">",
    "◀": "<",
    "◆": "*",
    "●": "●",
    "○": "o",
    "◐": "o",
    "░": "#",
}


def display_width(char: str) -> int:
    cp = ord(char)
    if cp < 32 or 0x7F <= cp <= 0x9F:
        return 0
    if (
        0x1100 <= cp <= 0x115F
        or 0x2E80 <= cp <= 0xA4CF
        or 0xAC00 <= cp <= 0xD7A3
        or 0xF900 <= cp <= 0xFAFF
        or 0xFE10 <= cp <= 0xFE19
        or 0xFE30 <= cp <= 0xFE6F
        or 0xFF00 <= cp <= 0xFF60
        or 0xFFE0 <= cp <= 0xFFE6
        or 0x1F300 <= cp <= 0x1FAFF
        or 0x20000 <= cp <= 0x3FFFD
    ):
        return 2
    return 1


def parse_line(line: str) -> list[tuple[str, dict, int]]:
    state = {"fg": FG, "bg": None, "bold": False, "dim": False, "italic": False, "inverse": False}
    cells: list[tuple[str, dict, int]] = []
    i = 0
    while i < len(line):
        if line[i] == "\x1b":
            match = SGR_RE.match(line, i)
            if match:
                codes = [int(part) for part in match.group(1).split(";") if part]
                apply_sgr(codes, state)
                i = match.end()
                continue
            other = ESC_RE.match(line, i)
            if other:
                i = other.end()
                continue
        char = GLYPH_FALLBACK.get(line[i], line[i])
        width = display_width(char)
        if width > 0:
            cells.append((char, dict(state), width))
        i += 1
    return cells


def escape_draw(text: str) -> str:
    return text.replace("\\", "\\\\").replace("'", "\\'")


def style_key(state: dict) -> tuple:
    fg, bg = state["fg"], state["bg"]
    if state["inverse"]:
        fg, bg = (bg or BG), fg
    if state["dim"]:
        fg = "#565f89"
    return (fg, bg, state["bold"], state["italic"])


def main() -> None:
    src = Path(sys.argv[1])
    dest = Path(sys.argv[2])
    caption = sys.argv[3] if len(sys.argv) > 3 else ""
    lines = src.read_text(encoding="utf-8").splitlines()
    parsed = [parse_line(line) for line in lines]
    cols = max((sum(width for _, _, width in row) for row in parsed), default=80)
    extra = 1 if caption else 0
    width = PAD_X * 2 + cols * CELL_W
    height = PAD_Y + (len(parsed) + extra) * CELL_H + 12

    args: list[str] = [
        "-size", f"{width}x{height}",
        f"xc:{BG}",
        "-font", FONT,
        "-pointsize", str(POINT),
    ]
    if caption:
        args += ["-fill", "#7aa2f7", "-draw", f"text {PAD_X},{PAD_Y - 8} '{escape_draw(caption)}'"]

    for row_index, row in enumerate(parsed):
        col = 0
        y0 = PAD_Y + (row_index + extra) * CELL_H
        y1 = y0 + CELL_H
        run_text = ""
        run_key: tuple | None = None
        run_x = PAD_X
        run_width = 0

        def flush() -> None:
            nonlocal run_text, run_key, run_x, run_width
            if not run_text or run_key is None:
                run_text = ""
                run_width = 0
                return
            fg, bg, bold, italic = run_key
            if bg:
                args.extend(["-fill", bg, "-draw", f"rectangle {run_x},{y0} {run_x + run_width},{y1}"])
            args.extend(["-font", FONT, "-pointsize", str(POINT)])
            args.extend(["-fill", fg])
            if bold:
                args.extend(["-weight", "Bold"])
            else:
                args.extend(["-weight", "Normal"])
            baseline = y0 + CELL_H - 5
            args.extend(["-draw", f"text {run_x + 1},{baseline} '{escape_draw(run_text)}'"])
            run_text = ""
            run_width = 0

        for char, state, cell_width in row:
            key = style_key(state)
            if run_key != key:
                flush()
                run_key = key
                run_x = PAD_X + col * CELL_W
            run_text += char
            run_width += cell_width * CELL_W
            col += cell_width
        flush()

    args.append(f"PNG24:{dest}")
    subprocess.run(["convert", *args], check=True)


if __name__ == "__main__":
    main()
