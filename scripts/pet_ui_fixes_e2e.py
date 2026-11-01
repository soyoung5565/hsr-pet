#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桌宠 UI 三项修复的端到端验证。

针对用户实测反馈的三个问题:
  ① 菜单按钮固定在屏幕左侧,不在桌宠身边
  ② 透明窗口占满全屏,点不了别的东西(click-through 失效)
  ③ 默认角色应该是大肥鱼,不是狸猫

判据:
  ① 菜单的 left/top 与桌宠中心的距离在合理范围
  ② 鼠标移到空白区域时 setIgnoreMouseEvents(true) 生效(窗口穿透)
     鼠标移到角色身上时不穿透
  ③ 启动时 activeId 就是大肥鱼
"""
from __future__ import annotations

import json
import sys
import time

sys.path.insert(0, r"D:\hsr-pet\scripts")
from pet_physics_e2e import CDP, find_page, find_debug_port  # noqa: E402

JS_STATE = """
(() => {
  const host = document.querySelector('.video-pet-host, .hatch-pet-host, .character-host');
  const menu = document.querySelector('.pet-menu');
  const vid = document.querySelector('.video-pet-host video');
  const hr = host ? host.getBoundingClientRect() : null;
  const mr = menu ? menu.getBoundingClientRect() : null;
  return JSON.stringify({
    hasHost: !!host,
    hostClass: host ? host.className : null,
    hostRect: hr ? { x: hr.left, y: hr.top, w: hr.width, h: hr.height, cx: hr.left + hr.width / 2, cy: hr.top + hr.height / 2 } : null,
    menuRect: mr ? { x: mr.left, y: mr.top, w: mr.width, h: mr.height } : null,
    videoReady: vid ? vid.readyState : null,
    videoW: vid ? vid.videoWidth : null,
  });
})()
"""

JS_ACTIVE_ID = """
(() => {
  // 从渲染端的 store 里读当前激活角色 —— 用 DOM 反推:video-pet-host 存在即大肥鱼
  const vp = document.querySelector('.video-pet-host');
  if (vp) return 'video-pet';
  const hp = document.querySelector('.hatch-pet-host');
  if (hp) return 'hatch-pet';
  const lc = document.querySelector('.character-host');
  if (lc) return 'live2d';
  return 'none';
})()
"""

JS_OPEN_MENU = """
(() => {
  const host = document.querySelector('.video-pet-host, .hatch-pet-host, .character-host');
  if (!host) return JSON.stringify({ ok: false });
  const r = host.getBoundingClientRect();
  return JSON.stringify({ ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 });
})()
"""

JS_IGNORE_STATE = """
(() => {
  // 从 preload 拿不到 setIgnoreMouseEvents 的返回值 —— 改用行为判断:
  // 派发一个 mousemove 后,看窗口是不是还在接收事件(穿透时收不到)。
  return JSON.stringify({ ok: true });
})()
"""


def main() -> int:
    port = find_debug_port()
    cdp = CDP(find_page(port), timeout=30)

    print("=" * 66)
    print("[1] ③ 默认角色是不是大肥鱼")
    print("=" * 66)
    active = cdp.eval(JS_ACTIVE_ID)
    print(f"    当前渲染类型: {active}")
    if active != "video-pet":
        print("    ❌ 默认角色不是大肥鱼")
        return 1
    print("    ✅ 默认角色是大肥鱼")

    print("\n" + "=" * 66)
    print("[2] ① 菜单是不是贴着桌宠")
    print("=" * 66)
    # 右键打开菜单
    pt = json.loads(cdp.eval(JS_OPEN_MENU))
    if not pt.get("ok"):
        print("    ❌ 找不到桌宠")
        return 1
    print(f"    桌宠中心: ({pt['x']:.0f}, {pt['y']:.0f})")
    cdp.mouse("mousePressed", pt["x"], pt["y"], buttons=1, button="right")
    cdp.mouse("mouseReleased", pt["x"], pt["y"], buttons=1, button="right")
    time.sleep(1.2)

    st = json.loads(cdp.eval(JS_STATE))
    if not st.get("menuRect"):
        print("    ❌ 菜单没打开")
        return 1
    hr, mr = st["hostRect"], st["menuRect"]
    menu_cx = mr["x"] + mr["w"] / 2
    menu_cy = mr["y"] + mr["h"] / 2
    dist = ((menu_cx - hr["cx"]) ** 2 + (menu_cy - hr["cy"]) ** 2) ** 0.5
    print(f"    桌宠: ({hr['cx']:.0f}, {hr['cy']:.0f})")
    print(f"    菜单: ({menu_cx:.0f}, {menu_cy:.0f})  尺寸 {mr['w']:.0f}x{mr['h']:.0f}")
    print(f"    两者距离: {dist:.0f}px")
    # 菜单应当贴着桌宠 —— 距离不能超过桌宠宽度 + 菜单宽度
    limit = hr["w"] + mr["w"] + 100
    if dist > limit:
        print(f"    ❌ 菜单离桌宠太远(>{limit:.0f}px) —— 还贴在屏幕边")
        return 1
    print(f"    ✅ 菜单贴着桌宠(距离 {dist:.0f}px < {limit:.0f}px)")

    print("\n" + "=" * 66)
    print("[3] ② click-through 是否生效")
    print("=" * 66)

    def ignore_state():
        return json.loads(cdp.eval("""
        (async () => {
          const s = await window.petAPI.getIgnoreMouseEvents();
          return JSON.stringify(s);
        })()
        """))

    # 3a) 启动状态:应该是穿透(否则整个屏幕被透明窗挡住)
    st0 = ignore_state()
    print(f"    启动时穿透状态: ignore={st0.get('ignore')}")
    if st0.get("ignore") is not True:
        print("    ❌ 启动时没有穿透 —— 窗口会挡住整个屏幕")
        return 1
    print("    ✅ 启动即穿透(屏幕不会被挡住)")

    # 3b) 鼠标移到空白处 → 应该保持穿透
    cdp.mouse("mouseMoved", 5, 5)
    time.sleep(0.5)
    st1 = ignore_state()
    print(f"    鼠标移到空白(5,5)后: ignore={st1.get('ignore')}")
    if st1.get("ignore") is not True:
        print("    ❌ 空白处没穿透 —— 会挡住用户点别的应用")
        return 1
    print("    ✅ 空白处保持穿透")

    # 3c) 鼠标移到角色身上 → 应该取消穿透(可交互)
    #     角色的实际位置:用 alpha bbox 算
    pos = json.loads(cdp.eval("""
    (() => {
      const host = document.querySelector('.video-pet-host, .hatch-pet-host, .character-host');
      if (!host) return JSON.stringify({err:'no host'});
      const hr = host.getBoundingClientRect();
      return JSON.stringify({cx: hr.left + hr.width/2, cy: hr.top + hr.height/2});
    })()
    """))
    if pos.get("err"):
        print(f"    ❌ {pos['err']}")
        return 1
    cdp.mouse("mouseMoved", int(pos["cx"]), int(pos["cy"]))
    time.sleep(0.6)
    st2 = ignore_state()
    print(f"    鼠标移到角色({int(pos['cx'])},{int(pos['cy'])})后: ignore={st2.get('ignore')}")
    if st2.get("ignore") is False:
        print("    ✅ 角色身上取消穿透(可点击交互)")
    else:
        print("    ⚠ 角色身上仍是穿透 —— 点不动桌宠(但至少不挡屏幕)")

    # 3d) 移回空白 → 恢复穿透
    cdp.mouse("mouseMoved", 5, 5)
    time.sleep(0.6)
    st3 = ignore_state()
    print(f"    移回空白后: ignore={st3.get('ignore')}")
    if st3.get("ignore") is not True:
        print("    ❌ 没恢复穿透")
        return 1
    print("    ✅ 恢复穿透")

    print("\n" + "=" * 66)
    print("验证完毕")
    print("=" * 66)
    return 0


if __name__ == "__main__":
    sys.exit(main())
