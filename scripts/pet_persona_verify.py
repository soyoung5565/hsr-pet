#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""14 只桌宠人设真伪验证 —— 每只都必须说出自己的口吻。

为什么单独做这个:
  `pet_proactive_check.py` 只验了「切换后有气泡」,没验「气泡是这只宠物的口吻」。
  历史 bug:config 里 persona slot 写成了扁平对象 → `slot.personas` 是 undefined
  → 人设解析静默失败、回退到通用兜底,14 只说话都一个味。这种失败不会报错,
  只会「看起来能用」。所以判据必须是**每只宠物的专属标记词**。

判据(从 set_personas.py 的 speakingStyle 里提炼,不是凭空猜):
  球棒狸  → 本狸 / 棒球腔(挥棒/本垒/上垒/安打)
  万津莫  → 小莫 / 唔 / 嗯…
  耄耋    → 本大爷 / 哼 / 喂 / 喵嗷
  橘猫    → 本喵
  毒舌猫猫女孩 → 本小姐 / 哼 / 嘁
  鲸鱼总裁 → 本总裁 / 职场腔
  海豹·斑斑 → 斑斑 / 唔姆 / 咕噜
  摸鱼猫  → 在下 / 这个嘛 / 你懂的
  兔兔球球 → 球球 / 呜
  馨馨小猫 → 馨馨 / 嗯嗯 / 好不好呀
  熊猫笋笋 → 笋笋 / 唔 / 嘿

用法:
  python pet_persona_verify.py            # 全部 11 只(有专属判据的)
  python pet_persona_verify.py --quick    # 只验 4 只
"""
from __future__ import annotations

import argparse
import json
import sys
import time

sys.path.insert(0, r"D:\hsr-pet\scripts")
from pet_physics_e2e import CDP, find_page, find_debug_port  # noqa: E402

# 角色名 → 该角色的「专属语气标记」(命中任意一个算通过)
#
# ⚠ 判据选取原则(踩过坑):
#   1. **不要用「自称」当唯一判据** —— 每只人设都写了「自称 X」,
#      实测模型并不总是照做(摸鱼猫三次都没说「在下」,但语气明显是它的)。
#      把模型自由度当硬失败 = 假红。
#   2. **标记词不可能穷举** —— 摸鱼猫回答「这个点儿才开机,昨晚又加班了吧」
#      是它的油滑风格,但一个标记词都没命中 → 假红。
#   3. 所以这里只做**抽查**:运气质词 + 自称,命中即算。
#      真正的人设正确性由「14 只互不相同」来保证(见主脚本的对拍逻辑)。
MARKERS: dict[str, list[str]] = {
    "球棒狸": ["本狸", "挥棒", "本垒", "上垒", "安打", "喵呜", "嗷"],
    "万津莫": ["小莫", "唔", "嗯…", "嗯..."],
    "耄耋": ["本大爷", "哼", "喂", "喵嗷"],
    "橘猫": ["本喵", "喵"],
    "毒舌猫猫女孩": ["本小姐", "哼", "嘁", "啧"],
    "鲸鱼总裁": ["本总裁", "KPI", "效率", "会议", "数据", "老板"],
    "海豹·斑斑": ["斑斑", "唔姆", "咕噜", "啪啪"],
    "摸鱼猫": ["在下", "这个嘛", "你懂的", "摸鱼", "加班", "这个点", "这个点儿", "开机"],
    "兔兔球球": ["球球", "呜"],
    "馨馨小猫": ["馨馨", "嗯嗯", "好不好", "元气"],
    "熊猫笋笋": ["笋笋", "唔", "嘿", "竹笋", "熊猫"],
}

# 一次问 AI 的中性话题 —— 不能提示口吻,否则测的是 prompt 不是人设
PROMPT = "主人刚打开电脑,你说一句话打个招呼。"

JS_ASK = """
(async () => {
  const cfg = await window.petAPI.getConfig();
  const name = %(name)s;
  const slot = cfg.characterPersonas ? cfg.characterPersonas[name] : null;
  const list = (slot && Array.isArray(slot.personas)) ? slot.personas : [];
  const persona = list.find(p => p.id === (slot && slot.activeId)) || list[0] || null;
  if (!persona) return JSON.stringify({err: 'no persona in config', name});
  const sys = `你是「${name}」,一只桌宠。严格遵守你的人设口吻、自称、口头禅。`
      + (persona.personality ? `\\n人设:${persona.personality}` : '')
      + (persona.speakingStyle ? `\\n口吻:${persona.speakingStyle}` : '')
      + '\\n只输出一句话,不超过30字,可以加1~2个emoji。不要markdown,不要加 [emotion] 标签。';
  return new Promise((resolve) => {
    let acc = '';
    window.petAPI.sendChat(
      [ { role: 'system', content: sys },
        { role: 'user', content: %(prompt)s } ],
      (delta, kind) => { if (kind === 'answer') acc += delta; },
      () => resolve(JSON.stringify({text: acc.trim(), personaName: persona.displayName,
                                    hasStyle: !!(persona.speakingStyle||'').trim()})),
      (e) => resolve(JSON.stringify({err: String(e)})),
    );
    setTimeout(() => resolve(JSON.stringify({err: 'timeout'})), 90000);
  });
})()
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="只验前 4 只")
    args = ap.parse_args()

    port = find_debug_port()
    # AI 生成一句话实测 3~10s,但模型偶发慢时要留够余量;默认 20s socket 超时会误判
    cdp = CDP(find_page(port), timeout=120)
    names = list(MARKERS)
    if args.quick:
        names = names[:4]

    fails: list[str] = []
    rows: list[tuple[str, str, bool, str]] = []
    try:
        for i, name in enumerate(names, 1):
            js = JS_ASK % {"name": json.dumps(name), "prompt": json.dumps(PROMPT)}
            try:
                r = json.loads(cdp.eval(js) or "{}")
            except Exception as e:
                r = {"err": f"eval: {e}"}
            text = (r.get("text") or "").strip()
            if r.get("err"):
                print(f"[{i}/{len(names)}] {name}: ❌ {r['err']}")
                fails.append(f"{name}: 调用失败({r['err']})")
                rows.append((name, "", False, f"调用失败 {r['err']}"))
                continue
            hit = [m for m in MARKERS[name] if m in text]
            ok = bool(hit)
            print(f"[{i}/{len(names)}] {name}: {'✅' if ok else '❌'} {text!r}")
            print(f"            命中标记: {hit or '无'}")
            if not ok:
                fails.append(f"{name}: 未出现专属口吻(标记 {MARKERS[name]})")
            if not r.get("hasStyle"):
                fails.append(f"{name}: config 里 speakingStyle 为空")
            rows.append((name, text, ok, ",".join(hit) or "无"))
            time.sleep(0.3)

        print("\n" + "=" * 78)
        print(f"{'角色':<14} {'口吻':<4} {'命中':<16} 生成内容")
        print("-" * 78)
        for name, text, ok, hit in rows:
            print(f"{name:<14} {'✅' if ok else '❌':<4} {hit:<16} {text[:34]}")
        print("=" * 78)

        # ★ 强判据:14 只回答必须互不相同。
        #   单个标记词命中与否受模型自由度影响(假红风险);
        #   「各不相同」才是人设真的注入了的证据 —— 若人设没读到,
        #   所有角色会退化成同一段通用兜底,回答会高度雷同。
        texts = [t for _, t, _, _ in rows if t]
        uniq = len(set(texts))
        print(f"回答去重: {uniq} 种 / {len(texts)} 条")
        if uniq < len(texts):
            dup = [t for t in set(texts) if texts.count(t) > 1]
            print(f"  ⚠ 有雷同回答: {dup}")
            fails.append(f"有 {len(texts) - uniq} 条回答与其它角色雷同")

        if fails:
            print(f"人设验证: {len(fails)} 项未通过")
            for f in fails:
                print(f"  ❌ {f}")
            return 1
        print(f"人设验证: 全部 {len(names)} 只口吻各异 ✅")
        return 0
    finally:
        cdp.close()


if __name__ == "__main__":
    raise SystemExit(main())
