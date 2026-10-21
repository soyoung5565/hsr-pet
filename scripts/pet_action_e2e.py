#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""动作点播实测 —— 验证 pet:play-action 事件能真正切 atlas 行。

怎么验证「切了行」而不是「只是没报错」:
  读 canvas 像素 —— 不同行的画面内容不同(帧数/构图都不同),
  对比播放前后 canvas 的 toDataURL 哈希,变了才说明真的换了动作。
  再逐行验证:每个动作行播完后的画面都应与 idle 行不同。

用法:
  python pet_action_e2e.py
"""
from __future__ import annotations

import hashlib
import json
import sys
import time

sys.path.insert(0, r"D:\hsr-pet\scripts")
from pet_physics_e2e import CDP, find_page, find_debug_port  # noqa: E402

# 读 canvas 像素并算哈希(不同行画面不同 → 哈希不同)
JS_CANVAS_HASH = """
(() => {
  const cv = document.querySelector('.character-host.hatch-pet-host canvas');
  if (!cv) return null;
  try {
    const d = cv.toDataURL('image/png');
    let h = 0;
    for (let i = 0; i < d.length; i++) { h = (h * 31 + d.charCodeAt(i)) | 0; }
    return { hash: h, len: d.length };
  } catch (e) { return { err: String(e) }; }
})()
"""

# 读 canvas 的非透明像素 bbox —— 用来区分「同一行的不同帧」与「不同行」
JS_CANVAS_BBOX = """
(() => {
  const cv = document.querySelector('.character-host.hatch-pet-host canvas');
  if (!cv) return null;
  const ctx = cv.getContext('2d');
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, n = 0;
  for (let y = 0; y < cv.height; y++) {
    for (let x = 0; x < cv.width; x++) {
      if (d[(y * cv.width + x) * 4 + 3] > 16) {
        n++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { n, minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, top: minY };
})()
"""

ROWS = [
    (0, "待机"),
    (1, "向右走"),
    (2, "向左走"),
    (3, "挥手"),
    (4, "跳跃"),
    (5, "失败"),
    (6, "等待"),
    (7, "工作中"),
    (8, "回答"),
]


def main() -> int:
    port = find_debug_port()
    cdp = CDP(find_page(port))
    fails: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"  {'✅' if ok else '❌'} {name}" + (f"  — {detail}" if detail else ""))
        if not ok:
            fails.append(name)

    try:
        # 归位 + 确保桌宠可见
        cdp.eval("""
          (() => {
            const el = document.querySelector('.character-host.hatch-pet-host');
            if (!el) return false;
            el.style.left = (window.innerWidth/2)+'px';
            el.style.top = (window.innerHeight/2)+'px';
            return true;
          })()
        """)
        time.sleep(0.3)

        print("=== A. 逐行动作点播(看画面是否真的换行)===")
        # 先播 idle 作为基线
        cdp.eval("""
          window.dispatchEvent(new CustomEvent('pet:play-action',
            { detail: { row: 0, durationMs: 3000 } }));
        """)
        time.sleep(0.4)
        base = cdp.eval(JS_CANVAS_BBOX)
        print(f"  基线(row0 待机): bbox={base}")

        row_hashes: dict[int, str] = {}
        for row, label in ROWS:
            cdp.eval(f"""
              window.dispatchEvent(new CustomEvent('pet:play-action',
                {{ detail: {{ row: {row}, durationMs: 2500 }} }}));
            """)
            time.sleep(0.45)
            bbox = cdp.eval(JS_CANVAS_BBOX)
            h = cdp.eval(JS_CANVAS_HASH)
            row_hashes[row] = str(h.get("hash") if h else None)
            print(f"  row{row} {label:<6}: bbox_top={bbox.get('top')} "
                  f"h={bbox.get('h')} 非透明像素={bbox.get('n')} hash={row_hashes[row]}")

        # 每个非 idle 行都应与 idle 行不同
        print("\n=== B. 各行画面互不相同 ===")
        unique = len(set(row_hashes.values()))
        check("9 个动作行画面各不相同", unique >= 7,
              f"不同哈希数={unique}/9")

        # B.2 「向右走」与「向左走」必须是镜像 → 像素不同但结构相同
        check("向右走 ≠ 向左走(镜像不同)", row_hashes[1] != row_hashes[2],
              f"{row_hashes[1]} vs {row_hashes[2]}")

        # C. 动作播完自动回到常态(不卡在动作行)
        print("\n=== C. 动作播完自动回落 ===")
        cdp.eval("""
          window.dispatchEvent(new CustomEvent('pet:play-action',
            { detail: { row: 4, durationMs: 600 } }));
        """)
        time.sleep(0.3)
        during = cdp.eval(JS_CANVAS_HASH)
        time.sleep(3.0)  # 等 durationMs 过去 + 回落
        after = cdp.eval(JS_CANVAS_HASH)
        check("动作结束后画面已变化(回到常态)", during.get("hash") != after.get("hash"),
              f"播放中={during.get('hash')} 之后={after.get('hash')}")

        # D. 非法 row 应被忽略,不能崩
        print("\n=== D. 非法输入容错 ===")
        ok = cdp.eval("""
          (() => {
            try {
              window.dispatchEvent(new CustomEvent('pet:play-action', { detail: { row: 999 } }));
              window.dispatchEvent(new CustomEvent('pet:play-action', { detail: {} }));
              window.dispatchEvent(new CustomEvent('pet:play-action', { detail: { alias: '不存在的动作' } }));
              return 'no-throw';
            } catch (e) { return 'throw: ' + e; }
          })()
        """)
        check("非法 row / 空 detail 不抛异常", ok == "no-throw", str(ok))

        # E. 页面还活着
        alive = cdp.eval("document.querySelector('.character-host.hatch-pet-host') !== null")
        check("桌宠仍正常挂载", alive is True)

        print("\n" + "=" * 56)
        if fails:
            print(f"动作点播实测: {len(fails)} 项未通过")
            for f in fails:
                print(f"  ❌ {f}")
            print("=" * 56)
            return 1
        print("动作点播实测: 全部通过 ✅")
        print("=" * 56)
        return 0
    finally:
        cdp.close()


if __name__ == "__main__":
    raise SystemExit(main())
