#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""连上正在跑的桌宠 Electron 渲染进程，查/切当前角色。

为什么要 CDP：桌宠窗口是全屏透明置顶（0,0,2048,1104），截图里它常常被
聊天窗口盖住或者只露一条边，靠看图判断「切没切成」既慢又不可靠。
直接问前端 `window.petAPI` 拿真实状态，是唯一准确的做法。

注意：Electron dev 模式要开 remote debugging。本脚本会先探测端口，
没开就提示加启动参数。

用法：
  python pet_probe.py                      # 列出所有角色 + 当前选中
  python pet_probe.py --switch 球棒狸# 切换角色
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.request


def find_debug_port(default=9222):
    """Electron 没开 remote debugging 时，从进程命令行里找 --inspect 端口。"""
    try:
        ps = (
            "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | "
            "Select-Object -ExpandProperty CommandLine"
        )
        r = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                           capture_output=True, text=True, timeout=30)
        m = re.search(r"--remote-debugging-port=(\d+)", r.stdout or "")
        if m:
            return int(m.group(1))
    except Exception:  # noqa: BLE001
        pass
    return default


def cdp_targets(port):
    url = f"http://127.0.0.1:{port}/json/list"
    with urllib.request.urlopen(url, timeout=8) as r:
        return json.loads(r.read().decode())


def eval_js(ws_url, expr):
    """最小 CDP 客户端：走 websocket 发 Runtime.evaluate。"""
    import base64
    import os
    import socket
    import struct

    # 用标准库实现最小 websocket 客户端，避免引第三方依赖
    m = re.match(r"ws://([^:/]+):(\d+)(/.*)", ws_url)
    host, port, path = m.group(1), int(m.group(2)), m.group(3)
    key = base64.b64encode(os.urandom(16)).decode()

    s = socket.create_connection((host, port), timeout=15)
    req = (f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
           f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
    s.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += s.recv(4096)

    payload = json.dumps({
        "id": 1, "method": "Runtime.evaluate",
        "params": {"expression": expr, "returnByValue": True,
                   "awaitPromise": True},
    }).encode()
    # 客户端帧必须带掩码
    mask = os.urandom(4)
    n = len(payload)
    if n < 126:
        hdr = struct.pack("!BB", 0x81, 0x80 | n)
    elif n < 65536:
        hdr = struct.pack("!BBH", 0x81, 0x80 | 126, n)
    else:
        hdr = struct.pack("!BBQ", 0x81, 0x80 | 127, n)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    s.sendall(hdr + mask + masked)

    # 读帧
    def readn(n):
        out = b""
        while len(out) < n:
            chunk = s.recv(n - len(out))
            if not chunk:
                raise ConnectionError("closed")
            out += chunk
        return out

    while True:
        b1, b2 = readn(2)
        ln = b2 & 0x7F
        if ln == 126:
            ln = struct.unpack("!H", readn(2))[0]
        elif ln == 127:
            ln = struct.unpack("!Q", readn(8))[0]
        data = readn(ln)
        try:
            msg = json.loads(data.decode())
        except Exception:  # noqa: BLE001
            continue
        if msg.get("id") == 1:
            s.close()
            return msg
    s.close()


LIST_EXPR = """
(async () => {
  const idx = await window.petAPI.scanCharacters();
  const cfg = await window.petAPI.getConfig();
  // 当前真正在渲染的精灵表 URL —— 直接看它指向谁，比看菜单高亮可靠
  const imgs = [...document.querySelectorAll('img,canvas')].map(e => ({
    tag: e.tagName, w: e.clientWidth, h: e.clientHeight,
    src: (e.getAttribute && e.getAttribute('src') || '').slice(0,200)
  }));
  const hosts = [...document.querySelectorAll('[class*="hatch"],[class*="pet-host"],[data-pet-id]')]
      .map(e => ({cls: String(e.className||'').slice(0,60), id: e.getAttribute('data-pet-id')}));
  return JSON.stringify({
    hatchPet: (idx && idx.hatchPet || []).map(c => ({id: c.id, name: c.name})),
    live2d: (idx && idx.live2d || []).map(c => ({id: c.id, name: c.name})),
    defaultCharacterId: cfg && cfg.defaultCharacterId,
    errors: idx && idx.errors,
    dom: imgs.slice(0, 10), hosts,
  });
})()
"""


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--switch", default="", help="要切换到的角色 id")
    p.add_argument("--port", type=int, default=0)
    a = p.parse_args()

    port = a.port or find_debug_port()
    try:
        ts = cdp_targets(port)
    except Exception as e:  # noqa: BLE001
        print(f"❌ 连不上 CDP :{port} ({e})")
        print("   需要用 --remote-debugging-port 启动 Electron，"
              "或给 npm run dev 加上该参数")
        return 2

    page = None
    for t in ts:
        if t.get("type") == "page" and "localhost:5173" in t.get("url", ""):
            page = t
            break
    if not page:
        for t in ts:
            if t.get("type") == "page":
                page = t
                break
    if not page:
        print(f"❌ 没找到渲染进程页面；现有 target：{[t.get('url') for t in ts]}")
        return 2

    print(f"[probe] 目标页 = {page.get('url')}")

    if a.switch:
        expr = (f"window.petAPI.switchCharacter({json.dumps(a.switch)})"
                f".then(r => JSON.stringify(r))")
        r = eval_js(page["webSocketDebuggerUrl"], expr)
        print("[probe] 切换结果:", json.dumps(r, ensure_ascii=False)[:400])
        time.sleep(2)

    r = eval_js(page["webSocketDebuggerUrl"], LIST_EXPR)
    res = r.get("result", {}).get("result", {}).get("value")
    if not res:
        print("[probe] 原始返回:", json.dumps(r, ensure_ascii=False)[:600])
        return 2
    d = json.loads(res)
    print("[probe] hatch-pet 角色:")
    for c in d["hatchPet"]:
        print(f"    - id={c['id']!r}  name={c['name']!r}")
    print(f"[probe] config.defaultCharacterId = {d['defaultCharacterId']!r}")
    if d.get("errors"):
        print(f"[probe] 扫描报错: {d['errors']}")
    if d.get("hosts"):
        print("[probe] 角色宿主节点:")
        for h in d["hosts"]:
            print(f"    - class={h['cls']!r} data-pet-id={h['id']!r}")
    print("[probe] 页面内图像元素:")
    for e in d["dom"]:
        print(f"    - {e['tag']} {e['w']}x{e['h']} {e['src'][:160]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())