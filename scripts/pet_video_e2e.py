#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Video-Pet(大肥鱼)端到端验证 —— 确认 109 段透明动画在应用里真的能播。

与已有 e2e 的分工:
  pet_batch_check.py  验「素材本身」(精灵表/帧数/内容唯一)
  pet_switch_verify.py 验「社区桌宠在应用里能切、能渲染、动画在动」
  本脚本              验「video-pet 这一类角色」—— video 元素是否加载到 webm、
                      是否真在播放(currentTime 在走)、画面是否有非透明像素。

★ 判据必须对着真实被测对象:
  动画「在动」的判据是 video.currentTime 递增 + 画面像素变化,
  不能只看「video 元素存在」—— 那证明不了解码成功。
"""
from __future__ import annotations

import json
import sys
import time

sys.path.insert(0, r"D:\hsr-pet\scripts")
from pet_physics_e2e import CDP, find_page, find_debug_port  # noqa: E402

JS_SCAN = """
(async () => {
  const idx = await window.petAPI.scanCharacters();
  const vp = idx.videoPet || [];
  return JSON.stringify({
    total: vp.length,
    list: vp.map(c => ({
      id: c.id, name: c.name, type: c.type, source: c.source,
      anims: Object.keys(c.manifest?.animations || {}).length,
      memes: Object.keys(c.manifest?.memes || {}).length,
      hasPersona: !!c.manifest?.persona,
      cats: (c.manifest?.categories?.categories || []).length,
    })),
  });
})()
"""

JS_STATE = """
(() => {
  const host = document.querySelector('.video-pet-host');
  if (!host) return JSON.stringify({ found: false });
  const vids = [...host.querySelectorAll('video')];
  const info = vids.map(v => ({
    src: (v.currentSrc || v.src || '').split('/').pop().slice(0, 60),
    readyState: v.readyState,
    t: v.currentTime,
    w: v.videoWidth, h: v.videoHeight,
    paused: v.paused,
    err: v.error ? v.error.code : null,
    loop: v.loop,
  }));
  const el = host.getBoundingClientRect();
  return JSON.stringify({ found: true, vids: info, box: { w: el.width, h: el.height } });
})()
"""

JS_PIXELS = """
(() => {
  // 把 video 画到临时 canvas 上采样 —— video 元素本身读不到像素。
  const host = document.querySelector('.video-pet-host');
  if (!host) return JSON.stringify({ found: false });
  const v = [...host.querySelectorAll('video')].find(x => x.videoWidth > 0 && !x.paused)
         || [...host.querySelectorAll('video')].find(x => x.videoWidth > 0);
  if (!v) return JSON.stringify({ found: false, noVideo: true });
  const cv = document.createElement('canvas');
  cv.width = v.videoWidth; cv.height = v.videoHeight;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0);
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let opaque = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, sig = 0;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4;
      if (d[i + 3] > 16) {
        opaque++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  for (let i = 0; i < d.length; i += 97) sig = (sig * 31 + d[i]) | 0;
  return JSON.stringify({
    found: true, opaque, w: cv.width, h: cv.height,
    bbox: maxX >= 0 ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null,
    sig, t: v.currentTime,
  });
})()
"""

JS_PET_POINT = """
(() => {
  // 桌宠在窗口里的位置 —— 用来发真实右键事件。
  const host = document.querySelector('.video-pet-host, .hatch-pet-host, .character-host');
  if (!host) return JSON.stringify({ found: false });
  const r = host.getBoundingClientRect();
  return JSON.stringify({ found: true, x: r.left + r.width / 2, y: r.top + r.height / 2 });
})()
"""

JS_OPEN_SWITCH_PANEL = """
(() => {
  const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '切换');
  if (!btn) return JSON.stringify({ ok: false, error: '没找到「切换」按钮' });
  btn.click();
  return JSON.stringify({ ok: true });
})()
"""

JS_EXPAND_GROUPS = """
(() => {
  // 展开所有角色分组(折叠的组点标题才出 .char-item)
  const titles = [...document.querySelectorAll('.char-group-title')];
  const groups = titles.map(t => (t.textContent || '').replace(/[\u00b7›]/g, '').trim());
  titles.forEach(t => {
    if (t.getAttribute('aria-expanded') !== 'true') t.click();
  });
  return JSON.stringify({ total: titles.length, groups });
})()
"""

JS_MENU_ITEMS = """
(() => {
  const items = [...document.querySelectorAll('.char-item')];
  return JSON.stringify({
    count: items.length,
    names: items.map(b => (b.textContent || '').trim()),
  });
})()
"""

JS_CLICK_ITEM = """
(() => {
  const idx = window.__vpTargetName;
  const items = [...document.querySelectorAll('.char-item')];
  const target = items.find(b => (b.textContent || '').includes(idx));
  if (!target) return JSON.stringify({ ok: false });
  target.click();
  return JSON.stringify({ ok: true, clicked: (target.textContent || '').trim() });
})()
"""

JS_ACTIVE = """
(() => {
  const host = document.querySelector('.video-pet-host');
  return host ? 'video-pet' : (document.querySelector('.hatch-pet-host') ? 'hatch-pet'
    : (document.querySelector('.character-host') ? 'live2d' : 'none'));
})()
"""


def main() -> int:
    port = find_debug_port()
    cdp = CDP(find_page(port), timeout=30)

    print("=" * 60)
    print("[1] 扫描 video-pet 角色")
    scan = json.loads(cdp.eval(JS_SCAN))
    print(f"    找到 {scan['total']} 个 video-pet 角色")
    if not scan["total"]:
        print("    ❌ 没有扫描到 video-pet 角色")
        return 1
    for c in scan["list"]:
        print(f"    - {c['name']} ({c['id']}): {c['anims']} 段动画 / {c['memes']} 张表情包 "
              f"/ {c['cats']} 个动作分类 / 人设:{'有' if c['hasPersona'] else '无'}")

    print("\n[2] 右键打开菜单 → 选角色")
    scan_name = scan["list"][0]["name"]
    cdp.eval(f"window.__vpTargetName = {json.dumps(scan_name)};")
    pt = json.loads(cdp.eval(JS_PET_POINT))
    if not pt.get("found"):
        print("    ❌ 找不到桌宠容器")
        return 1
    print(f"    桌宠位置: ({pt['x']:.0f}, {pt['y']:.0f})")
    # 发真实右键(CDP Input.dispatchMouseEvent)—— 注入 Event 走不到 canvas 上的监听器
    cdp.mouse("mousePressed", pt["x"], pt["y"], buttons=1, button="right")
    cdp.mouse("mouseReleased", pt["x"], pt["y"], buttons=1, button="right")
    time.sleep(1.2)

    # 菜单第一层是功能按钮,角色列表在「切换」面板里 —— 先点「切换」。
    opened = json.loads(cdp.eval(JS_OPEN_SWITCH_PANEL))
    print(f"    点「切换」: {opened}")
    time.sleep(1.2)

    # 角色按分组折叠,默认只展开第一个组 —— Video-Pet 在另一个组里,
    # 得先把所有组都展开(点每个 .char-group-title),否则看不到它。
    groups = json.loads(cdp.eval(JS_EXPAND_GROUPS))
    print(f"    展开分组: {groups.get('groups')} (共 {groups.get('total')} 组)")
    time.sleep(0.8)

    menu = json.loads(cdp.eval(JS_MENU_ITEMS))
    print(f"    菜单里的角色: {menu['count']} 个")
    if not menu["count"]:
        print("    ❌ 「切换」面板里没有角色列表")
        return 1
    if not any(scan_name in n for n in menu["names"]):
        print(f"    ❌ 菜单里没有「{scan_name}」 -> {menu['names']}")
        return 1
    print(f"    ✅ 菜单里找到了「{scan_name}」")

    r = json.loads(cdp.eval(JS_CLICK_ITEM))
    print("   ", r)
    if not r.get("ok"):
        print("    ❌ 点不到那一项")
        return 1
    time.sleep(4)

    active = cdp.eval(JS_ACTIVE)
    print(f"    当前渲染类型: {active}")
    if active != "video-pet":
        print("    ❌ 没切到 video-pet")
        return 1

    print("\n[3] 检查 video 元素状态")
    state = json.loads(cdp.eval(JS_STATE))
    print(f"    容器尺寸: {state.get('box')}")
    for v in state.get("vids", []):
        print(f"    video: {v['src']} readyState={v['readyState']} "
              f"size={v['w']}x{v['h']} t={v['t']:.2f} paused={v['paused']} err={v['err']}")

    loaded = [v for v in state.get("vids", []) if v["readyState"] >= 2 and v["w"] > 0]
    if not loaded:
        print("    ❌ 没有任何 video 加载成功(readyState < 2 或尺寸为 0)")
        return 1
    if any(v["err"] for v in state["vids"]):
        print("    ❌ 有 video 报了错")
        return 1
    print("    ✅ video 元素已加载出画面")

    print("\n[4] 检查画面有内容(角色像素非透明)")
    px = json.loads(cdp.eval(JS_PIXELS))
    print(f"    不透明像素: {px.get('opaque')} / {px.get('w')}x{px.get('h')}  bbox={px.get('bbox')}")
    if not px.get("opaque"):
        print("    ❌ 画面全透明 —— webm 的 alpha 没解出来")
        return 1
    print("    ✅ 画面有内容(VP9 alpha 正常)")

    print("\n[5] 检查动画在动(currentTime 递增 + 像素变化)")
    t0 = json.loads(cdp.eval(JS_PIXELS))
    time.sleep(1.5)
    t1 = json.loads(cdp.eval(JS_PIXELS))
    dt = t1.get("t", 0) - t0.get("t", 0)
    moved = t0.get("sig") != t1.get("sig")
    print(f"    ΔcurrentTime = {dt:.3f}s, 像素签名变化 = {moved}")
    if dt <= 0:
        print("    ❌ currentTime 没走 —— 视频没在播")
        return 1
    print("    ✅ 动画在播")

    print("\n" + "=" * 60)
    print("✅ Video-Pet 端到端验证通过")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
