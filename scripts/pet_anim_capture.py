#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在跑着的桌宠里连拍多帧，验证 9 行动画真的在动。

为什么需要：素材「拼出来对」不等于「跑起来对」。渲染器有自己的一套
判空帧 / 导引色清理逻辑，只有让真程序播一遍、逐帧比对像素，才算验证过。

做法：CDP 里定时抓 canvas.toDataURL，落到 out_dir/frame_NNN.png，
同时记录每帧的 bbox 与非空像素数 → 用来判断「动画在动」而不是「卡住」。

用法：python pet_anim_capture.py --frames 24 --interval 0.15
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pet_probe import eval_js  # noqa: E402
from pet_shot import CANVAS_EXPR  # noqa: E402


def get_page(port):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list",
                                timeout=8) as r:
        ts = json.loads(r.read().decode())
    return next((t for t in ts if t.get("type") == "page"
                 and "5173" in t.get("url", "")), None) \
        or next((t for t in ts if t.get("type") == "page"), None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--frames", type=int, default=24)
    ap.add_argument("--interval", type=float, default=0.15)
    ap.add_argument("--out", default=r"E:\hsr-pet-extract\anim_capture")
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    page = get_page(a.port)
    if not page:
        print(f"❌ 连不上 CDP :{a.port}（需要 PET_CDP=1 启动）")
        return 2
    ws = page["webSocketDebuggerUrl"]

    stats = []
    for i in range(a.frames):
        r = eval_js(ws, CANVAS_EXPR)
        v = r.get("result", {}).get("result", {}).get("value")
        if not v:
            print(f"[anim] 第 {i} 帧读取失败: {json.dumps(r, ensure_ascii=False)[:200]}")
            continue
        d = json.loads(v)
        if not d.get("found") or not d.get("dataUrl"):
            print(f"[anim] 第 {i} 帧没有 canvas")
            continue
        p = os.path.join(a.out, f"frame_{i:03d}.png")
        with open(p, "wb") as f:
            f.write(base64.b64decode(d["dataUrl"].split(",", 1)[1]))
        stats.append({"i": i, "nonEmpty": d.get("nonEmpty"),
                      "bbox": d.get("bbox"), "size": [d.get("w"), d.get("h")]})
        if i % 4 == 0:
            print(f"[anim] {i:>3}  非空={d.get('nonEmpty')}  bbox={d.get('bbox')}")
        time.sleep(a.interval)

    # ── 判定：动画到底动没动 ──────────────────────────────────────
    sig = [json.dumps(s["bbox"]) for s in stats]
    uniq = len(set(sig))
    empties = [s["i"] for s in stats if not s["nonEmpty"]]
    print(f"\n[anim] 共 {len(stats)} 帧")
    print(f"[anim] 不同 bbox 数 = {uniq}  → {'✅ 在动' if uniq >= 3 else '❌ 几乎没变化'}")
    if empties:
        print(f"[anim] ❌ 空帧: {empties}")
    else:
        print("[anim] ✅ 无空帧")
    with open(os.path.join(a.out, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    return 0 if (uniq >= 3 and not empties) else 1


if __name__ == "__main__":
    sys.exit(main())