#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 CDP 定位桌宠角色在屏幕上的坐标，并截取该区域存图。

为什么需要这个：桌宠窗口是全屏透明置顶（0,0,2048,1104），角色由前端
绝对定位在里面。想知道「它到底在哪、长什么样」，正路是问前端要元素坐标，
再按坐标裁剪截图 —— 而不是全屏截完靠肉眼扫（之前这么干过，角色常被
聊天窗口盖住或只露一条边，判读十有八九错）。

用法：python pet_shot.py [--out 路径] [--scale 2]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pet_probe import eval_js  # noqa: E402

# 取角色宿主的屏幕坐标 + 当前帧在精灵表里的位置
POS_EXPR = """
(() => {
  const el = document.querySelector('.hatch-pet-host')
            || document.querySelector('[class*="hatch-pet-host"]');
  if (!el) return JSON.stringify({found: false});
  const r = el.getBoundingClientRect();
  const c = el.querySelector('canvas');
  const cr = c ? c.getBoundingClientRect() : null;
  return JSON.stringify({
    found: true,
    host: {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)},
    canvas: cr ? {x: Math.round(cr.x), y: Math.round(cr.y),
                  w: Math.round(cr.width), h: Math.round(cr.height)} : null,
    dpr: window.devicePixelRatio,
  });
})()
"""

# ★ 直接读 canvas 像素。桌宠窗口是全屏透明置顶，桌面上任何别的窗口
# （聊天/浏览器）都会盖住它 —— 截屏验不到角色，vision 只会读到聊天内容。
# canvas.toDataURL 拿的是**渲染器自己画的内容**，与遮挡无关，这才是可信的验证。
CANVAS_EXPR = """
(() => {
  const c = document.querySelector('.hatch-pet-host canvas')
         || document.querySelector('canvas');
  if (!c) return JSON.stringify({found: false});
  try {
    const url = c.toDataURL('image/png');
    const ctx = c.getContext('2d');
    let nonEmpty = null, bbox = null;
    if (ctx) {
      try {
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] > 8) {
            n++;
            const p = i / 4, x = p % c.width, y = (p / c.width) | 0;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
        nonEmpty = n;
        if (n > 0) bbox = [x0, y0, x1, y1];
      } catch (e) { nonEmpty = 'getImageData blocked: ' + e.message; }
    }
    return JSON.stringify({found: true, w: c.width, h: c.height,
                           dataUrl: url, nonEmpty, bbox});
  } catch (e) {
    return JSON.stringify({found: true, error: String(e)});
  }
})()
"""


def capture(path, region=None, scale=1):
    """用 PowerShell + System.Drawing 截屏（region=(l,t,r,b)）。"""
    win, ht = 2048, 1152
    l, t, r, b = region if region else (0, 0, win, ht)
    # 路径里的反斜杠在 PowerShell 双引号字符串中会原样保留，OK。
    # 用正斜杠更保险（.NET Save 两种都收），避免转义地狱。
    win_path = path.replace("\\", "/")
    ps = f'''
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$full = New-Object System.Drawing.Bitmap({win},{ht})
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen(0,0,0,0,$full.Size)
$rect = New-Object System.Drawing.Rectangle({l},{t},{max(1, r - l)},{max(1, b - t)})
$crop = $full.Clone($rect, $full.PixelFormat)
$bmp = $crop
if ({scale} -ne 1) {{
  $bmp = New-Object System.Drawing.Bitmap([int]($crop.Width*{scale}), [int]($crop.Height*{scale}))
  $g2 = [System.Drawing.Graphics]::FromImage($bmp)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($crop, 0, 0, $bmp.Width, $bmp.Height)
  $g2.Dispose()
}}
$bmp.Save("{win_path}", [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("SAVED " + $bmp.Width + "x" + $bmp.Height)
'''
    # PowerShell 在 GBK 控制台下吐中文，text=True 用 utf-8 解会炸
    # （UnicodeDecodeError: 0xd3）。errors='replace' 兜住，避免整个脚本挂掉。
    r = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                       capture_output=True, text=True, timeout=120,
                       errors="replace")
    ok = "SAVED" in (r.stdout or "")
    if not ok:
        print(f"[shot] ❌ 截屏失败 rc={r.returncode}\n"
              f"  stdout={(r.stdout or '')[:300]}\n"
              f"  stderr={(r.stderr or '')[:500]}")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--out", default=r"E:\hsr-pet-extract\pet_shot.png")
    ap.add_argument("--scale", type=int, default=2)
    ap.add_argument("--pad", type=int, default=60, help="角色外扩多少像素再截")
    a = ap.parse_args()

    try:
        with urllib.request.urlopen(
                f"http://127.0.0.1:{a.port}/json/list", timeout=8) as r:
            ts = json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001
        print(f"❌ 连不上 CDP :{a.port} ({e})；需要 PET_CDP=1 启动")
        return 2

    page = next((t for t in ts if t.get("type") == "page"
                 and "5173" in t.get("url", "")), None) \
        or next((t for t in ts if t.get("type") == "page"), None)
    if not page:
        print("❌ 没找到渲染进程页面")
        return 2

    res = eval_js(page["webSocketDebuggerUrl"], POS_EXPR)
    val = res.get("result", {}).get("result", {}).get("value")
    if not val:
        print("❌ 取位置失败:", json.dumps(res, ensure_ascii=False)[:400])
        return 2
    d = json.loads(val)
    print("[shot] 位置", json.dumps(d, ensure_ascii=False))
    if not d.get("found"):
        print("❌ 页面上没有 .hatch-pet-host —— 角色可能没加载")
        return 1

    # ---- 首选：直接读 canvas 像素（不受任何窗口遮挡影响）----
    cres = eval_js(page["webSocketDebuggerUrl"], CANVAS_EXPR)
    cval = cres.get("result", {}).get("result", {}).get("value")
    if cval:
        cd = json.loads(cval)
        if cd.get("found") and cd.get("dataUrl"):
            import base64
            b64 = cd["dataUrl"].split(",", 1)[1]
            with open(a.out, "wb") as f:
                f.write(base64.b64decode(b64))
            print(f"[shot] ✅ canvas 像素已存 {a.out}")
            print(f"[shot] canvas {cd['w']}x{cd['h']}  "
                  f"非空像素={cd.get('nonEmpty')}  bbox={cd.get('bbox')}")
            return 0
        print(f"[shot] canvas 直读失败: {json.dumps(cd, ensure_ascii=False)[:200]}")

    # ---- 兜底：按坐标截屏（桌宠可能被别的窗口盖住）----
    box = d.get("canvas") or d["host"]
    l = max(0, box["x"] - a.pad)
    t = max(0, box["y"] - a.pad)
    r = min(2048, box["x"] + box["w"] + a.pad)
    b = min(1152, box["y"] + box["h"] + a.pad)
    print(f"[shot] 退回截屏，区域 ({l},{t})-({r},{b})")
    return 0 if capture(a.out, (l, t, r, b), a.scale) else 1


if __name__ == "__main__":
    sys.exit(main())