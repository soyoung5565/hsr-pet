#!/usr/bin/env python3
"""Inspect a petdex/Codex pet spritesheet.

Reports grid geometry and, per row, how many leading non-blank frames there
are (petdex sheets are left-packed; short states have transparent trailing
cells) plus per-cell opaque pixel counts.

Usage: python inspect_sheet.py <sheet.webp|png> [frame_w] [frame_h]
"""
import sys

import numpy as np
from PIL import Image

path = sys.argv[1]
fw = int(sys.argv[2]) if len(sys.argv) > 2 else 192
fh = int(sys.argv[3]) if len(sys.argv) > 3 else 208

im = Image.open(path).convert("RGBA")
w, h = im.size
cols, rows = max(1, w // fw), max(1, h // fh)
alpha = np.asarray(im)[:, :, 3]

print(f"{path}: {w}x{h} -> {cols} cols x {rows} rows (frame {fw}x{fh})")
for r in range(rows):
    per_cell = []
    for c in range(cols):
        block = alpha[r * fh:(r + 1) * fh, c * fw:(c + 1) * fw]
        per_cell.append(int((block > 8).sum()))
    leading = 0
    for v in per_cell:
        if v > 0:
            leading += 1
        else:
            break
    row_total = int((alpha[r * fh:(r + 1) * fh, :] > 8).sum())
    print(f"row {r:2d}: leading-frames={leading}  row-nonzero={row_total:>9}  per-cell={per_cell}")
