#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""桌宠物理实测 —— CDP 连进真实渲染进程,用真实鼠标事件拖甩,读回运行时状态。

为什么必须这么测:
  桌宠窗口是全屏透明置顶,截屏会被别的窗口盖住(上次栽过)。
  CDP 的 Input.dispatchMouseEvent 走的是真实事件通路,
  能真正触发 mousedown/mousemove/mouseup 链路,读回的位置是物理算出来的真值。

为什么不用 websocket-client:
  Chrome DevTools 会校验 Origin 头,第三方库默认带 Origin → 403 Forbidden。
  必须手写最小 WebSocket 客户端且**不带 Origin 头**(同 pet_probe.py 的做法),
  或给 Electron 加 --remote-allow-origins(不想为测试改产品代码)。

用法:
  python pet_physics_e2e.py
  python pet_physics_e2e.py --swipe left
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import socket
import struct
import subprocess
import time
import urllib.request
from typing import Any

DEFAULT_PORT = 9222


def subprocess_run(cmd: list[str]) -> str:
    r = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=15)
    return (r.stdout or "") + (r.stderr or "")


def find_debug_port(default: int = DEFAULT_PORT) -> int:
    """从 electron 进程命令行里找 remote-debugging-port。"""
    try:
        out = subprocess_run(
            ["wmic", "process", "where", "name='electron.exe'", "get", "CommandLine"]
        )
        m = re.search(r"--remote-debugging-port=(\d+)", out)
        if m:
            return int(m.group(1))
    except Exception:
        pass
    return default


def http_json(url: str, timeout: float = 8.0) -> Any:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def find_page(port: int = DEFAULT_PORT) -> str:
    for _ in range(10):
        try:
            targets = http_json(f"http://127.0.0.1:{port}/json/list")
            pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
            if pages:
                for p in pages:
                    if "5173" in (p.get("url") or ""):
                        return p["webSocketDebuggerUrl"]
                return pages[0]["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError(f"找不到 CDP page target(端口 {port})")


class WS:
    """最小 WebSocket 客户端(标准库实现,不带 Origin 头)。"""

    def __init__(self, ws_url: str, timeout: float = 20.0):
        m = re.match(r"ws://([^:/]+):(\d+)(/.*)", ws_url)
        if not m:
            raise RuntimeError(f"无法解析 ws url: {ws_url}")
        host, port, path = m.group(1), int(m.group(2)), m.group(3)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s = socket.create_connection((host, port), timeout=timeout)
        req = (
            f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.s.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.s.recv(4096)
            if not chunk:
                raise ConnectionError("CDP 握手失败(连接被拒)")
            buf += chunk
        if b"403" in buf.split(b"\r\n", 1)[0]:
            raise ConnectionError("CDP 握手 403 —— 需不带 Origin 头,或加 --remote-allow-origins")

    def _readn(self, n: int) -> bytes:
        out = b""
        while len(out) < n:
            chunk = self.s.recv(n - len(out))
            if not chunk:
                raise ConnectionError("closed")
            out += chunk
        return out

    def send_frame(self, payload: bytes) -> None:
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            hdr = struct.pack("!BB", 0x81, 0x80 | n)
        elif n < 65536:
            hdr = struct.pack("!BBH", 0x81, 0x80 | 126, n)
        else:
            hdr = struct.pack("!BBQ", 0x81, 0x80 | 127, n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.s.sendall(hdr + mask + masked)

    def recv_frame(self) -> bytes:
        b1, b2 = self._readn(2)
        opcode = b1 & 0x0F
        ln = b2 & 0x7F
        if ln == 126:
            ln = struct.unpack("!H", self._readn(2))[0]
        elif ln == 127:
            ln = struct.unpack("!Q", self._readn(8))[0]
        data = self._readn(ln)
        if opcode == 0x9:  # ping → 回 pong
            self.s.sendall(struct.pack("!BB", 0x8A, 0x80 | len(data)))
            return self.recv_frame()
        return data

    def close(self) -> None:
        try:
            self.s.close()
        except Exception:
            pass


class CDP:
    def __init__(self, ws_url: str, timeout: float = 20.0):
        # ★ timeout 必须可调:AI 对话类调用要等几十秒,
        #   固定 20s 会让 90s 的 await 必然超时(看着像产品挂了,其实是测试工具限制)。
        self.ws = WS(ws_url, timeout=timeout)
        self._id = 0

    def send(self, method: str, params: dict | None = None) -> dict:
        self._id += 1
        msg_id = self._id
        self.ws.send_frame(
            json.dumps({"id": msg_id, "method": method, "params": params or {}}).encode()
        )
        while True:
            raw = self.ws.recv_frame()
            try:
                data = json.loads(raw.decode("utf-8", "replace"))
            except Exception:
                continue
            if data.get("id") == msg_id:
                if "error" in data:
                    raise RuntimeError(f"{method} 失败: {data['error']}")
                return data.get("result", {})

    def eval(self, expr: str) -> Any:
        r = self.send(
            "Runtime.evaluate",
            {"expression": expr, "returnByValue": True, "awaitPromise": True},
        )
        if r.get("exceptionDetails"):
            raise RuntimeError(f"JS 异常: {r['exceptionDetails'].get('text')}")
        return r.get("result", {}).get("value")

    def mouse(self, typ: str, x: float, y: float, buttons: int = 1, button: str = "left") -> None:
        self.send(
            "Input.dispatchMouseEvent",
            {
                "type": typ,
                "x": x,
                "y": y,
                "button": button,
                "buttons": buttons,
                "clickCount": 1,
            },
        )

    def close(self) -> None:
        self.ws.close()


JS_PET_STATE = """
(() => {
  const el = document.querySelector('.character-host.hatch-pet-host');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    left: parseFloat(el.style.left) || 0,
    top: parseFloat(el.style.top) || 0,
    rectLeft: r.left, rectTop: r.top,
    w: r.width, h: r.height,
    transform: el.style.transform || '',
    winW: window.innerWidth, winH: window.innerHeight,
  };
})()
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--swipe", default="right", choices=["right", "left", "up"])
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()

    port = args.port or find_debug_port()
    cdp = CDP(find_page(port))
    fails: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        mark = "✅" if ok else "❌"
        print(f"  {mark} {name}" + (f"  — {detail}" if detail else ""))
        if not ok:
            fails.append(name)

    try:
        st = cdp.eval(JS_PET_STATE)
        if not st:
            print("✗ 页面上找不到桌宠容器")
            return 1
        print(f"[1] 桌宠在位: left={st['left']:.0f} top={st['top']:.0f} "
              f"尺寸={st['w']:.0f}x{st['h']:.0f} 窗口={st['winW']}x{st['winH']}\n")

        # ---------- 归位:把桌宠放回屏幕中央,避免上一轮甩到边界外影响本轮 ----------
        cdp.eval("""
          (() => {
            const el = document.querySelector('.character-host.hatch-pet-host');
            if (!el) return false;
            el.style.left = (window.innerWidth / 2) + 'px';
            el.style.top = (window.innerHeight / 2) + 'px';
            return true;
          })()
        """)
        time.sleep(0.2)

        # ---------- 纯点击 → Q 弹 ----------
        print("[2] 纯点击 → Q 弹回应 + 开心动作")
        st = cdp.eval(JS_PET_STATE)
        cdp.mouse("mousePressed", st['left'], st['top'])
        time.sleep(0.03)
        cdp.mouse("mouseReleased", st['left'], st['top'], buttons=0)
        time.sleep(0.07)
        tf = (cdp.eval(JS_PET_STATE) or {}).get("transform", "")
        check("点击后出现 scale 挤压", "scale" in tf, f"transform={tf!r}")
        time.sleep(0.45)

        # ---------- 快速拖甩 → 抛掷 ----------
        print("\n[3] 快速拖甩 → 抛掷飞行")
        before = cdp.eval(JS_PET_STATE)
        steps = 12
        dx = {"right": 400, "left": -400, "up": 0}[args.swipe]
        dy = {"right": 0, "left": 0, "up": -320}[args.swipe]
        cdp.mouse("mousePressed", before['left'], before['top'])
        for i in range(1, steps + 1):
            cdp.mouse(
                "mouseMoved",
                before['left'] + dx * i / steps,
                before['top'] + dy * i / steps,
            )
            time.sleep(0.008)
        cdp.mouse("mouseReleased", before['left'] + dx, before['top'] + dy, buttons=0)

        time.sleep(0.09)
        mid = cdp.eval(JS_PET_STATE)

        # 等桌宠完全静止(落地不再变化)再断言 ——
        # 固定 sleep 会撞上弹跳中途,读到中间态而不是终态。
        after = mid
        stable = 0
        for _ in range(40):  # 最多等 4s
            time.sleep(0.1)
            cur = cdp.eval(JS_PET_STATE)
            moved = abs(cur['left'] - after['left']) + abs(cur['top'] - after['top'])
            after = cur
            if moved < 1.0:
                stable += 1
                if stable >= 3:
                    break
            else:
                stable = 0

        moved_mid = abs(mid['left'] - before['left']) + abs(mid['top'] - before['top'])
        moved_end = abs(after['left'] - before['left']) + abs(after['top'] - before['top'])
        print(f"    起点   left={before['left']:.0f} top={before['top']:.0f}")
        print(f"    飞行中 left={mid['left']:.0f} top={mid['top']:.0f}  位移 {moved_mid:.0f}px")
        print(f"    落地后 left={after['left']:.0f} top={after['top']:.0f}  位移 {moved_end:.0f}px")
        check("拖甩后宠物被甩出(飞行中有位移)", moved_mid > 20, f"{moved_mid:.0f}px")
        check("落地后位置与起点不同", moved_end > 20, f"{moved_end:.0f}px")

        # ---------- 落地贴地 ----------
        print("\n[4] 落地位置检查")
        # ⚠ posRef 存的是「中心点」(容器带 translate(-50%,-50%)),
        #   所以中心点贴地时 y = winH - h/2,不是 winH - h。
        ground_center = after['winH'] - after['h'] / 2
        print(f"    贴地时中心 y = {ground_center:.0f} | 实际中心 top = {after['top']:.0f} "
              f"| 差 = {after['top'] - ground_center:.0f}px")
        check("落地后贴地(±40px)", abs(after['top'] - ground_center) < 40,
              f"差 {after['top'] - ground_center:.0f}px")
        # 底边不应超出窗口
        bottom = after['top'] + after['h'] / 2
        check("桌宠底边不超出窗口", bottom <= after['winH'] + 2,
              f"底边={bottom:.0f} 窗口高={after['winH']}")

        # ---------- 位置持久化 ----------
        print("\n[5] 位置持久化")
        persisted = cdp.eval(
            "Object.keys(localStorage).filter(k => k.startsWith('pet:position:'))"
            ".map(k => k + ' = ' + localStorage.getItem(k))"
        )
        for line in (persisted or []):
            print(f"    {line}")
        check("位置已写入 localStorage", bool(persisted), f"{len(persisted or [])} 条")

        # ---------- Q 弹是否复位 ----------
        print("\n[6] Q 弹 transform 复位")
        tf2 = (cdp.eval(JS_PET_STATE) or {}).get("transform", "")
        print(f"    transform = {tf2!r}")
        check("动画结束后 transform 已复位", "scale" not in tf2, f"{tf2!r}")

        print("\n" + "=" * 56)
        if fails:
            print(f"物理端到端实测: {len(fails)} 项未通过")
            for f in fails:
                print(f"  ❌ {f}")
            print("=" * 56)
            return 1
        print("物理端到端实测: 全部通过 ✅")
        print("=" * 56)
        return 0
    finally:
        cdp.close()


if __name__ == "__main__":
    raise SystemExit(main())
