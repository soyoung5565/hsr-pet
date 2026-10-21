#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「单表情版」眼睛贴图：把选定表情的 sprite 铺满 mesh 真正采样的 UV 区域。

为什么这么做（实测踩坑）：
  * Eye mesh 的 UV 横跨整张图集（U 0.016~0.984 / V 0.294~0.668），
    直接渲染 → 40 个表情叠在一起，脸上一片白点。
  * 试图把 UV 重映射到某个格子（render_limao.remap_eye_uv）→
    眼睛变成全黑（采样落到格子边缘的透明 padding）。
  * 稳妥做法：**不动 UV，改造贴图**。量出 mesh 实际采样的 UV 矩形，
    把选中的 sprite 等比缩放后铺满这个矩形。这样采样必然命中。

用法：
  python make_eye_texture.py <Eye_Color_A.png> <out.png> \\
      --cell 1,4 --uv 0.016,0.984,0.294,0.668
"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

GRID_ROWS, GRID_COLS = 5, 8


def cell_box(img_w: int, img_h: int, row: int, col: int):
    """返回某格在**像素**坐标下的 (x0, y0, x1, y1)，已考虑 V 轴翻转。"""
    x0 = round(col * img_w / GRID_COLS)
    x1 = round((col + 1) * img_w / GRID_COLS)
    # 图像 y=0 在顶部；UV v 越大越靠上 → 第 0 行对应图的底部
    y0 = round((GRID_ROWS - 1 - row) * img_h / GRID_ROWS)
    y1 = round((GRID_ROWS - row) * img_h / GRID_ROWS)
    return x0, y0, x1, y1


def content_bbox(img: Image.Image, alpha_thr: int = 24):
    """返回图内不透明内容的包围盒（像素）。"""
    bbox = img.split()[-1].point(lambda v: 255 if v > alpha_thr else 0).getbbox()
    return bbox


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--cell", default="1,4")
    ap.add_argument("--uv", default="0.016,0.984,0.294,0.668",
                    help="mesh 实际采样的 UV 矩形 u0,u1,v0,v1")
    args = ap.parse_args()

    src = Image.open(args.src).convert("RGBA")
    W, H = src.size
    r, c = (int(v) for v in args.cell.split(","))
    u0, u1, v0, v1 = (float(v) for v in args.uv.split(","))

    # 1) 取目标格 → 只留内容（去掉 padding）
    bx0, by0, bx1, by1 = cell_box(W, H, r, c)
    sprite = src.crop((bx0, by0, bx1, by1))
    sb = content_bbox(sprite)
    if sb is None:
        raise SystemExit(f"row{r} col{c} 是空白格，换一个")
    sprite = sprite.crop(sb)
    print(f"[eye] 源格 row{r} col{c}: 格子 {bx1-bx0}x{by1-by0}, "
          f"内容 {sprite.size}")

    # 2) mesh 采样区在像素上对应的矩形（同样做 V 翻转）
    px0, px1 = round(u0 * W), round(u1 * W)
    py0, py1 = round((1 - v1) * H), round((1 - v0) * H)
    region_w, region_h = px1 - px0, py1 - py0
    print(f"[eye] mesh 采样区像素: x[{px0},{px1}] y[{py0},{py1}] "
          f"= {region_w}x{region_h}")

    # 3) sprite 等比缩放后居中放进该区域（保持比例，不拉伸）
    scale = min(region_w / sprite.width, region_h / sprite.height)
    new_w = max(1, round(sprite.width * scale))
    new_h = max(1, round(sprite.height * scale))
    sprite = sprite.resize((new_w, new_h), Image.LANCZOS)

    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    out.paste(sprite, (px0 + (region_w - new_w) // 2,
                       py0 + (region_h - new_h) // 2))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    out.save(args.out)
    print(f"[eye] 写出 {args.out}  sprite {sprite.size} -> "
          f"铺进 {region_w}x{region_h} 区域")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())