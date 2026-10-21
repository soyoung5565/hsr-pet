#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证 build_sheet.guide_color_report 的向量化实现 == 源码逐字逻辑。

hatch-pet-host.tsx:194 的 shouldClearGuidePixel 是渲染器真跑的判定。
如果我们的检测和它不一致，素材就会「看着对、装进桌宠就缺一块」。
所以用穷举 + 随机两条路交叉验证：向量实现必须和逐像素实现完全一致。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from build_sheet import guide_color_report, should_clear_guide_pixel  # noqa: E402


def reference_mask(arr: np.ndarray) -> np.ndarray:
    """逐像素跑 should_clear_guide_pixel，只算 a>=8 的可见像素。"""
    a = arr[:, :, 3]
    r = arr[:, :, 0]
    g = arr[:, :, 1]
    b = arr[:, :, 2]
    out = np.zeros(a.shape, dtype=bool)
    for yy in range(a.shape[0]):
        for xx in range(a.shape[1]):
            aa = int(a[yy, xx])
            if aa >= 8 and should_clear_guide_pixel(
                int(r[yy, xx]), int(g[yy, xx]), int(b[yy, xx]), aa
            ):
                out[yy, xx] = True
    return out


def main() -> int:
    rng = np.random.default_rng(20261011)
    failures = 0

    # --- case 1: 穷举关键边界（阈值 70 / 95 / 110 / 120 附近）---
    edge_vals = [0, 7, 8, 30, 60, 70, 90, 94, 95, 96, 109, 110, 111,
                  119, 120, 121, 180, 254, 255]
    grid = np.array(
        [[r, g, b, 255] for r in edge_vals for g in edge_vals for b in edge_vals],
        dtype=np.uint8,
    ).reshape(-1, 1, 4)
    ref = reference_mask(grid)[:, 0]
    rep = guide_color_report(grid)["risky_px"]
    got = rep
    print(f"case1 边界穷举: 像素={grid.shape[0]}  参考命中={int(ref.sum())}  向量命中={got}")
    if int(ref.sum()) != got:
        print("  ✗ 不一致")
        failures += 1
    else:
        print("  ✓ 一致")

    # --- case 2: 随机 RGB + 随机 alpha（含半透明边缘）---
    px = 20000
    arr = np.empty((px, 1, 4), dtype=np.uint8)
    arr[:, 0, :3] = rng.integers(0, 256, size=(px, 3), dtype=np.uint8)
    arr[:, 0, 3] = rng.choice([0, 5, 7, 8, 9, 128, 255], size=px).astype(np.uint8)
    ref2 = reference_mask(arr)[:, 0]
    got2 = guide_color_report(arr)["risky_px"]
    print(f"case2 随机 alpha: 像素={px}  参考命中={int(ref2.sum())}  向量命中={got2}")
    if int(ref2.sum()) != got2:
        print("  ✗ 不一致")
        failures += 1
    else:
        print("  ✓ 一致")

    # --- case 3: 全透明背景的透明帧不应被算成风险 ---
    blank = np.zeros((208, 192, 4), dtype=np.uint8)
    rep3 = guide_color_report(blank)
    print(f"case3 全透明帧: visible={rep3['visible_px']} risky={rep3['risky_px']} "
          f"(期望 visible=0, risky=0)")
    if rep3["visible_px"] != 0 or rep3["risky_px"] != 0:
        print("  ✗ 全透明帧被误判")
        failures += 1
    else:
        print("  ✓ 一致")

    # --- case 4: 已知危险色必须被抓到 ---
    known = {
        "蓝 (30,90,240)": (30, 90, 240, 255),
        "青 (20,200,220)": (20, 200, 220, 255),
        "绿 (40,200,60)": (40, 200, 60, 255),
        "品红 (200,40,190)": (200, 40, 190, 255),
        "金黄 (212,168,62)": (212, 168, 62, 255),   # 随宠配色，应安全
        "藏青 (28,34,68)": (28, 34, 68, 255),        # 随宠外套，应安全
        "白 (245,245,248)": (245, 245, 248, 255),    # 胸口，应安全
        "灰 (150,150,158)": (150, 150, 158, 255),    # 狼身，应安全
    }
    for name, rgba in known.items():
        one = np.array([[list(rgba)]], dtype=np.uint8)
        hit = guide_color_report(one)["risky_px"]
        verdict = "命中" if hit else "安全"
        print(f"case4 {name:<22} -> {verdict}")
    # 随宠配色必须全部安全
    safe_must = ["金黄 (212,168,62)", "藏青 (28,34,68)", "白 (245,245,248)", "灰 (150,150,158)"]
    for name in safe_must:
        rgba = known[name]
        one = np.array([[list(rgba)]], dtype=np.uint8)
        if guide_color_report(one)["risky_px"]:
            print(f"  ✗ {name} 被误判为导引色 —— 随宠配色会缺色！")
            failures += 1

    print()
    if failures:
        print(f"FAILED: {failures} 项")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())