#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对拍 check_frames.guide_color_mask 与桌宠源码 shouldClearGuidePixel。

背景：素材扫描器 check_frames.py 第一版的判据是「饱和度 + 通道相对比较」
的近似式，误报了一整屏（57 帧全报 3400+ 像素）。判据错了 → 尺子没校准就用。
本脚本把源码逻辑用 Node 原样跑一遍，与 Python 版逐像素对拍。

test_guide_color.py（已有）是穷举 + 随机的**自洽**测试；
这里是**对拍**，能抓住「两边都跑得动但判据不一致」的情况。

用法：python cross_check_guide.py [--random 200000]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_frames import guide_color_mask  # noqa: E402

# Desktop-pet 源码原文，逐字复制（app/src/render/hatch-pet-host.tsx:194-204）
JS_SRC = r"""
function shouldClearGuidePixel(r, g, b, a) {
  if (a < 8) return true;
  const saturated = Math.max(r, g, b) - Math.min(r, g, b) > 70;
  if (!saturated) return false;
  return (
    (r < 95 && g > 110 && b > 110) ||
    (g < 95 && r > 120 && b > 110) ||
    (r < 95 && g < 110 && b > 120) ||
    (r < 95 && g > 120 && b < 110)
  );
}
const fs = require('fs');
const px = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = new Array(px.length).fill(0);
for (let i = 0; i < px.length; i++) {
  const [r, g, b, a] = px[i];
  out[i] = shouldClearGuidePixel(r, g, b, a) ? 1 : 0;
}
fs.writeFileSync(process.argv[3], JSON.stringify(out));
"""


def cross_check(pixels, tmp_dir):
    os.makedirs(tmp_dir, exist_ok=True)
    js_path = os.path.join(tmp_dir, "guide.js")
    inp = os.path.join(tmp_dir, "in.json")
    outp = os.path.join(tmp_dir, "out.json")
    with open(js_path, "w", encoding="utf-8") as f:
        f.write(JS_SRC)
    with open(inp, "w", encoding="utf-8") as f:
        json.dump(pixels.tolist(), f)
    subprocess.run(["node", js_path, inp, outp], check=True,
                   capture_output=True)
    with open(outp, encoding="utf-8") as f:
        js_res = np.array(json.load(f), dtype=bool)

    # 向量化：一次喂 (N,1,3) 切片矩阵，避免 20 万次单像素调用
    py_res = guide_color_mask(pixels[:, :3].reshape(-1, 1, 3)).reshape(-1)
    return js_res, py_res


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--random", type=int, default=200_000)
    p.add_argument("--tmp", default=os.path.join(
        os.environ.get("TMPDIR", "."), "guide_cross"))
    a = p.parse_args()

    cases = []
    seen = set()
    # 阈值邻域：每个阈值的 -1 / 本身 / +1（70/95/110/120 全部覆盖）
    for r in (69, 70, 71, 89, 94, 95, 96, 109, 110, 111, 119, 120, 121):
        for g in (69, 70, 71, 89, 94, 95, 96, 109, 110, 111, 119, 120, 121):
            for b in (69, 70, 71, 89, 94, 95, 96, 109, 110, 111, 119, 120, 121):
                if (r, g, b) in seen:
                    continue
                seen.add((r, g, b))
                cases.append([r, g, b, 255])
    print(f"[cross] 阈值邻域穷举 {len(cases)} 例")

    rng = np.random.default_rng(20261012)
    rnd = rng.integers(0, 256, size=(a.random, 4), dtype=np.uint8)
    rnd[:, 3] = 255
    # 追加「饱和但接近阈值」的定向样本，专打近似实现的软肋
    hot = rng.integers(60, 140, size=(a.random // 2, 3))
    hot = np.hstack([hot, np.full((len(hot), 1), 255, dtype=np.uint8)])

    pixels = np.array(cases + rnd.tolist() + hot.tolist(), dtype=np.uint8)
    print(f"[cross] 合计 {len(pixels)} 例")

    js_res, py_res = cross_check(pixels, a.tmp)
    diff = np.nonzero(js_res != py_res)[0]
    if len(diff):
        print(f"❌ 不一致 {len(diff)} 例，前 10 例：")
        for i in diff[:10]:
            print(f"   rgb={pixels[i][:3].tolist()}  JS={js_res[i]}  PY={py_res[i]}")
        return 1
    print(f"[cross] ✅ 全部一致（{len(pixels)} 例，"
          f"其中 {int(js_res.sum())} 个判为导引色）")
    return 0


if __name__ == "__main__":
    sys.exit(main())