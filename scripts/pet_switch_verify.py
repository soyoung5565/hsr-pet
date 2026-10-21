#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真实 UI 切换验证 —— 抽样几只社区桌宠,确认能切过去、能渲染、动画在动。

与 pet_batch_check 的分工:
  batch_check 验「素材本身」(精灵表/帧数/内容唯一)
  本脚本验「在应用里真的能用」(切换成功 + 画面非空 + 动画在动)

动画在动的判据:连续两帧的 canvas 像素不同(且 bbox 在变)。
"""
from __future__ import annotations

import json
import sys
import time

sys.path.insert(0, r"D:\hsr-pet\scripts")
from pet_physics_e2e import CDP, find_page, find_debug_port  # noqa: E402

JS_PET_NAME = """
(() => {
  // 当前渲染的角色 id —— 渲染端在容器上打了 data-pet-id / data-pet-name
  const el = document.querySelector('.character-host.hatch-pet-host');
  if (!el) return null;
  return el.getAttribute('data-pet-name');
})()
"""

JS_CANVAS = """
(() => {
  const cv = document.querySelector('.character-host.hatch-pet-host canvas');
  if (!cv) return null;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let n = 0, minX=1e9,minY=1e9,maxX=-1,maxY=-1;
  for (let y=0;y<cv.height;y++) for (let x=0;x<cv.width;x++){
    if (d[(y*cv.width+x)*4+3] > 16){ n++;
      if(x<minX)minX=x; if(x>maxX)maxX=x;
      if(y<minY)minY=y; if(y>maxY)maxY=y; }
  }
  let h = 0;
  for (let i = 0; i < d.length; i += 41) h = (h*31 + d[i]) | 0;
  return JSON.stringify({ n, w: maxX-minX, h: maxY-minY, sig: h });
})()
"""


def main() -> int:
    targets = ["角落生物猫咪", "熊猫笋笋", "兔兔球球", "橘猫", "蒼羽兔兔", "球棒狸"]
    port = find_debug_port()
    cdp = CDP(find_page(port))
    fails: list[str] = []

    try:
        print(f"{'角色':<16} {'切换':<8} {'非透明像素':<10} {'bbox':<12} {'动画':<10} 状态")
        print("-" * 76)

        for name in targets:
            # 右键打开菜单 → 切换 → 点角色
            st = cdp.eval("""
              (() => {
                const el = document.querySelector('.character-host.hatch-pet-host');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2});
              })()
            """)
            if not st:
                print(f"{name[:14]:<16} {'—':<8} 找不到桌宠")
                fails.append(f"{name}: 找不到桌宠")
                continue
            pos = json.loads(st)
            cdp.mouse("mousePressed", pos["x"], pos["y"], button="right", buttons=2)
            cdp.mouse("mouseReleased", pos["x"], pos["y"], button="right", buttons=0)
            time.sleep(0.3)
            cdp.eval("""
              (() => {
                const b = [...document.querySelectorAll('.pet-menu .menu-btn')]
                  .find(x => (x.textContent||'').includes('切换'));
                if (b) b.click();
                return !!b;
              })()
            """)
            time.sleep(0.3)
            picked = cdp.eval(f"""
              (() => {{
                const items = [...document.querySelectorAll('.pet-menu-panel .char-item')];
                const t = items.find(x => (x.textContent||'').trim() === {json.dumps(name)});
                if (!t) return 'not-found';
                t.click();
                return 'ok';
              }})()
            """)
            if picked != "ok":
                print(f"{name[:14]:<16} {'❌':<8} 菜单里找不到")
                fails.append(f"{name}: 菜单里找不到")
                continue
            time.sleep(1.8)

            # 验证当前角色
            cur = cdp.eval(JS_PET_NAME)
            switched = (cur == name)

            # 画面
            a = json.loads(cdp.eval(JS_CANVAS) or "{}")
            time.sleep(0.35)
            b = json.loads(cdp.eval(JS_CANVAS) or "{}")
            anim = a.get("sig") != b.get("sig")

            issues = []
            if not switched:
                issues.append(f"切换失败(当前={cur})")
            if a.get("n", 0) < 100:
                issues.append("画面空白")
            if not anim:
                issues.append("动画未动")

            status = "✅ 正常" if not issues else "❌ " + "; ".join(issues)
            if issues:
                fails.append(f"{name}: {'; '.join(issues)}")
            print(f"{name[:14]:<16} {'✅' if switched else '❌':<8} "
                  f"{a.get('n',0):<10} {f'{a.get('w',0)}x{a.get('h',0)}':<12} "
                  f"{'✅ 在动' if anim else '❌ 不动':<10} {status}")

        print("\n" + "=" * 76)
        if fails:
            print(f"切换验证: {len(targets)-len(fails)}/{len(targets)} 通过")
            for f in fails:
                print(f"  ❌ {f}")
            print("=" * 76)
            return 1
        print(f"切换验证: 全部 {len(targets)} 只通过 ✅")
        print("=" * 76)
        return 0
    finally:
        cdp.close()


if __name__ == "__main__":
    raise SystemExit(main())
