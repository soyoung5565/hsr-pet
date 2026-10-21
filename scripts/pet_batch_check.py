#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""社区桌宠批量巡检 v3 —— 读**精灵表**判帧数,不是读 canvas。

v2 的教训(两次假绿):
  v1: 改 config 切不了角色(React state) → 测了同一只 14 遍,全绿。
  v2: 走了真实 UI 点击(角色确实换了),但帧数是**从 canvas 读的** ——
      canvas 只有 192x208 一帧(当前帧),不是 1536x1872 整张精灵表,
      所以「每行 8 格」里只有第 0 格有像素 → 帧数恒为 1 → 又一次全绿。
  → 判据要对着**真实被测对象**。帧数定义在精灵表上,就读精灵表。

怎么读精灵表:桌宠用 pet:// 协议加载。在页面里用 fetch + createImageBitmap
  拿到位图,重绘到离屏 canvas,再按 8×9 网格逐格采样中心 8×8。

用法:
  python pet_batch_check.py
  python pet_batch_check.py --limit 4
"""
from __future__ import annotations

import argparse
import json
import sys

sys.path.insert(0, r"D:\hsr-pet\scripts")
from pet_physics_e2e import CDP, find_page, find_debug_port  # noqa: E402

JS_SHEET_STATS = """
(async () => {
  const idx = await window.petAPI.scanCharacters();
  const all = idx.hatchPet || [];
  const FW = 192, FH = 208, COLS = 8, ROWS = 9;
  const out = [];
  for (const c of all) {
    let rows = null, err = null, w = 0, h = 0;
    try {
      const abs = c.spritesheetPath.replace(/\\\\/g, '/');
      // ★ 用 character.source 决定 host —— 不能从路径里猜!
      //   运行时路径里 builtin 和 user 都是 "…/desktop-pet/hatch-pet/<dir>/…",
      //   userData 那一层叫 "desktop-pet" 而不是 "hatch-pet-user",
      //   所以从路径猜 host 必然猜错(会把 user 的文件指到 builtin 根 → 404)。
      //   渲染端 toPetUrl() 也是按 source 选 host 的(见 shared/character.ts)。
      const host = c.source === 'user' ? 'hatch-pet-user' : 'hatch-pet';
      const rel = abs.split('/hatch-pet/').pop();
      const url = 'pet://' + host + '/' + rel;
      const resp = await fetch(url);
      if (!resp.ok) { err = 'http ' + resp.status; out.push({id:c.id, name:c.name, err}); continue; }
      const blob = await resp.blob();
      const bmp = await createImageBitmap(blob);
      w = bmp.width; h = bmp.height;
      const off = document.createElement('canvas');
      off.width = bmp.width; off.height = bmp.height;
      const octx = off.getContext('2d', { willReadFrequently: true });
      octx.drawImage(bmp, 0, 0);
      // 内容签名:整张图的像素抽样哈希 —— 用来验证「这只确实是它自己」
      const sig = octx.getImageData(0, 0, bmp.width, bmp.height).data;
      let sh = 0, nonEmpty = 0;
      for (let i = 0; i < sig.length; i += 997) { sh = (sh * 31 + sig[i]) | 0; if (sig[i+3] > 16) nonEmpty++; }
      rows = [];
      for (let r = 0; r < ROWS; r++) {
        let last = -1;
        for (let cc = 0; cc < COLS; cc++) {
          const d = octx.getImageData(cc*FW + FW/2 - 4, r*FH + FH/2 - 4, 8, 8).data;
          let any = false;
          for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) { any = true; break; } }
          if (any) last = cc;
        }
        rows.push(last + 1);
      }
      out.push({id:c.id, name:c.name, rows, w, h, sig: sh, nonEmpty});
    } catch (e) {
      out.push({id:c.id, name:c.name, err: String(e)});
    }
  }
  return JSON.stringify(out);
})()
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    port = find_debug_port()
    cdp = CDP(find_page(port))
    fails: list[str] = []

    try:
        raw = cdp.eval(JS_SHEET_STATS)
        if not raw:
            print("✗ 精灵表统计失败")
            return 1
        results = json.loads(raw) if isinstance(raw, str) else raw
        if args.limit:
            results = results[: args.limit]

        print(f"巡检 {len(results)} 只桌宠的**精灵表**(真实帧数)\n")
        print(f"{'角色':<20} {'id':<28} {'行帧数':<32} {'尺寸':<12} 状态")
        print("-" * 112)

        seen: dict[str, str] = {}
        for r in results:
            name = r.get("name", "?")
            rid = r.get("id", "?")
            rows = r.get("rows")
            if rows is None:
                print(f"{name[:18]:<20} {rid[:26]:<28} {'—':<32} {'—':<12} ❌ {r.get('err')}")
                fails.append(f"{name}: {r.get('err')}")
                continue
            size = f"{r.get('w')}x{r.get('h')}"
            issues = []
            if r.get("w") != 1536 or r.get("h") != 1872:
                issues.append(f"尺寸应为 1536x1872,实为 {size}")
            if not any(c > 0 for c in rows):
                issues.append("9 行全空")
            if rows[0] < 1:
                issues.append("idle 行(0)无帧")
            for i, c in enumerate(rows):
                if c > 8:
                    issues.append(f"row{i} 帧数 {c} > 8")
            # ⚠ 帧数相同 **不是** 问题 —— 多只宠物按规范填满同样的行数很正常。
            #   真正要防的是「URL 指到了同一只」→ 用**像素内容签名**判定。
            sig = r.get("sig")
            if sig is not None:
                if sig in seen:
                    issues.append(f"内容与「{seen[sig]}」完全相同(URL 拼错或指向同一只)")
                else:
                    seen[sig] = name

            status = "✅ 正常" if not issues else "❌ " + "; ".join(issues)
            if issues:
                fails.append(f"{name}: {'; '.join(issues)}")
            print(f"{name[:18]:<20} {rid[:26]:<28} {str(rows):<32} {size:<12} {status}")

        print("\n" + "=" * 112)
        if fails:
            print(f"巡检结果: {len(results) - len(fails)}/{len(results)} 只正常")
            for f in fails:
                print(f"  ❌ {f}")
            print("=" * 112)
            return 1
        print(f"巡检结果: 全部 {len(results)} 只正常 ✅")
        print("=" * 112)
        return 0
    finally:
        cdp.close()


if __name__ == "__main__":
    raise SystemExit(main())
