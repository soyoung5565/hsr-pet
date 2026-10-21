#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Q 弹动画诊断 —— 查为什么向上甩后 transform 停在半程。"""
from __future__ import annotations

import sys
import time

sys.path.insert(0, r"D:\hsr-pet\scripts")
from pet_physics_e2e import CDP, find_page, find_debug_port, JS_PET_STATE  # noqa: E402


def main() -> int:
    port = find_debug_port()
    cdp = CDP(find_page(port))
    try:
        # 1) 观察 rAF 是否在跑:连续采样 transform
        print("=== A. 采样 Q 弹期间的 transform 变化 ===")
        cdp.eval("""
          (() => {
            const el = document.querySelector('.character-host.hatch-pet-host');
            el.style.left = (window.innerWidth/2)+'px';
            el.style.top = (window.innerHeight/2)+'px';
            return true;
          })()
        """)
        time.sleep(0.2)
        st = cdp.eval(JS_PET_STATE)
        cdp.mouse("mousePressed", st['left'], st['top'])
        time.sleep(0.03)
        cdp.mouse("mouseReleased", st['left'], st['top'], buttons=0)

        for i in range(14):
            t = (cdp.eval(JS_PET_STATE) or {}).get("transform", "")
            print(f"  t+{i*50:>4}ms: {t!r}")
            time.sleep(0.05)

        # 2) 检查 document.visibilityState —— rAF 在隐藏窗口会被节流
        print("\n=== B. 页面可见性 / rAF 可用性 ===")
        info = cdp.eval("""
          (() => ({
            hidden: document.hidden,
            vis: document.visibilityState,
            hasFocus: document.hasFocus(),
          }))()
        """)
        print(f"  {info}")

        # 3) 在页面里手动跑一个 rAF 看是否被节流
        print("\n=== C. 手动 rAF 计时(看 200ms 实际花了多久) ===")
        r = cdp.eval("""
          new Promise((resolve) => {
            const t0 = performance.now();
            let frames = 0;
            const step = () => {
              frames++;
              if (performance.now() - t0 < 200) requestAnimationFrame(step);
              else resolve({ elapsed: performance.now() - t0, frames });
            };
            requestAnimationFrame(step);
          })
        """)
        print(f"  {r}")

        # 4) 向上甩后连续观察 transform 是否最终复位
        print("\n=== D. 向上甩 → 连续 2s 观察 transform ===")
        cdp.eval("""
          (() => {
            const el = document.querySelector('.character-host.hatch-pet-host');
            el.style.left = (window.innerWidth/2)+'px';
            el.style.top = (window.innerHeight/2)+'px';
            return true;
          })()
        """)
        time.sleep(0.2)
        st = cdp.eval(JS_PET_STATE)
        steps = 12
        cdp.mouse("mousePressed", st['left'], st['top'])
        for i in range(1, steps + 1):
            cdp.mouse("mouseMoved", st['left'], st['top'] - 320 * i / steps)
            time.sleep(0.008)
        cdp.mouse("mouseReleased", st['left'], st['top'] - 320, buttons=0)

        for i in range(20):
            s = cdp.eval(JS_PET_STATE) or {}
            print(f"  t+{i*100:>4}ms: top={s.get('top',0):.0f} transform={s.get('transform','')!r}")
            time.sleep(0.1)
        return 0
    finally:
        cdp.close()


if __name__ == "__main__":
    raise SystemExit(main())
