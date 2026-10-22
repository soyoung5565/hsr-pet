#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""AI 对话面板端到端实测 —— 真的用 UI 打字发一条消息,看桌宠按人设回话。

为什么不能只测 sendChat:
  `pet_ai_chat_check.py` 直接调 `window.petAPI.sendChat`,绕过了整个 UI。
  但用户实际路径是:右键 → 对话 → 打字 → Enter。
  这条路上有 React state、人设注入、情绪标签解析、气泡渲染 ——
  任何一环断了 sendChat 测试都发现不了(上一轮的人设 bug 就是这么漏的)。

验证:
  1. 右键菜单能打开「对话」入口
  2. 面板出现,输入框可聚焦
  3. 真实键入 + Enter 能发出(用户消息进历史)
  4. 收到 AI 回答(非空、非 think 残留)
  5. 回答符合当前角色人设(专属标记词)

用法:
  python pet_chat_ui_e2e.py                 # 用当前角色
  python pet_chat_ui_e2e.py --char 球棒狸   # 指定角色(会自动切换)
"""
from __future__ import annotations

import argparse
import json
import sys
import time

sys.path.insert(0, r"D:\hsr-pet\scripts")
from pet_physics_e2e import CDP, find_page, find_debug_port  # noqa: E402

MARKERS: dict[str, list[str]] = {
    "球棒狸": ["本狸", "挥棒", "本垒", "上垒", "安打", "喵呜", "本棒"],
    "万津莫": ["小莫", "唔", "嗯…"],
    "耄耋": ["本大爷", "哼", "喂", "喵嗷"],
    "橘猫": ["本喵"],
}

TEST_MSG = "你在干什么呀?"

JS_STATE = """
(() => {
  const host = document.querySelector('.character-host.hatch-pet-host');
  const ta = document.querySelector('textarea.qa-textarea');
  // ★ 回答容器是 `.qa-answer-body`(.md-body 是它的格式类)。
  //   之前的判据用的是 .qa-answer-text / .qa-stream-text —— 都不存在,
  //   于是「AI 明明回了话」却被判成「没回答」。判据必须对着真实 DOM。
  const ans = document.querySelector('.qa-answer-body');
  return JSON.stringify({
    petName: host ? host.getAttribute('data-pet-name') : null,
    hasTextarea: !!ta,
    textareaVisible: ta ? (ta.getBoundingClientRect().height > 0) : false,
    bodyCls: document.querySelector('.app-root') ? document.querySelector('.app-root').className : '',
    answerText: ans ? (ans.textContent || '').trim().slice(0, 500) : '',
    hasAnswerEl: !!ans,
    popupVisible: !!document.querySelector('.qa-popup'),
    err: [...document.querySelectorAll('[class*=error]')].map(e => (e.textContent || '').trim()).join(' | ').slice(0, 200),
    allText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 600),
  });
})()
"""

JS_OPEN_MENU = """
(() => {
  const host = document.querySelector('.character-host.hatch-pet-host');
  if (!host) return null;
  const r = host.getBoundingClientRect();
  return JSON.stringify({x: r.left + r.width / 2, y: r.top + r.height / 2});
})()
"""


def reset_to_input(cdp: CDP) -> str:
    """把面板复位到可输入状态。

    桌宠面板有两个态:`qa-input`(有 textarea)和 `qa-answer`(只显示上次回答)。
    上一轮跑完会停在 answer 态 → 直接找 textarea 会找不到,
    看起来像「面板坏了」,其实只是没回到输入态。先点「继续对话」。
    """
    st = json.loads(cdp.eval(JS_STATE) or "{}")
    if st.get("hasTextarea"):
        return "already-input"
    r = cdp.eval("""
      (() => {
        const btns = [...document.querySelectorAll('.qa-btn, .qa-actions button')];
        const b = btns.find(x => (x.textContent || '').includes('继续对话'));
        if (b) { b.click(); return 'continue'; }
        // 没有的话,先关掉面板再重开
        const x = document.querySelector('.qa-header .qa-close, .qa-header button');
        if (x) { x.click(); return 'closed'; }
        return 'none:' + btns.map(b => (b.textContent||'').trim()).join('|');
      })()
    """)
    time.sleep(0.8)
    return str(r)


def open_chat(cdp: CDP) -> bool:
    """右键桌宠 → 点「对话」。面板已打开时直接返回 True。"""
    st = json.loads(cdp.eval(JS_STATE) or "{}")
    if st.get("hasTextarea"):
        return True
    pos = json.loads(cdp.eval(JS_OPEN_MENU) or "{}")
    if not pos:
        return False
    cdp.mouse("mousePressed", pos["x"], pos["y"], button="right", buttons=2)
    cdp.mouse("mouseReleased", pos["x"], pos["y"], button="right", buttons=0)
    time.sleep(0.4)
    clicked = cdp.eval("""
      (() => {
        const btns = [...document.querySelectorAll('.pet-menu .menu-btn, .pet-menu button')];
        const b = btns.find(x => (x.textContent || '').trim() === '对话');
        if (b) { b.click(); return 'ok'; }
        return 'not-found:' + btns.map(x => (x.textContent||'').trim()).join('|').slice(0,120);
      })()
    """)
    return clicked == "ok"


def type_and_send(cdp: CDP, text: str) -> bool:
    """聚焦 textarea → 逐字键入(触发 React onChange)→ Enter 发送。

    ⚠ 不能用 `textarea.value = x` 再 dispatch input:React 受控组件会覆盖它。
      必须用**真实按键**,CDP Input.insertText 能触发完整的 input 事件链。
    """
    if cdp.eval("(() => { const t = document.querySelector('textarea.qa-textarea'); "
                "if (!t) return false; t.focus(); return true; })()") is not True:
        return False
    time.sleep(0.2)
    cdp.send("Input.insertText", {"text": text})
    time.sleep(0.5)
    cdp.send("Input.dispatchKeyEvent", {
        "type": "keyDown", "key": "Enter", "code": "Enter",
        "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13,
    })
    cdp.send("Input.dispatchKeyEvent", {
        "type": "keyUp", "key": "Enter", "code": "Enter",
        "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13,
    })
    return True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--char", default="", help="目标角色(可选,会自动切换)")
    args = ap.parse_args()

    fails: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'✅' if ok else '❌'} {name}" + (f"  — {detail}" if detail else ""))
        if not ok:
            fails.append(name)

    port = find_debug_port()
    # AI 回答要等,默认 20s socket 超时会误判
    cdp = CDP(find_page(port), timeout=180)
    try:
        st = json.loads(cdp.eval(JS_STATE) or "{}")
        cur = st.get("petName")
        print(f"[1] 当前角色: {cur}")

        if args.char and args.char != cur:
            print(f"    (需要先切到「{args.char}」,本脚本不自动切 —— 请先手动切换或用 pet_proactive_check)")
            return 2

        print("[2] 复位 + 打开对话面板")
        rst = reset_to_input(cdp)
        print(f"    复位: {rst}")
        if rst == "closed":
            time.sleep(0.5)
        ok = open_chat(cdp)
        check("对话面板可进入输入态", ok)
        time.sleep(1.2)
        st = json.loads(cdp.eval(JS_STATE) or "{}")
        check("输入框存在", st.get("hasTextarea") is True)
        check("输入框可见", st.get("textareaVisible") is True)

        print(f"[3] 键入并发一条消息: {TEST_MSG!r}")
        ok = type_and_send(cdp, TEST_MSG)
        check("键入 + 发送成功", ok)

        # 等 AI 回答:轮询 .qa-answer-body,最多 100s
        print("[4] 等待 AI 回答…")
        answer = ""
        last = ""
        t0 = time.time()
        for _ in range(200):
            time.sleep(0.5)
            st = json.loads(cdp.eval(JS_STATE) or "{}")
            a = (st.get("answerText") or "").strip()
            last = a or last
            # ★ 必须排除流式占位符:回答区会先渲染「思考中…▍」,
            #   它不是答案(抓到它就会误判「人设没生效」)。
            #   判据:长度 > 3 且不含「思考中」且不是用户原话。
            if (
                a and a != TEST_MSG and len(a) > 3
                and "思考中" not in a and "▍" not in a
            ):
                answer = a
                break
        dt = time.time() - t0
        print(f"    耗时 {dt:.1f}s")
        print(f"    回答: {answer!r}")
        if st.get("err"):
            print(f"    页面错误: {st['err']}")
        if not answer:
            print(f"    最后抓到: {last!r}")
            print(f"    页面全文: {st.get('allText', '')[:300]}")

        check("收到非空回答", len(answer) > 0, f"长度 {len(answer)}")
        check("回答不是原样回显", answer.strip() != TEST_MSG)
        check("不含 think 残留", "<think>" not in answer and "</think>" not in answer, answer[:50])

        marks = MARKERS.get(cur or "", [])
        if marks:
            hit = [m for m in marks if m in answer]
            check(f"符合「{cur}」人设口吻", bool(hit),
                  f"命中 {hit}" if hit else f"应有其一 {marks}")

        print("\n" + "=" * 60)
        if fails:
            print(f"对话面板 E2E: {len(fails)} 项未通过")
            for f in fails:
                print(f"  ❌ {f}")
            print("=" * 60)
            return 1
        print("对话面板 E2E: 全部通过 ✅")
        print("=" * 60)
        return 0
    finally:
        cdp.close()


if __name__ == "__main__":
    raise SystemExit(main())
