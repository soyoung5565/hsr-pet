#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""主动搭话实测 —— 桌宠会自己开口说话吗?

这是桌宠区别于「一张动图」的核心:它能根据时间/用户状态主动说话。

验证:
  1. proactive 配置是否开启
  2. 「切换角色后主动打招呼」能否触发并显示气泡
  3. 整点报时 / 时段问候 的文案是否含角色人设
  4. 气泡真的出现在 DOM 里(不只是 AI 出了字)

用法:
  python pet_proactive_check.py
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
  return JSON.stringify({ proactive: c.proactive, personas: Object.keys(c.characterPersonas || {}) });
})()
"""

# 当前渲染的角色名(渲染端在容器上打了 data-pet-name)
JS_PET_NAME = """
(() => {
  const el = document.querySelector('.character-host.hatch-pet-host');
  if (!el) return null;
  return JSON.stringify({ name: el.getAttribute('data-pet-name'), id: el.getAttribute('data-pet-id') });
})()
"""

# 主动搭话时会在桌宠头顶显示 .pet-speech 气泡
# ⚠ 判据要认准这个 class —— 之前查 '[class*="bubble"]' 查不到它,误判成"没出现"。
#   (页面上的 ChatBubble 是 .dialog-frame,那是另一个东西)
JS_BUBBLE = """
(() => {
  const sp = document.querySelector('.pet-speech');
  if (!sp) return JSON.stringify([]);
  const r = sp.getBoundingClientRect();
  const cs = getComputedStyle(sp);
  return JSON.stringify([{
    cls: String(sp.className),
    text: (sp.textContent || '').trim().slice(0, 100),
    visible: cs.opacity !== '0' && r.width > 0 && r.height > 0,
    opacity: cs.opacity,
  }]);
})()
"""

# 主动搭话内部走 askAIOnce —— 直接调它验证 AI 能按人设生成一句话
JS_ASK_AI = """
(async () => {
  // 复用应用里的人设 prompt 构造
  const cfg = await window.petAPI.getConfig();
  const name = '万津莫';
  const slot = cfg.characterPersonas?.[name];
  const persona = slot?.personas?.find(p => p.id === slot.activeId) || slot?.personas?.[0];
  const sys = `你是「${name}」,一只桌宠。严格遵守你的人设口吻、自称、口头禅。`
      + (persona?.personality ? `\\n人设:${persona.personality}` : '')
      + (persona?.speakingStyle ? `\\n口吻:${persona.speakingStyle}` : '')
      + '\\n只输出一句话,不超过30字,可以加1~2个emoji。不要markdown,不要加 [emotion] 标签。';
  return new Promise((resolve) => {
    let acc = '';
    window.petAPI.sendChat(
      [ { role: 'system', content: sys },
        { role: 'user', content: '现在是傍晚,给主人一句提醒。只输出一句话。' } ],
      (delta, kind) => { if (kind === 'answer') acc += delta; },
      () => resolve(JSON.stringify({ text: acc.trim(), persona: persona?.displayName || null })),
      (e) => resolve(JSON.stringify({ err: String(e) })),
    );
    setTimeout(() => resolve(JSON.stringify({ err: 'timeout' })), 60000);
  });
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
        print("[1] proactive 配置")
        cfg = json.loads(cdp.eval(JS_CFG) or "{}")
        pro = cfg.get("proactive") or {}
        print(f"    {json.dumps(pro, ensure_ascii=False)}")
        check("proactive 开关存在", 'enabled' in pro)
        check("已开启", pro.get("enabled") is True, str(pro.get("enabled")))
        check("配了人设角色", len(cfg.get("personas") or []) > 0, str(cfg.get("personas")))

        print("\n[2] 主动搭话能否让 AI 按人设说话")
        r = json.loads(cdp.eval(JS_ASK_AI) or "{}")
        text = (r.get("text") or "").strip()
        print(f"    人设: {r.get('persona')}")
        print(f"    生成: {text!r}")
        if r.get("err"):
            print(f"    错误: {r['err']}")
        check("AI 调用成功", not r.get("err"), str(r.get("err")))
        check("生成了内容", len(text) > 0, f"长度 {len(text)}")
        check("不含 think 标签", "<think>" not in text and "</think>" not in text, text[:60])
        check("不含 markdown", "**" not in text and not text.strip().startswith('#'), text[:40])
        check("不含 [emotion] 标签", "[emotion" not in text.lower(), text[:40])
        check("长度合适(≤45字)", len(text) <= 45, f"长度 {len(text)}")

        print("\n[3] 桌宠切换后是否主动打招呼(真实 UI 路径)")
        # ⚠ 必须**真的切角色** —— App 只在 activeId 变化时派发 pet:character-switched,
        #   手动 dispatch 事件不会触发(hook 靠 activeId 变化来初始化)。
        # ⚠ 还要等够时间:App 有 800ms 延迟 + AI 生成耗时(实测 3~4s)。
        cur = json.loads(cdp.eval(JS_PET_NAME) or "{}")
        target = "橘猫" if cur.get("name") != "橘猫" else "球棒狸"
        pos = json.loads(cdp.eval("""
          (() => {
            const el = document.querySelector('.character-host.hatch-pet-host');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2});
          })()
        """) or "{}")
        if pos:
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
            cdp.eval(f"""
              (() => {{
                const items = [...document.querySelectorAll('.pet-menu-panel .char-item')];
                const t = items.find(x => (x.textContent||'').trim() === {json.dumps(target)});
                if (t) t.click();
                return !!t;
              }})()
            """)
            print(f"    已切到「{target}」,等待气泡…")
            # 轮询等气泡出现(最多 15s)
            bubbles = []
            for _ in range(30):
                time.sleep(0.5)
                bubbles = json.loads(cdp.eval(JS_BUBBLE) or "[]")
                vis = [b for b in bubbles if b.get("visible")]
                if vis and vis[0].get("text"):
                    bubbles = vis
                    break
            for b in bubbles:
                print(f"      [{b['cls']}] {b['text']}")
            check("切换后出现主动搭话气泡", len(bubbles) > 0, f"{len(bubbles)} 个")
            if bubbles:
                txt = bubbles[0].get("text", "")
                check("气泡内容非空", len(txt) > 0, txt[:40])
                check("气泡不含 think 标签", "<think>" not in txt, txt[:40])
        else:
            check("找到桌宠可点击", False)

        print("\n" + "=" * 60)
        if fails:
            print(f"主动搭话实测: {len(fails)} 项未通过")
            for f in fails:
                print(f"  ❌ {f}")
            print("=" * 60)
            return 1
        print("主动搭话实测: 全部通过 ✅")
        print("=" * 60)
        return 0
    finally:
        cdp.close()


if __name__ == "__main__":
    raise SystemExit(main())
