#!/usr/bin/env python3
"""Render a captured ANSI TUI frame to PNG with ImageMagick -draw.

Every cell is drawn at its own x, and each glyph comes from the first font that
actually has it (fontconfig's answer, which is what a terminal falls back to).
Drawing whole runs from one font was silently wrong twice over: the CJK mono
font has no Braille block, so the context ring and the todo bar came out blank,
and an ornament it does have (●, ░) could be a double-width glyph that ran into
the cells after it. A substituted `o`/`#` for `○`/`░` hid the real footer.
"""

from __future__ import annotations

import functools
import re
import subprocess
import sys
from pathlib import Path

SGR_RE = re.compile(r"\x1b\[([0-9;]*)m")
ESC_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b].*?(?:\x07|\x1b\\)")

# The TUI's cell model: a two-cell glyph (CJK, a pinned emoji symbol) is drawn
# from the CJK face, a one-cell glyph from the Latin mono face a terminal would
# use for it. Drawing ● (one cell, but 15px wide in the CJK face) from the CJK
# font ran the link pips into each other and into the delay after them.
FONT = "Noto-Sans-Mono-CJK-SC"
NARROW_FONT = "DejaVu-Sans-Mono"
NARROW_FONT_FAMILY = "DejaVu Sans Mono"
POINT = 15
BG = "#1a1b26"
FG = "#c0caf5"
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


# Glyphs the primary font lacks are resolved through fontconfig, per character,
# exactly as a terminal resolves them; nothing is substituted by hand.


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
        char = line[i]
        width = display_width(char)
        if width > 0:
            cells.append((char, dict(state), width))
        i += 1
    return cells


def font_advance(font: str, point: int) -> int:
    """The cell pitch: one Latin advance of the font the TUI is drawn in."""
    def width(text: str) -> int:
        out = subprocess.run(
            ["convert", "-font", font, "-pointsize", str(point), f"label:{text}", "-format", "%w", "info:"],
            capture_output=True, text=True, check=True,
        )
        return int(out.stdout)
    return width("AA") - width("A")


CELL_W = font_advance(NARROW_FONT, POINT)


def _family_key(name: str) -> str:
    return name.replace(" ", "").replace("-", "").lower()


def _font_has(family: str, char: str) -> bool:
    if ord(char) < 128:
        return True
    out = subprocess.run(["fc-list", f":charset={ord(char):X}", "family"], capture_output=True, text=True)
    wanted = _family_key(family)
    return any(_family_key(part.strip()) == wanted for line in out.stdout.splitlines() for part in line.split(","))


@functools.lru_cache(maxsize=None)
def _fallback_file(char: str) -> str:
    out = subprocess.run(
        ["fc-match", f":charset={ord(char):X}", "-f", "%{file}"],
        capture_output=True, text=True,
    )
    path = out.stdout.strip()
    return path if path else FONT


@functools.lru_cache(maxsize=None)
def font_for(char: str, cells: int) -> str:
    """The font a terminal would use for this character in this many cells.

    Missing glyphs fall back to a font *file*: ImageMagick resolves a family name
    like `DejaVu Sans` to nothing and then draws no glyph at all, which is the
    very failure this is fixing.
    """
    if cells >= 2:
        return FONT if _font_has("Noto Sans Mono CJK SC", char) else _fallback_file(char)
    if _font_has(NARROW_FONT_FAMILY, char):
        return NARROW_FONT
    return _fallback_file(char)


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
        baseline = y0 + CELL_H - 5
        # Backgrounds first, as rectangles spanning the cells they cover: a diff
        # row's fill has to reach the whole row even where the glyph is thin.
        run_x: int | None = None
        run_right = 0
        run_bg = None
        for char, state, cell_width in row:
            _, bg, _, _ = style_key(state)
            if bg != run_bg:
                if run_bg and run_x is not None:
                    args.extend(["-fill", run_bg, "-draw", f"rectangle {run_x},{y0} {run_right},{y1}"])
                run_bg = bg
                run_x = PAD_X + col * CELL_W if bg else None
            right = PAD_X + (col + cell_width) * CELL_W
            if run_bg and run_x is not None:
                run_right = right
            col += cell_width
        if run_bg and run_x is not None:
            args.extend(["-fill", run_bg, "-draw", f"rectangle {run_x},{y0} {run_right},{y1}"])

        # Then one draw per cell, at that cell's own x: the grid comes from the
        # TUI's cell model, never from the font's advance.
        col = 0
        last_font = None
        last_fill = None
        last_weight = None
        for char, state, cell_width in row:
            fg, _, bold, italic = style_key(state)
            font = font_for(char, cell_width)
            if font != last_font:
                args.extend(["-font", font, "-pointsize", str(POINT)])
                last_font = font
            if fg != last_fill:
                args.extend(["-fill", fg])
                last_fill = fg
            weight = "Bold" if bold or italic else "Normal"
            if weight != last_weight:
                args.extend(["-weight", weight])
                last_weight = weight
            args.extend(["-draw", f"text {PAD_X + col * CELL_W + 1},{baseline} '{escape_draw(char)}'"])
            col += cell_width

    args.append(f"PNG24:{dest}")
    subprocess.run(["convert", *args], check=True)


if __name__ == "__main__":
    main()
