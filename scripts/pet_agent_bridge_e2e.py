#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Agent 联动链路真机实测 —— 桌宠能不能真的把活派给本机 coding agent?

验证五层(每层都要有真实输出,不能只验"有返回"):
  1. preload 暴露了 agentProbe / agentRun 接口
  2. agentProbe 探测到本机真实可用的 CLI(且理由诚实)
  3. agentRun 真跑一次外部 agent,拿到非空输出
  4. 输出里没有混入 stderr 噪声(实测踩坑:hermes 会打 MINIMAX_CN_API_KEY 提醒)
  5. agent:log 事件真的推送了(渲染端能显示实时进度)

为什么要走 CDP 里的真实 agentRun:
  那是渲染端调用外部 agent 的同一个函数,能一次验证
  「preload → IPC → 主进程 → spawn CLI → 回传」整条链。
  只跑 node 单测验不到 IPC 那一段。

用法:
  python pet_agent_bridge_e2e.py
"""
from __future__ import annotations

import json
import sys
import time

sys.path.insert(0, r"D:\hsr-pet\scripts")
from pet_physics_e2e import CDP, find_page, find_debug_port  # noqa: E402

# 探测 + 拿配置
JS_PROBE = """
(async () => {
  const out = { hasApi: false, err: null, probe: null, cfg: null };
  try {
    out.hasApi = !!(window.petAPI && window.petAPI.agentProbe && window.petAPI.agentRun);
    const cfg = await window.petAPI.getConfig();
    out.cfg = { agentBridge: cfg.agentBridge, model: cfg.model };
    out.probe = await window.petAPI.agentProbe();
  } catch (e) { out.err = String(e); }
  return JSON.stringify(out);
})()
"""

# 真跑一次外部 agent(短 prompt,快)
JS_RUN = """
(async () => {
  const out = { ok: false, backend: '', output: '', error: '', elapsedMs: 0, err: null };
  try {
    const r = await window.petAPI.agentRun({ prompt: '只输出三个字:收到了', timeoutSec: 120 });
    out.ok = r.ok; out.backend = r.backend; out.output = r.output;
    out.error = r.error; out.elapsedMs = r.elapsedMs;
  } catch (e) { out.err = String(e); }
  return JSON.stringify(out);
})()
"""

# 验证 agent:log 事件是否推送
JS_LOG_LISTEN = """
(async () => {
  const out = { got: false, lines: [], err: null };
  try {
    await new Promise((resolve) => {
      const off = window.petAPI.onAgentLog((p) => {
        out.got = true;
        out.lines.push((p && p.line) ? String(p.line) : JSON.stringify(p));
      });
      setTimeout(() => { try { off && off(); } catch (e) {} resolve(); }, 45000);
    });
  } catch (e) { out.err = String(e); }
  return JSON.stringify(out);
})()
"""


def main() -> int:
    port = find_debug_port()
    # timeout 要够大:agent 真跑一次要 20~60s,默认 20s 会假超时
    cdp = CDP(find_page(port), timeout=180.0)
    fails: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'✅' if ok else '❌'} {name}" + (f"  — {detail}" if detail else ""))
        if not ok:
            fails.append(name)

    print("")
    print("=== 1. 接口暴露 + 探测 ===")
    raw = cdp.eval(JS_PROBE)
    d = json.loads(raw)
    check("preload 暴露了 agentProbe / agentRun", bool(d.get("hasApi")))
    if d.get("err"):
        check("探测无异常", False, d["err"])

    probe = d.get("probe") or {}
    backends = probe.get("backends") or []
    check("探测返回了后端列表", len(backends) > 0, f"{len(backends)} 个")
    avail = [b for b in backends if b.get("available")]
    for b in backends:
        print(f"     {'✓' if b.get('available') else '✗'} {b.get('id'):14s} {b.get('reason')}")
    check("至少一个后端可用", len(avail) > 0, ", ".join(b.get("id", "?") for b in avail))
    check(
        "不可用后端给出了具体原因(不是空字符串)",
        all((b.get("reason") or "").strip() for b in backends),
    )

    cfg = d.get("cfg") or {}
    bridge = cfg.get("agentBridge")
    check(
        "配置里读到了 agentBridge(持久化生效)",
        isinstance(bridge, dict),
        json.dumps(bridge, ensure_ascii=False) if bridge else "读不到 —— loadConfig 丢了?",
    )
    if isinstance(bridge, dict):
        check("agentBridge.enabled 不为 undefined", bridge.get("enabled") is not None)

    print("")
    print("=== 2. 真跑一次外部 agent ===")
    raw = cdp.eval(JS_RUN)
    r = json.loads(raw)
    if r.get("err"):
        check("agentRun 无异常", False, r["err"])
    check("agentRun 返回 ok=true", bool(r.get("ok")), f"error={r.get('error')}")
    check("backend 有值", bool(r.get("backend")), str(r.get("backend")))
    outp = (r.get("output") or "").strip()
    check("输出非空", bool(outp), f"{len(outp)} 字")
    check("输出包含预期内容「收到了」", "收到了" in outp, repr(outp[:120]))

    print("")
    print("=== 3. stderr 噪声检查(实测踩坑点)===")
    noise_markers = ["is not set", "keeping the literal placeholder", "check ~/.hermes/.env"]
    for m in noise_markers:
        check(f"输出不含噪声「{m}」", m not in outp, repr(outp[:200]))

    print("")
    print("=== 4. agent:log 事件推送 ===")
    # 先挂监听,再触发一次运行,验证事件真的到了渲染端
    cdp.eval(
        """
        (() => { window.__agentLogs = [];
          window.__agentLogOff = window.petAPI.onAgentLog((p) => {
            window.__agentLogs.push(p && p.line ? String(p.line) : JSON.stringify(p));
          });
          return 'listening';
        })()
        """
    )
    cdp.eval(JS_RUN)
    logs = cdp.eval("JSON.stringify(window.__agentLogs || [])")
    lines = json.loads(logs or "[]")
    check("agent:log 事件被推送", len(lines) > 0, f"{len(lines)} 行")
    if lines:
        for ln in lines[:6]:
            print(f"     · {ln[:110]}")

    print("")
    if fails:
        print(f"❌ {len(fails)} 项失败:" + "、".join(fails))
        return 1
    print("✅ Agent 联动真机链路全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
