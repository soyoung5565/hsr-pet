#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓「桌宠 + 气泡」演示图 —— 桌宠 canvas + 气泡文字,合成到一张图上。

为什么要自己合成:
  桌宠窗口是全屏透明置顶,系统截屏会被别的窗口盖住(踩过两次)。
  所以直接读 canvas 像素 + 读气泡 DOM 文字,自己在 Python 里拼。

时机:气泡显示几秒就淡出(opacity → 0),所以要**在它还可见时**抓 canvas。
  做法:先切角色触发主动搭话,然后高频轮询,一旦 opacity > 0 就立刻抓。

用法:
  python pet_demo_shot.py
"""
from __future__ import annotations

import base64
import io
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, r"D:\hsr-pet\scripts")
from pet_physics_e2e import CDP, find_page, find_debug_port  # noqa: E402

from PIL import Image, ImageDraw, ImageFont

JS_STATE = """
(() => {
  const el = document.querySelector('.character-host.hatch-pet-host');
  if (!el) return null;
  const sp = document.querySelector('.pet-speech');
  const r = el.getBoundingClientRect();
  const cls = sp ? sp.className : '';
  let petUrl = '';
  try {
    // 注意:必须每次重新查 canvas —— 角色切换时 canvas 会被替换,
    // 老的引用会抛异常或返回空。
    const cv = document.querySelector('.character-host.hatch-pet-host canvas');
    if (cv) petUrl = cv.toDataURL('image/png');
  } catch (e) {
    return JSON.stringify({
      err: 'toDataURL: ' + String(e),
      speech: sp ? (sp.textContent || '').trim() : '',
      name: el.getAttribute('data-pet-name'),
    });
  }
  return JSON.stringify({
    pet: petUrl,
    speech: sp ? (sp.textContent || '').trim() : '',
    visible: !!sp && !cls.includes('pet-speech--out'),
    name: el.getAttribute('data-pet-name'),
    x: r.left, y: r.top, w: r.width, h: r.height,
  });
})()
"""

JS_POS = """
(() => {
  const el = document.querySelector('.character-host.hatch-pet-host');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return JSON.stringify({x: r.left + r.width/2, y: r.top + r.height/2});
})()
"""


def pick_font(size: int):
    """找一个能显示中文的字体(Windows 自带)。"""
    for p in [
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\simsun.ttc",
    ]:
        if Path(p).exists():
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def pick_emoji_font(size: int):
    """彩色 emoji 字体。桌宠人设里 emoji 用得很多(⚾🐾),
    中文字体没有这些字形 → 不换字体的话会渲染成空心方框 □。"""
    p = r"C:\Windows\Fonts\seguiemj.ttf"
    try:
        return ImageFont.truetype(p, size)
    except Exception:
        return None


# 中文行首禁则:这些字符**不能**出现在行首(要跟上一行粘住)
NO_LINE_START = set("，。、；：！？）】》」』…～%!?,;:)]}>")
# 中文行尾禁则:这些字符**不能**出现在行尾(要跟下一行粘住)
NO_LINE_END = set("（【《「『([{<")


def is_emoji(ch: str) -> bool:
    o = ord(ch)
    return (
        0x1F000 <= o <= 0x1FAFF      # 主要 emoji 区
        or 0x2600 <= o <= 0x27BF     # 杂项符号 + dingbats(⚾ 在这)
        or 0x2B00 <= o <= 0x2BFF
        or 0xFE0F == o               # variation selector
        or 0x200D == o               # ZWJ
    )


def char_width(ch: str, font, emoji_font) -> float:
    f = emoji_font if (emoji_font and is_emoji(ch)) else font
    return f.getlength(ch)


def wrap_cjk(text: str, font, emoji_font, max_w: float) -> list[str]:
    """按**字**断行,并遵守中文行首/行尾禁则。

    为什么要自己断:原来按 `font.getlength` 简单累积会把「就位」拆成「已就 / 位」;
    中文没有空格,断行位置必须靠标点禁则约束才不会断在半个词里。
    """
    lines: list[str] = []
    for para in text.split("\n"):
        cur = ""
        for ch in para:
            w = char_width(ch, font, emoji_font)
            if cur and sum(char_width(c, font, emoji_font) for c in cur) + w > max_w:
                # 当前字不能放行首 → 把上一行最后一个字挪下来跟它作伴
                if ch in NO_LINE_START and len(cur) > 1:
                    carry = cur[-1]
                    lines.append(cur[:-1])
                    cur = carry + ch
                    continue
                # 上一行末尾是左括号类 → 把它也挪下来
                if cur[-1] in NO_LINE_END and len(cur) > 1:
                    carry = cur[-1]
                    lines.append(cur[:-1])
                    cur = carry + ch
                    continue
                lines.append(cur)
                cur = ch
            else:
                cur += ch
        if cur:
            lines.append(cur)
    return lines or [""]


def draw_mixed(draw, x: float, y: float, text: str, font, emoji_font) -> None:
    """逐字符绘制,emoji 用彩色 emoji 字体(embedded_color)。"""
    cx = x
    for ch in text:
        if emoji_font and is_emoji(ch):
            try:
                draw.text((cx, y), ch, font=emoji_font,
                          fill=(42, 42, 52, 255), embedded_color=True)
            except Exception:
                draw.text((cx, y), ch, font=emoji_font, fill=(42, 42, 52, 255))
            cx += emoji_font.getlength(ch)
        else:
            draw.text((cx, y), ch, font=font, fill=(42, 42, 52, 255))
            cx += font.getlength(ch)


def main() -> int:
    port = find_debug_port()
    cdp = CDP(find_page(port))
    out = Path(r"D:\hsr-pet\dl\demo")
    out.mkdir(parents=True, exist_ok=True)
    try:
        # 先切到别的角色(确保下次切换一定会触发主动搭话),
        # 再切回目标角色 → 触发「切换后主动打招呼」
        def switch_to(name: str) -> bool:
            pos = json.loads(cdp.eval(JS_POS) or "{}")
            if not pos:
                return False
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
            return cdp.eval(f"""
              (() => {{
                const items = [...document.querySelectorAll('.pet-menu-panel .char-item')];
                const t = items.find(x => (x.textContent||'').trim() === {json.dumps(name)});
                if (t) t.click();
                return !!t;
              }})()
            """) == "ok"

        cur = json.loads(cdp.eval(JS_STATE) or "{}")
        current = cur.get("name")
        print(f"当前角色: {current}")
        if current == "球棒狸":
            ok = switch_to("橘猫")
            print(f"  切到橘猫: {ok}")
            time.sleep(2.5)
        ok = switch_to("球棒狸")
        print(f"已切到「球棒狸」({ok}),等待气泡…")

        # 高频轮询,气泡可见时立刻抓 canvas
        got = None
        for _ in range(120):
            time.sleep(0.15)
            raw = cdp.eval(JS_STATE)
            if not raw:
                continue
            st = json.loads(raw)
            if st.get("visible") and st.get("speech"):
                got = st
                break
        if not got:
            print("✗ 没抓到可见气泡")
            return 1

        print(f"角色: {got['name']}")
        print(f"气泡: {got['speech']!r}")

        # ★ 气泡拿到之后**单独再抓一次 canvas** ——
        #   轮询时抓的那一次可能正好撞上角色切换(canvas 被替换)→ 拿到空 dataURL。
        pet_b64_raw = got.get("pet") or ""
        if len(pet_b64_raw) < 1000:
            print("  轮询时 canvas 为空,单独重抓…")
            fresh = json.loads(cdp.eval("""
              (() => {
                const cv = document.querySelector('.character-host.hatch-pet-host canvas');
                try { return JSON.stringify({u: cv ? cv.toDataURL('image/png') : ''}); }
                catch (e) { return JSON.stringify({u: '', e: String(e)}); }
              })()
            """) or "{}")
            pet_b64_raw = fresh.get("u") or ""
            if fresh.get("e"):
                print(f"  ✗ {fresh['e']}")
        if len(pet_b64_raw) < 1000:
            print("✗ canvas 抓取失败")
            return 1

        # 合成:气泡在上,桌宠在下
        print(f"  dataURL 长度={len(pet_b64_raw)} head={pet_b64_raw[:40]!r}")
        if "," not in pet_b64_raw:
            print("✗ dataURL 格式异常(没有逗号)")
            return 1
        pet_b64 = pet_b64_raw.split(",", 1)[1]
        print(f"  base64 长度={len(pet_b64)} 首字符={pet_b64[:8]!r}")
        try:
            # ★ 必须包 BytesIO —— Image.open(bytes) 会把 bytes 当**文件名**
            #   去 os.fsdecode,于是拿 PNG 魔数 0x89 当路径解码 →
            #   UnicodeDecodeError: 'utf-8' codec can't decode byte 0x89。
            pet = Image.open(io.BytesIO(base64.b64decode(pet_b64))).convert("RGBA")
        except Exception as e:
            print(f"✗ 解码失败: {type(e).__name__}: {e}")
            return 1

        SCALE = 2
        pet = pet.resize((pet.width * SCALE, pet.height * SCALE), Image.LANCZOS)

        text = got["speech"]
        font = pick_font(13 * SCALE)
        emoji_font = pick_emoji_font(13 * SCALE)
        # ★ 按真实 CSS 还原:`.pet-speech { max-width:320px; padding:7px 12px;
        #   font-size:13px; line-height:1.45; border-radius:12px }`。
        #   之前用「气泡宽度 = 角色宽度 192px」→ 比真实窄一半,
        #   于是把「召唤出来」硬断成「召唤出/来」,看着像排版 bug 其实是我画错了。
        CSS_MAX_W = 320
        PAD_X, PAD_Y = 12, 7
        inner_w = min(CSS_MAX_W, 4000) - PAD_X * 2
        lines = wrap_cjk(text, font, emoji_font, inner_w * SCALE)

        line_h = round(13 * 1.45) * SCALE
        bubble_h = PAD_Y * 2 * SCALE + line_h * len(lines)
        # 气泡宽度:最宽一行 + 左右 padding,不超过 max-width
        text_w = max(
            sum(char_width(c, font, emoji_font) for c in ln) for ln in lines
        )
        bubble_w = int(min(CSS_MAX_W * SCALE, text_w + PAD_X * 2 * SCALE))
        # 画布要比气泡宽(气泡居中,角色居中)
        canvas_w = max(bubble_w, pet.width) + 16 * SCALE

        canvas = Image.new(
            "RGBA", (canvas_w, bubble_h + pet.height + 26 * SCALE), (0, 0, 0, 0)
        )
        draw = ImageDraw.Draw(canvas)
        bx = (canvas_w - bubble_w) // 2
        draw.rounded_rectangle(
            [bx, 0, bx + bubble_w - 1, bubble_h - 1],
            radius=12 * SCALE,
            fill=(255, 255, 255, 242),
            outline=(60, 60, 70, 31),
            width=1,
        )
        for i, ln in enumerate(lines):
            draw_mixed(draw, bx + PAD_X * SCALE, PAD_Y * SCALE + i * line_h, ln, font, emoji_font)
        tail_x = bx + bubble_w // 2
        draw.polygon(
            [
                (tail_x - 6 * SCALE, bubble_h - 2),
                (tail_x + 6 * SCALE, bubble_h - 2),
                (tail_x, bubble_h + 10 * SCALE),
            ],
            fill=(255, 255, 255, 242),
        )
        # 角色居中放到画布上(之前固定 x=0 → 画布变宽后会偏左)
        canvas.alpha_composite(pet, ((canvas_w - pet.width) // 2, bubble_h + 14 * SCALE))
        # 气泡尾巴在气泡正下方,已经随 bx 一起算了

        # 背景:canvas 是透明的,直接看会「白底看不清」。加一层浅灰演示底。
        bg = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        bd = ImageDraw.Draw(bg)
        bd.rounded_rectangle(
            [0, 0, bg.width - 1, bg.height - 1],
            radius=10 * SCALE,
            fill=(246, 247, 250, 255),
            outline=(210, 214, 224, 255),
            width=2,
        )
        bg.alpha_composite(canvas)

        f = out / "demo.png"
        bg.save(f)
        print(f"✅ {f}  ({canvas.width}x{canvas.height})")
        return 0
    finally:
        cdp.close()


if __name__ == "__main__":
    raise SystemExit(main())
