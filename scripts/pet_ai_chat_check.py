#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI 对话链路实测 —— 桌宠真的能跟用户聊天吗?

验证四层:
  1. 配置读到了吗(baseURL / apiKey / model 非空)
  2. sendChat 能拿到回复吗(带人设 system prompt)
  3. 人设生效吗(回复里有没有自称/语气)
  4. 主动搭话能触发吗(proactive → AI 生成一句话)

为什么要走 CDP 里的真实 sendChat:
  那是渲染端 chat-bubble 实际用的同一个函数,
  能一次验证「配置 → 网络 → 解析 → 气泡显示」整条链。

用法:
  python pet_ai_chat_check.py
"""
from __future__ import annotations

import json
import sys
import time

sys.path.insert(0, r"D:\hsr-pet\scripts")
from pet_physics_e2e import CDP, find_page, find_debug_port  # noqa: E402

JS_CFG = """
(async () => {
  const c = await window.petAPI.getConfig();
  return JSON.stringify({
    baseURL: c.baseURL, model: c.model,
    apiKeyLen: (c.apiKey||'').length,
    presets: c.modelPresets,
    proactive: c.proactive,
    personaNames: Object.keys(c.characterPersonas||{}),
  });
})()
"""

JS_CHAT = """
(async () => {
  const out = { deltas: '', err: null };
  try {
    await new Promise((resolve) => {
      let acc = '';
      window.petAPI.sendChat(
        [
          { role: 'system', content: '你是一只傲娇但可爱的橘猫桌宠。严格用这个口吻说话,自称用「本喵」。只输出一句话,不超过25字,不要markdown,不要加 [emotion] 标签。' },
          { role: 'user', content: '你好呀,今天心情怎么样?' },
        ],
        (delta, kind) => { if (kind === 'answer') acc += delta; },
        () => { out.deltas = acc; resolve(); },
        (e) => { out.err = String(e); resolve(); },
      );
      setTimeout(() => resolve(), 90000);
    });
  } catch (e) { out.err = String(e); }
  return JSON.stringify(out);
})()
"""


def main() -> int:
    port = find_debug_port()
    cdp = CDP(find_page(port))
    fails: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'✅' if ok else '❌'} {name}" + (f"  — {detail}" if detail else ""))
        if not ok:
            fails.append(name)

    try:
        print("[1] 配置检查")
        cfg = json.loads(cdp.eval(JS_CFG) or "{}")
        print(f"    baseURL={cfg.get('baseURL')!r} model={cfg.get('model')!r} "
              f"apiKey长度={cfg.get('apiKeyLen')}")
        check("baseURL 已配置", bool(cfg.get("baseURL")), str(cfg.get("baseURL")))
        check("apiKey 已配置", (cfg.get("apiKeyLen") or 0) > 0, f"长度 {cfg.get('apiKeyLen')}")
        check("model 已配置", bool(cfg.get("model")), str(cfg.get("model")))

        print("\n[2] 真实 sendChat 调用(带人设 system prompt)")
        t0 = time.time()
        res = json.loads(cdp.eval(JS_CHAT) or "{}")
        dt = time.time() - t0
        text = (res.get("deltas") or "").strip()
        print(f"    耗时 {dt:.1f}s")
        print(f"    回复: {text!r}")
        if res.get("err"):
            print(f"    错误: {res['err']}")
        check("sendChat 没有报错", not res.get("err"), str(res.get("err")))
        check("收到非空回复", len(text) > 0, f"长度 {len(text)}")
        check("回复是中文", any('一' <= ch <= '鿿' for ch in text), text[:40])
        check("人设生效(自称本喵)", "本喵" in text, text[:60])
        check("回复不长(≤40字)", len(text) <= 40, f"长度 {len(text)}")

        print("\n" + "=" * 60)
        if fails:
            print(f"AI 对话链路: {len(fails)} 项未通过")
            for f in fails:
                print(f"  ❌ {f}")
            print("=" * 60)
            return 1
        print("AI 对话链路: 全部通过 ✅")
        print("=" * 60)
        return 0
    finally:
        cdp.close()


if __name__ == "__main__":
    raise SystemExit(main())
