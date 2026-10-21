#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""渲染风格端到端验证 —— 走**真实 UI 路径**。

验证三件事:
  1. 内置像素风「耄耋」切过去 → imageRendering 变成 'pixelated'(来自 pet.json 声明)
  2. 社区插画风桌宠 → 'auto'
  3. 用户在「大小」面板手动点「像素」→ 立刻生效 + 写进 localStorage
     切到别的角色再切回来 → 仍然记住用户的选择

用法:
  python pet_renderstyle_e2e.py
"""
from __future__ import annotations

import json
import sys
import time

sys.path.insert(0, r"D:\hsr-pet\scripts")
from pet_physics_e2e import CDP, find_page, find_debug_port  # noqa: E402

JS_STATE = """
(() => {
  const el = document.querySelector('.character-host.hatch-pet-host');
  if (!el) return null;
  const cv = el.querySelector('canvas');
  return JSON.stringify({
    imageRendering: getComputedStyle(cv).imageRendering,
    petId: el.getAttribute('data-pet-id'),
    petName: el.getAttribute('data-pet-name'),
    stored: localStorage.getItem('pet:render-style:' + el.getAttribute('data-pet-id')),
  });
})()
"""


def pick_pet(cdp, name: str) -> str:
    """走真实 UI:右键 → 切换 → 点角色。返回 'ok' 或错误描述。"""
    st = cdp.eval("""
      (() => {
        const el = document.querySelector('.character-host.hatch-pet-host');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2});
      })()
    """)
    if not st:
        return "找不到桌宠"
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
    r = cdp.eval(f"""
      (() => {{
        const items = [...document.querySelectorAll('.pet-menu-panel .char-item')];
        const t = items.find(x => (x.textContent||'').trim() === {json.dumps(name)});
        if (!t) return 'not-found';
        t.click();
        return 'ok';
      }})()
    """)
    if r != "ok":
        return f"点不到 {name}: {r}"
    time.sleep(1.6)
    return "ok"


def open_size_panel(cdp) -> None:
    """右键 → 点「大小」→ 打开大小面板。"""
    st = cdp.eval("""
      (() => {
        const el = document.querySelector('.character-host.hatch-pet-host');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2});
      })()
    """)
    if not st:
        return
    pos = json.loads(st)
    cdp.mouse("mousePressed", pos["x"], pos["y"], button="right", buttons=2)
    cdp.mouse("mouseReleased", pos["x"], pos["y"], button="right", buttons=0)
    time.sleep(0.3)
    cdp.eval("""
      (() => {
        const b = [...document.querySelectorAll('.pet-menu .menu-btn')]
          .find(x => (x.textContent||'').includes('大小'));
        if (b) b.click();
        return !!b;
      })()
    """)
    time.sleep(0.4)


def main() -> int:
    port = find_debug_port()
    cdp = CDP(find_page(port))
    fails: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'✅' if ok else '❌'} {name}" + (f"  — {detail}" if detail else ""))
        if not ok:
            fails.append(name)

    try:
        # 1) 像素风内置角色 → 应自动是 pixelated
        print("[1] 内置像素风「耄耋」→ 应为 pixelated(来自 pet.json 声明)")
        r = pick_pet(cdp, "耄耋")
        if r != "ok":
            check("切换到耄耋", False, r)
        else:
            s = json.loads(cdp.eval(JS_STATE) or "{}")
            print(f"    当前={s.get('petName')} rendering={s.get('imageRendering')!r} stored={s.get('stored')!r}")
            check("耄耋 用最近邻", s.get("imageRendering") == "pixelated", str(s.get("imageRendering")))

        # 2) 社区插画风 → 应是 auto
        print("\n[2] 社区插画风「角落生物猫咪」→ 应为 auto")
        r = pick_pet(cdp, "角落生物猫咪")
        if r != "ok":
            check("切换到角落生物猫咪", False, r)
        else:
            s = json.loads(cdp.eval(JS_STATE) or "{}")
            print(f"    当前={s.get('petName')} rendering={s.get('imageRendering')!r}")
            check("社区桌宠用双线性", s.get("imageRendering") == "auto", str(s.get("imageRendering")))

        # 3) 用户手动切「像素」→ 生效 + 持久化
        print("\n[3] 在「大小」面板手动点「像素」→ 应立即生效并持久化")
        open_size_panel(cdp)
        clicked = cdp.eval("""
          (() => {
            const btns = [...document.querySelectorAll('.pet-menu-panel .mini-btn')];
            const b = btns.find(x => (x.textContent||'').trim() === '像素');
            if (!b) return 'not-found:' + btns.map(x=>x.textContent.trim()).join('|');
            b.click();
            return 'ok';
          })()
        """)
        check("找到「像素」按钮", clicked == "ok", str(clicked))
        time.sleep(0.5)
        s = json.loads(cdp.eval(JS_STATE) or "{}")
        print(f"    rendering={s.get('imageRendering')!r} stored={s.get('stored')!r}")
        check("手动切换立即生效", s.get("imageRendering") == "pixelated", str(s.get("imageRendering")))
        check("已写入 localStorage", s.get("stored") == "pixelated", str(s.get("stored")))

        # 4) 切走再切回来 → 记住
        print("\n[4] 切到别的角色再切回来 → 应记住用户选择")
        pick_pet(cdp, "橘猫")
        pick_pet(cdp, "角落生物猫咪")
        s = json.loads(cdp.eval(JS_STATE) or "{}")
        print(f"    rendering={s.get('imageRendering')!r} stored={s.get('stored')!r}")
        check("切回后仍是 pixelated", s.get("imageRendering") == "pixelated", str(s.get("imageRendering")))

        # 5) 别的角色不受影响(各存各的)
        print("\n[5] 换个角色 → 它的风格独立")
        pick_pet(cdp, "橘猫")
        s = json.loads(cdp.eval(JS_STATE) or "{}")
        print(f"    橘猫 rendering={s.get('imageRendering')!r} stored={s.get('stored')!r}")
        check("橘猫不受影响(仍是 auto)", s.get("imageRendering") == "auto", str(s.get("imageRendering")))

        print("\n" + "=" * 60)
        if fails:
            print(f"渲染风格验证: {len(fails)} 项未通过")
            for f in fails:
                print(f"  ❌ {f}")
            print("=" * 60)
            return 1
        print("渲染风格验证: 全部通过 ✅")
        print("=" * 60)
        return 0
    finally:
        cdp.close()


if __name__ == "__main__":
    raise SystemExit(main())
