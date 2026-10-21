#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给 build_sheet.py 造测试素材：模拟「小狼随宠」的形状/配色/走位。

不是最终素材，只用来验证拼表管线：
  - 帧数按 6/8/8/4/5/8/6/6/6 铺
  - 故意留一个空中间帧，验证连续性检查会报警
  - 故意画一小块高饱和蓝，验证导引色风险会被报出来
  - 走行动作帧做水平位移，跳跃做纵向位移

用法：python make_test_frames.py <out_root>
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent))
from build_sheet import COLS, ROWS, ROW_NAMES, ROW_REF  # noqa: E402

SS = 2  # supersample
CANVAS = 512


def draw_wolf(d: ImageDraw.ImageDraw, cx: float, cy: float,
              navy: tuple, gold: tuple, white: tuple) -> None:
    """一只 Q 版小狼：藏青外套 + 棒球帽 + 白胸口 + 扛球棒。"""
    s = SS
    body_w, body_h = 150 * s, 165 * s
    x0, y0 = cx - body_w / 2, cy - body_h / 2

    # 腿
    d.rounded_rectangle([x0 + 22 * s, y0 + body_h - 46 * s,
                         x0 + 52 * s, y0 + body_h], 12 * s, fill=navy)
    d.rounded_rectangle([x0 + body_w - 52 * s, y0 + body_h - 46 * s,
                         x0 + body_w - 22 * s, y0 + body_h], 12 * s, fill=navy)
    # 身体（外套）
    d.rounded_rectangle([x0, y0 + 40 * s, x0 + body_w, y0 + body_h], 40 * s, fill=navy)
    # 白胸口
    d.ellipse([x0 + 52 * s, y0 + 74 * s, x0 + body_w - 52 * s,
               y0 + body_h - 34 * s], fill=white)
    # 金色装饰扣
    d.ellipse([x0 + 24 * s, y0 + 96 * s, x0 + 44 * s, y0 + 116 * s], fill=gold)
    d.ellipse([x0 + body_w - 44 * s, y0 + 96 * s,
               x0 + body_w - 24 * s, y0 + 116 * s], fill=gold)
    # 头
    head_cy = y0 + 26 * s
    hr = 62 * s
    d.ellipse([cx - hr, head_cy - hr, cx + hr, head_cy + hr], fill=(150, 150, 158))
    # 尖耳
    d.polygon([(cx - 52 * s, head_cy - 34 * s), (cx - 40 * s, head_cy - 74 * s),
               (cx - 16 * s, head_cy - 44 * s)], fill=(150, 150, 158))
    d.polygon([(cx + 52 * s, head_cy - 34 * s), (cx + 40 * s, head_cy - 74 * s),
               (cx + 16 * s, head_cy - 44 * s)], fill=(150, 150, 158))
    # 口鼻白斑
    d.ellipse([cx - 34 * s, head_cy - 6 * s, cx + 34 * s, head_cy + 46 * s],
              fill=white)
    # 金琥珀大眼
    for ex in (-24, 24):
        d.ellipse([cx + (ex - 15) * s, head_cy - 30 * s,
                   cx + (ex + 15) * s, head_cy + 4 * s], fill=(224, 176, 60))
        d.ellipse([cx + (ex - 6) * s, head_cy - 22 * s,
                   cx + (ex + 6) * s, head_cy - 8 * s], fill=(40, 28, 10))
    # 棒球帽
    d.chord([cx - hr, head_cy - hr - 14 * s, cx + hr, head_cy + 26 * s],
            180, 360, fill=navy)
    d.ellipse([cx - 46 * s, head_cy - 62 * s, cx + 46 * s, head_cy - 40 * s],
              fill=(200, 158, 48))  # 帽檐
    d.ellipse([cx - 13 * s, head_cy - 58 * s, cx + 13 * s, head_cy - 38 * s],
              fill=gold)          # 帽徽
    # 扛着球棒
    d.rounded_rectangle([cx + 62 * s, cy - 96 * s, cx + 82 * s, cy + 88 * s],
                        9 * s, fill=(28, 26, 32))


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "test_frames")
    navy, gold, white = (28, 34, 68), (212, 168, 62), (245, 245, 248)
    RISKY_BLUE = (30, 90, 240)   # 故意放导引色

    for r in range(ROWS):
        d = root / f"row{r}"
        d.mkdir(parents=True, exist_ok=True)
        for c in range(ROW_REF[r]):
            img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
            dr = ImageDraw.Draw(img)

            cx, cy = CANVAS / 2, CANVAS / 2
            bob = 0
            if r in (1, 2):                      # 走：水平位移 + 轻微上下
                dirn = 1 if r == 1 else -1
                cx += dirn * (c - 3) * 16
                bob = (0, 6, 0, 6)[c % 4]
            elif r == 4:                         # 跳：纵向弧线
                import math
                bob = -abs(math.sin(c / (ROW_REF[r] - 1) * math.pi)) * 150
            elif r == 3:                         # 招手：左右摆
                bob = (0, -10, 0, -14)[c % 4]
            elif r in (5, 6, 7, 8):              # 情绪：轻微呼吸
                bob = (0, 5, 0, -5)[c % 4]

            draw_wolf(dr, cx, cy + bob, navy, gold, white)

            # row5 第 1 帧塞一块高饱和蓝，测导引色报警
            if r == 5 and c == 1:
                dr.rectangle([40, 40, 130, 110], fill=RISKY_BLUE + (255,))
            # row7 挖空中间一帧，测连续性报警
            if r == 7 and c == 2:
                img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))

            img.resize((CANVAS // SS, CANVAS // SS), Image.LANCZOS)\
               .save(d / f"{c:02d}.png")

        print(f"row{r} {ROW_NAMES[r]:<14} -> {ROW_REF[r]} frames -> {d}")

    print(f"\n测试素材已生成：{root}")
    print("故意埋了两个坑：row5 有导引色风险像素、row7 中间有空帧")
    return 0


if __name__ == "__main__":
    sys.exit(main())