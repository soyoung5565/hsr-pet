#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对**真实渲染输出**逐像素扫导引色风险 + 空帧 + 构图居中度。

为什么不用「看配色采样」的方式：桌宠渲染器的 shouldClearGuidePixel 是
逐像素跑的，边界条件（通道极差 > 70 且高饱和青/品红/蓝/绿）只有拿真实
像素过一遍才算数。历史踩坑：凭感觉写近似判据漏检（测试蓝块只报 7 px，
实际 1141 px），改成逐字复刻源码才对上。

判据（复刻 app/src/render/hatch-pet-host.tsx 的 shouldClearGuidePixel）：
    range = max(r,g,b) - min(r,g,b) > 70  且  落在高饱和青/品红/蓝/绿

用法：
  python check_frames.py --dir E:\\hsr-pet-extract\\render_limao
  python check_frames.py --dir ... --sheet E:\\...\\sheet.webp   # 也扫拼好的表
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np
from PIL import Image

# 桌宠精灵表固定规格
SHEET_W, SHEET_H = 1536, 1872
COLS, ROWS = 8, 9
FRAME_W, FRAME_H = 192, 208
ROW_NAMES = [
    "idle", "running-right", "running-left", "waving", "jumping",
    "failed", "waiting", "running", "review",
]
ROW_FRAMES = [6, 8, 8, 4, 5, 8, 6, 6, 6]

RANGE_THRESH = 70      # 通道极差阈值
SAT_MIN = 0.35         # 高饱和下限


def guide_color_mask(rgb: np.ndarray) -> np.ndarray:
    """返回会被桌宠渲染器打成透明的像素掩码。

    ★ 逐字复刻 app/src/render/hatch-pet-host.tsx:194-204 的 shouldClearGuidePixel。
    这里**不要**用「饱和度 / 通道相对比较」之类的近似写法 —— 那是第一版的错，
    漏检过（测试蓝块只报 7 px，实际 1141 px）。源码是四个**固定绝对阈值**组合：

        (r < 95 && g > 110 && b > 110) ||   绿主导 → 青
        (g < 95 && r > 120 && b > 110) ||   红主导 → 品红
        (r < 95 && g < 110 && b > 120) ||   蓝主导
        (r < 95 && g > 120 && b < 110)      绿主导

    前置条件：max-min > 70（saturated）。rgb: (H,W,3) uint8 0..255。
    """
    r = rgb[..., 0].astype(np.int16)
    g = rgb[..., 1].astype(np.int16)
    b = rgb[..., 2].astype(np.int16)
    saturated = (rgb.max(axis=-1).astype(np.int16)
                 - rgb.min(axis=-1).astype(np.int16)) > RANGE_THRESH
    hit = saturated & (
        ((r < 95) & (g > 110) & (b > 110)) |
        ((g < 95) & (r > 120) & (b > 110)) |
        ((r < 95) & (g < 110) & (b > 120)) |
        ((r < 95) & (g > 120) & (b < 110))
    )
    return hit


def center_alpha(a: np.ndarray) -> int:
    """格子中心 8×8 采样 alpha>0 —— 渲染器判「该帧非空」的真实判据。
    注意不是「文件存在」：空图文件也会被算进帧数。"""
    h, w = a.shape
    y0, x0 = h // 2 - 4, w // 2 - 4
    return int((a[y0:y0 + 8, x0:x0 + 8] > 0).sum())


def bbox_of_alpha(a: np.ndarray):
    ys, xs = np.nonzero(a > 0)
    if len(xs) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def _row_guide_stats(al, rgb):
    """返回 (致命数, 可忽略数)。

    源码 shouldClearGuidePixel 对 alpha<8 的像素直接 return true —— 但那些像素
    本来就接近全透明，清成 0 无害。真正会造成「身上多个 1 像素洞」的，
    只有**本来可见**（alpha>=8）的命中像素。

    实测：1536x1872 全表 11 个命中里 8 个 alpha=0，只有 3 个可见。
    按「总数>0 就报错」的口径，每轮都会被这 3 个无关紧要的点刷屏，
    久了就麻木 → 真问题反而看不见。**改成按可见像素判定**，量级也对。
    """
    m = guide_color_mask(rgb)
    visible = al >= 8
    fatal = int((m & visible).sum())
    ignorable = int((m & ~visible).sum())
    return fatal, ignorable


def check_frames_dir(d: str) -> int:
    """检查 render_limao 那种 row{N}/{NN}.png 目录结构。返回问题总数。"""
    problems = 0
    for row in range(ROWS):
        rd = os.path.join(d, f"row{row}")
        expect = ROW_FRAMES[row]
        files = sorted(f for f in os.listdir(rd) if f.endswith(".png")) \
            if os.path.isdir(rd) else []
        if len(files) != expect:
            print(f"❌ row{row} {ROW_NAMES[row]:<14} 文件数 "
                  f"{len(files)} ≠ 期望 {expect}")
            problems += 1
        row_fatal = 0
        row_ign = 0
        for i, fn in enumerate(files):
            im = Image.open(os.path.join(rd, fn)).convert("RGBA")
            a = np.array(im)
            al = a[..., 3]
            ca = center_alpha(al)
            if ca == 0:
                print(f"❌ row{row}/{fn} 中心 8×8 alpha 全 0 "
                      f"→ 桌宠渲染器会当空帧丢弃")
                problems += 1
                continue
            fatal, ign = _row_guide_stats(al, a[..., :3])
            row_fatal += fatal
            row_ign += ign
            if fatal:
                print(f"❌ row{row}/{fn} 可见导引色像素 {fatal} 个 "
                      f"→ 桌宠会把它们打成透明（身上出现破洞）")
                problems += 1
            bb = bbox_of_alpha(al)
            if bb:
                x0, y0, x1, y1 = bb
                off_c = max(abs((x0 + x1) / 2 - im.width / 2),
                            abs((y0 + y1) / 2 - im.height / 2))
                if off_c > im.width * 0.10:
                    print(f"⚠ row{row}/{fn} 构图偏离中心 {off_c:.0f}px "
                          f"(画幅 {im.width})，缩进精灵表后会偏")
        tail = f"  (另有 {row_ign} 个透明区命中，无害)" if row_ign else ""
        print(f"✓ row{row} {ROW_NAMES[row]:<14} {len(files)}/{expect} 帧"
              f"  可见导引色={row_fatal}{tail}")
    return problems


def check_sheet(path: str) -> int:
    """检查拼好的精灵表。"""
    im = Image.open(path).convert("RGBA")
    a = np.array(im)
    problems = 0
    if im.size != (SHEET_W, SHEET_H):
        print(f"❌ 精灵表尺寸 {im.size} ≠ ({SHEET_W}, {SHEET_H})")
        problems += 1
    total_guide = 0
    for row in range(ROWS):
        leading = 0
        for col in range(COLS):
            y0, x0 = row * FRAME_H, col * FRAME_W
            cell = a[y0:y0 + FRAME_H, x0:x0 + FRAME_W]
            al = cell[..., 3]
            if center_alpha(al) > 0:
                leading = col + 1
        vis = a[..., :3]     # uint8 0..255，与源码判据一致
        row_fatal, row_ign = _row_guide_stats(a[..., 3], vis)
        total_guide += row_fatal
        expect = ROW_FRAMES[row]
        flag = "✓" if leading == expect else "❌"
        if leading != expect:
            problems += 1
        note = f" 可见导引色={row_fatal}"
        if row_ign:
            note += f" (+{row_ign} 透明区,无害)"
        print(f"{flag} row{row} {ROW_NAMES[row]:<14} "
              f"leading-frames={leading} 期望={expect}{note}")
    if total_guide:
        problems += 1
    print(f"\n精灵表导引色风险合计: {total_guide}")
    return problems


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dir", help="row{N}/ 目录（render_limao 输出）")
    p.add_argument("--sheet", help="拼好的 spritesheet")
    a = p.parse_args()

    problems = 0
    if a.dir:
        problems += check_frames_dir(a.dir)
    if a.sheet:
        problems += check_sheet(a.sheet)
    if not a.dir and not a.sheet:
        p.error("至少给 --dir 或 --sheet")
    print("\n" + ("✅ 全部通过" if problems == 0
                  else f"⚠ 共 {problems} 处问题"))
    return 0 if problems == 0 else 2


if __name__ == "__main__":
    sys.exit(main())