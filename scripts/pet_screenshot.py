#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓桌宠运行截图 —— 直读 canvas 像素(不受全屏透明窗口被遮挡影响)。

为什么不用系统截屏:桌宠窗口是全屏透明置顶,桌面上任何别的窗口都会盖住它,
截屏只会拍到聊天窗口(上次栽过)。

用法:
  python pet_screenshot.py                    # 当前角色
  python pet_screenshot.py --pet 角落生物猫咪
  python pet_screenshot.py --all              # 每只都抓一张
  python pet_screenshot.py --zoom 2          # 放大 2 倍看插值效果
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, r"D:\hsr-pet\scripts")
from pet_physics_e2e import CDP, find_page, find_debug_port  # noqa: E402

JS_PET = """
(() => {
  const el = document.querySelector('.character-host.hatch-pet-host');
  if (!el) return null;
  return JSON.stringify({ id: el.getAttribute('data-pet-id'), name: el.getAttribute('data-pet-name') });
})()
"""

JS_LIST = """
(async () => {
  const idx = await window.petAPI.scanCharacters();
  return JSON.stringify((idx.hatchPet || []).map(c => ({id:c.id, name:c.name})));
})()
"""

# 抓当前 canvas 的像素,放大 zoom 倍(最近邻,保持像素)
JS_CAPTURE = """
(zoom) => {
  const cv = document.querySelector('.character-host.hatch-pet-host canvas');
  if (!cv) return null;
  const off = document.createElement('canvas');
  off.width = cv.width * zoom; off.height = cv.height * zoom;
  const octx = off.getContext('2d');
  octx.imageSmoothingEnabled = false;
  octx.drawImage(cv, 0, 0, off.width, off.height);
  return off.toDataURL('image/png');
}
"""


def pick_pet(cdp, name: str) -> bool:
    st = cdp.eval("""
      (() => {
        const el = document.querySelector('.character-host.hatch-pet-host');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2});
      })()
    """)
    if not st:
        return False
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
    time.sleep(1.5)
    return r == "ok"


def save(data_url: str, path: Path) -> None:
    b64 = data_url.split(",", 1)[1]
    path.write_bytes(base64.b64decode(b64))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pet", help="角色名")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--zoom", type=int, default=1)
    ap.add_argument("--out", default=r"D:\hsr-pet\dl\shots")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    port = find_debug_port()
    cdp = CDP(find_page(port))
    try:
        if args.all:
            names = [p["name"] for p in json.loads(cdp.eval(JS_LIST) or "[]")]
        elif args.pet:
            names = [args.pet]
        else:
            names = []

        if not names:
            p = json.loads(cdp.eval(JS_PET) or "{}")
            names = [p.get("name", "pet")]
            print(f"当前角色: {names[0]}")

        for name in names:
            if args.all or args.pet:
                if not pick_pet(cdp, name):
                    print(f"  切不到 {name},跳过")
                    continue
            time.sleep(0.6)
            url = cdp.eval(f"({JS_CAPTURE})({args.zoom})")
            if not url:
                print(f"  {name}: 抓不到 canvas")
                continue
            safe = name.replace("/", "_").replace("\\", "_")
            f = out / f"{safe}{'_x' + str(args.zoom) if args.zoom > 1 else ''}.png"
            save(url, f)
            print(f"  ✅ {name} → {f} ({f.stat().st_size // 1024}KB)")
        return 0
    finally:
        cdp.close()


if __name__ == "__main__":
    raise SystemExit(main())
