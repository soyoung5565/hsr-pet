#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分析眼睛贴图 atlas，找出「正常睁眼」那一格，并给出重映射 UV。

问题：Eye mesh 的 UV 横跨整张图集（U 0.016~0.984, V 0.294~0.668），
里面叠了 ~40 种表情 sprite。所以静态渲染时脸上会出现一堆白点。

解法：把 Eye mesh 的所有 UV 压到**同一个格子**（正常睁眼），
这样整只眼睛就是一对正常的眼睛。

用法：
  python fix_eye_uv.py <Eye_Color_A.png>            # 只分析，列出候选格子
  python fix_eye_uv.py <Eye_Color_A.png> --pick 2,0 # 指定格子(行,列)
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image


def find_cells(path: Path, rows: int = 5, cols: int = 8, alpha_thr: int = 24):
    """按 rows×cols 网格切图，报告每格的不透明像素数。"""
    im = Image.open(path).convert("RGBA")
    W, H = im.size
    a = np.asarray(im)[:, :, 3]
    print(f"{path.name}: {W}x{H}, 网格 {rows}x{cols}")
    cells = []
    for r in range(rows):
        line = []
        for c in range(cols):
            x0, x1 = round(c * W / cols), round((c + 1) * W / cols)
            # V 轴翻转：图像 y=0 在顶部，UV v=1 在顶部
            y0, y1 = round((rows - 1 - r) * H / rows), round((rows - r) * H / rows)
            block = a[y0:y1, x0:x1]
            cnt = int((block > alpha_thr).sum())
            line.append(cnt)
            cells.append((r, c, cnt, (x0, y0, x1, y1)))
        print(f"  row{r}: " + " ".join(f"{v:>7}" for v in line))
    return cells


def pick_normal_eye(cells):
    """挑「正常睁眼」：不透明像素中等偏上、且不是爱心/星星那种高饱和彩色。

    判据：白眼球+黑瞳孔 → 该格内部有黑白两极且彩色像素少。
    """
    scored = []
    for r, c, cnt, box in cells:
        if cnt < 2000:          # 太小 = 空白格
            continue
        scored.append((cnt, r, c))
    scored.sort(reverse=True)
    print("\n按不透明像素数排序的候选（正常眼白较大）：")
    for cnt, r, c in scored[:12]:
        print(f"  row{r} col{c}  opaque={cnt}")
    return scored


def main() -> int:
    path = Path(sys.argv[1])
    cells = find_cells(path)
    scored = pick_normal_eye(cells)

    # 默认推荐：row1 col0（第二行第一格，vision 描述为"正常白眼球+黑瞳孔"）
    if "--pick" in sys.argv:
        idx = sys.argv.index("--pick")
        r, c = (int(v) for v in sys.argv[idx + 1].split(","))
    else:
        r, c = 1, 0
    W, H = Image.open(path).size
    rows, cols = 5, 8
    u0, u1 = c / cols, (c + 1) / cols
    # 图像行 -> UV（V 翻转）
    v0, v1 = 1.0 - (r + 1) / rows, 1.0 - r / rows
    print(f"\n选定格子: row{r} col{c}")
    print(f"  UV 区间: U[{u0:.4f}, {u1:.4f}]  V[{v0:.4f}, {v1:.4f}]")
    print(f"  像素区间: x[{round(u0*W)}, {round(u1*W)}]  "
          f"y[{round((1-v1)*H)}, {round((1-v0)*H)}]")

    # 输出 Blender 用的重映射参数
    print("\n# Blender 里对 Eye mesh 做 UV 归一化 + 平移：")
    print(f"  uv_u = (u - {u0:.6f}) / {1/cols:.6f}")
    print(f"  uv_v = (v - {v0:.6f}) / {1/rows:.6f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())