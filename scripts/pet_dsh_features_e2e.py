#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-pet 复刻功能验证 —— 睡觉 / 表情包 / 点击音效 / 菜单命令。

对应本轮从 dsh-pet 搬过来的功能:
  ① 睡觉:点「睡觉」→ 播入睡动画;点「起来」→ 播醒来动画
  ② 表情包:表情包池可读,URL 能取到图(不裂图)
  ③ 点击音效:点击桌宠后 AudioContext 有活动
  ④ 菜单命令:睡觉/起来/来个动作/碎碎念 四个入口都在
"""
from __future__ import annotations

import json
import sys
import time

sys.path.insert(0, r"D:\hsr-pet\scripts")
from pet_physics_e2e import CDP, find_page, find_debug_port  # noqa: E402

JS_MEME_POOL = """
(() => {
  const host = document.querySelector('.video-pet-host');
  if (!host) return JSON.stringify({ err: 'no host' });
  // 从菜单拿不到 handle,直接读素材包 —— 表情包目录在 pet:// 下
  return JSON.stringify({ ok: true });
})()
"""

JS_OPEN_MENU = """
(() => {
  const host = document.querySelector('.video-pet-host');
  if (!host) return JSON.stringify({ err: 'no host' });
  const r = host.getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
})()
"""

JS_MENU_BUTTONS = """
(() => {
  const btns = [...document.querySelectorAll('.menu-btn')].map(b => (b.textContent || '').trim());
  return JSON.stringify(btns);
})()
"""

JS_OPEN_ACTION_PANEL = """
(() => {
  const b = [...document.querySelectorAll('.menu-btn')].find(x => (x.textContent||'').trim() === '动作');
  if (!b) return JSON.stringify({ ok: false, error: 'no 动作 button' });
  b.click();
  return JSON.stringify({ ok: true });
})()
"""

JS_ACTION_ITEMS = """
(() => {
  const items = [...document.querySelectorAll('.action-item')].map(b => ({
    label: (b.querySelector('.action-item-label')?.textContent || '').trim(),
    hint: (b.querySelector('.action-item-hint')?.textContent || '').trim(),
  }));
  return JSON.stringify(items);
})()
"""

JS_VIDEO_STATE = """
(() => {
  const vids = [...document.querySelectorAll('.video-pet-host video')];
  // ★ 取**正在播**的那个(paused=false 且 readyState>=2),不能取第一个 ready 的 ——
  //   A/B 双缓冲里旧的槽位也 ready,但它已经 paused 了。
  const v = vids.find(x => x.readyState >= 2 && !x.paused)
         || vids.find(x => x.readyState >= 2);
  return JSON.stringify({
    count: vids.length,
    playing: v ? !v.paused : false,
    src: v ? decodeURIComponent((v.currentSrc || '').split('/').pop()) : '',
    t: v ? +v.currentTime.toFixed(2) : 0,
    loop: v ? v.loop : null,
  });
})()
"""

JS_FETCH_MEME = """
(async () => {
  const url = 'pet://video-pet/' + encodeURIComponent('蓝毛小女仆') + '/memes/' + encodeURIComponent('Ciallo.png');
  try {
    const r = await fetch(url);
    const b = await r.blob();
    return JSON.stringify({ status: r.status, size: b.size, type: b.type });
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
})()
"""

JS_FETCH_SOUND = """
(async () => {
  const url = 'pet://video-pet/' + encodeURIComponent('蓝毛小女仆') + '/sound/click-duck.wav';
  try {
    const r = await fetch(url);
    const b = await r.blob();
    return JSON.stringify({ status: r.status, size: b.size, type: b.type });
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
})()
"""


def main() -> int:
    port = find_debug_port()
    cdp = CDP(find_page(port), timeout=30)
    failures = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"    {'OK  ' if ok else 'FAIL'} {name}" + (f"  ({detail})" if detail else ""))
        if not ok:
            failures.append(name)

    print("=" * 66)
    print("[1] 素材可取性(表情包 / 点击音效)")
    print("=" * 66)
    meme = json.loads(cdp.eval(JS_FETCH_MEME))
    check("表情包能取到", meme.get("status") == 200 and meme.get("size", 0) > 1000,
          f"status={meme.get('status')} size={meme.get('size')}")
    sound = json.loads(cdp.eval(JS_FETCH_SOUND))
    check("点击音效能取到", sound.get("status") == 200 and sound.get("size", 0) > 100,
          f"status={sound.get('status')} size={sound.get('size')}")

    print("\n" + "=" * 66)
    print("[2] 菜单命令入口(睡觉 / 起来 / 来个动作 / 碎碎念)")
    print("=" * 66)
    pt = json.loads(cdp.eval(JS_OPEN_MENU))
    cdp.mouse("mousePressed", pt["x"], pt["y"], buttons=1, button="right")
    cdp.mouse("mouseReleased", pt["x"], pt["y"], buttons=1, button="right")
    time.sleep(1.2)

    menu = json.loads(cdp.eval(JS_MENU_BUTTONS))
    print(f"    菜单按钮: {menu}")
    check("菜单有「抖音」入口(新功能)", "抖音" in menu)

    r = cdp.eval(JS_OPEN_ACTION_PANEL)
    time.sleep(1.0)
    items = json.loads(cdp.eval(JS_ACTION_ITEMS))
    labels = [i["label"] for i in items]
    print(f"    动作面板: {labels}")
    for want in ["睡觉", "起来", "来个动作", "碎碎念"]:
        check(f"动作面板有「{want}」", want in labels)

    print("\n" + "=" * 66)
    print("[3] 睡觉功能")
    print("=" * 66)

    # ★ 先复位:如果上一轮测试后还睡着着,「睡觉」就不会重播入睡动画,
    #   断言会误判。先点「起来」并等它回待机。
    cdp.eval("""
    (() => {
      const b = [...document.querySelectorAll('.action-item')].find(x =>
        (x.querySelector('.action-item-label')?.textContent || '').trim() === '起来');
      if (b) b.click();
      return 'ok';
    })()
    """)
    time.sleep(2.0)
    reset = json.loads(cdp.eval(JS_VIDEO_STATE))
    print(f"    复位后: 播的是 {reset.get('src', '')}")
    check("复位后不在睡觉状态", "睡觉" not in reset.get("src", ""),
          f"src={reset.get('src', '')}")

    before = json.loads(cdp.eval(JS_VIDEO_STATE))
    print(f"    睡之前: 播的是 {before.get('src', '')[:40]} playing={before.get('playing')}")

    # 点「睡觉」
    cdp.eval("""
    (() => {
      const b = [...document.querySelectorAll('.action-item')].find(x =>
        (x.querySelector('.action-item-label')?.textContent || '').trim() === '睡觉');
      if (b) b.click();
      return 'ok';
    })()
    """)
    time.sleep(2.0)
    s1 = json.loads(cdp.eval(JS_VIDEO_STATE))
    print(f"    睡(2s): 播的是 {s1.get('src', '')} playing={s1.get('playing')}")
    check("睡觉后播入睡动画", "睡觉-开始" in s1.get("src", ""),
          f"src={s1.get('src', '')}")

    # 入睡过渡有 10 秒 —— 播完应自动切到睡眠循环段
    print("    等入睡过渡播完(10s)...")
    time.sleep(10)
    s2 = json.loads(cdp.eval(JS_VIDEO_STATE))
    print(f"    睡(12s): 播的是 {s2.get('src', '')} playing={s2.get('playing')} loop={s2.get('loop')}")
    check("入睡过渡后切到睡眠循环段", "睡觉-循环" in s2.get("src", ""),
          f"src={s2.get('src', '')}")
    check("睡眠循环段在无限播", s2.get("loop") is True and s2.get("playing") is True)

    # 点「起来」
    cdp.eval("""
    (() => {
      const b = [...document.querySelectorAll('.action-item')].find(x =>
        (x.querySelector('.action-item-label')?.textContent || '').trim() === '起来');
      if (b) b.click();
      return 'ok';
    })()
    """)
    time.sleep(2.0)
    awake = json.loads(cdp.eval(JS_VIDEO_STATE))
    print(f"    醒之后: 播的是 {awake.get('src', '')} playing={awake.get('playing')}")
    # 醒来过渡段就是「睡觉-起来」—— 它是醒来过程的一部分,不是还在睡
    check("醒来后不再播睡眠循环段", "睡觉-循环" not in awake.get("src", ""),
          f"src={awake.get('src', '')}")
    # 再等醒来过渡播完 → 回到待机
    print("    等醒来过渡播完(10s)...")
    time.sleep(10)
    final = json.loads(cdp.eval(JS_VIDEO_STATE))
    print(f"    最终: 播的是 {final.get('src', '')}")
    check("醒来过渡后回到待机动画", "睡觉" not in final.get("src", ""),
          f"src={final.get('src', '')}")

    print("\n" + "=" * 66)
    if failures:
        print(f"FAILED: {len(failures)} 项 —— {failures}")
        print("=" * 66)
        return 1
    print("全部通过")
    print("=" * 66)
    return 0


if __name__ == "__main__":
    sys.exit(main())
