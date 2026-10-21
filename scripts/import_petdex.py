#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 petdex.dev 导入社区桌宠到本项目 hatch-pet 用户目录。

为什么需要这个:
  petdex 的宠物包格式 = Codex hatch-pet 格式 = 本项目底座的资源契约
  (1536x1872 = 8列 x 9行, 单帧 192x208 RGBA)
  → 两者零转换,只需把 spritesheetPath 指对文件名即可直接跑。

  唯一的差异: petdex 用 spritesheet.webp / sprite.webp 两种命名,
  本项目扫描器读 pet.json 的 spritesheetPath(缺省才是 spritesheet.webp),
  所以只要把下载的文件重命名成本项目约定的 spritesheet.webp 即可。

★ v2 格式(1536x2288 = 8x11)必须转成 v1:
  petdex 有两种精灵表规格:
    v1: 1536x1872 (8列 x 9行) —— 本项目底座支持的唯一规格
    v2: 1536x2288 (8列 x 11行) —— 前 9 行语义与 v1 完全一致,
       多出的第 10/11 行是「留给消费客户端的额外动作」(petdex README 原话)
  直接把 v2 当 v1 用 → 渲染端按 8x9 采样时会把第 10/11 行的像素算进
  错误的位置,而且第 9 行之后的数据被丢弃 → 画面错乱。
  → 导入时裁掉底部 2 行,转成标准 v1。

用法:
  python import_petdex.py <slug>            # 导入一只
  python import_petdex.py <slug> ...        # 导入多只
  python import_petdex.py --search 鲸鱼      # 按关键词搜 manifest
  python import_petdex.py --list 50         # 列 manifest 前 N 只
  python import_petdex.py --out <dir>       # 改输出根(默认 userData/hatch-pet)
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import urllib.request
from pathlib import Path

from PIL import Image

MANIFEST_URL = "https://petdex.dev/api/manifest"

# 规格常量
V1_W, V1_H = 1536, 1872   # 8列 x 9行
V2_W, V2_H = 1536, 2288   # 8列 x 11行
FRAME_W, FRAME_H = 192, 208

# 本项目底座的默认输出根(Electron userData)。
# dev 态下 userData = %APPDATA%/<appName>,打包后同理。
DEFAULT_OUT = Path.home() / "AppData" / "Roaming" / "desktop-pet" / "hatch-pet"

TIMEOUT = 60


def http_get(url: str, retries: int = 3) -> bytes:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "hsr-pet-importer/1.0"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - 最后一轮统一抛出
            last = e
            print(f"  [retry {attempt + 1}/{retries}] {type(e).__name__}: {e}", file=sys.stderr)
    raise RuntimeError(f"GET failed: {url}") from last


def load_manifest() -> dict:
    print(f"拉取 manifest: {MANIFEST_URL}")
    raw = http_get(MANIFEST_URL)
    return json.loads(raw.decode("utf-8"))


def find_pets(manifest: dict, slugs: list[str]) -> list[dict]:
    pets = manifest.get("pets", [])
    by_slug = {p["slug"]: p for p in pets}
    out = []
    for s in slugs:
        if s in by_slug:
            out.append(by_slug[s])
        else:
            print(f"  ! manifest 里没有 slug={s}", file=sys.stderr)
    return out


def normalize_sheet(data: bytes) -> tuple[bytes, str]:
    """把下载的精灵表转成本项目要的 v1 规格(1536x1872)。

    返回 (转换后的字节, 说明文字)。

    - 已是 v1 → 原样返回
    - v2(1536x2288) → 裁掉底部 2 行 → v1
    - 其他尺寸 → 抛错(宁可明确失败,也不要默默画错)
    """
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"精灵表无法解码: {e}") from e

    size = im.size
    if size == (V1_W, V1_H):
        return data, f"v1 规格 {V1_W}x{V1_H}(无需转换)"

    if size == (V2_W, V2_H):
        # 裁掉底部 2 行(v2 的额外动作行)→ 标准 v1
        cropped = im.crop((0, 0, V2_W, V1_H))
        buf = io.BytesIO()
        cropped.save(buf, format="WEBP", lossless=True, quality=100)
        return buf.getvalue(), f"v2 规格 {V2_W}x{V2_H} → 裁掉底部 2 行转 v1"

    raise RuntimeError(f"精灵表尺寸 {size[0]}x{size[1]} 不受支持(应为 {V1_W}x{V1_H} 或 {V2_W}x{V2_H})")


def import_one(pet: dict, out_root: Path) -> tuple[bool, str]:
    slug = pet["slug"]
    sprite_url = pet.get("spritesheetUrl")
    petjson_url = pet.get("petJsonUrl")
    if not sprite_url or not petjson_url:
        return False, f"{slug}: manifest 缺 spritesheetUrl/petJsonUrl"

    dest = out_root / slug
    dest.mkdir(parents=True, exist_ok=True)

    # 1) 精灵表 —— 统一命名 spritesheet.webp(本项目契约)+ 规格归一化
    sheet = dest / "spritesheet.webp"
    note = ""
    if not sheet.exists() or sheet.stat().st_size == 0:
        print(f"  下载精灵表 {slug} …")
        raw = http_get(sprite_url)
        data, note = normalize_sheet(raw)
        sheet.write_bytes(data)
    else:
        print(f"  精灵表已存在,跳过 {slug}")
    size = sheet.stat().st_size
    if size < 1024:
        return False, f"{slug}: 精灵表太小({size}B),可能下载失败"

    # 2) pet.json —— 改写 spritesheetPath 指向本地文件名
    print(f"  下载 pet.json {slug} …")
    meta = json.loads(http_get(petjson_url).decode("utf-8"))
    meta["spritesheetPath"] = "spritesheet.webp"
    meta.setdefault("displayName", slug)
    meta.setdefault("description", pet.get("description", ""))
    # 记录来源,方便追溯
    meta["source"] = "petdex"
    meta["sourceUrl"] = f"https://petdex.dev/pets/{slug}"
    (dest / "pet.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return True, f"{slug} → {dest.name} ({size // 1024}KB){' | ' + note if note else ''}"


def main() -> int:
    ap = argparse.ArgumentParser(description="从 petdex.dev 导入社区桌宠")
    ap.add_argument("slugs", nargs="*", help="要导入的 slug")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="输出根目录")
    ap.add_argument("--search", help="按关键词搜索 manifest")
    ap.add_argument("--list", type=int, metavar="N", help="列出 manifest 前 N 只")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出(给 --search/--list 用)")
    args = ap.parse_args()

    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)

    if args.list or args.search:
        manifest = load_manifest()
        pets = manifest.get("pets", [])
        if args.search:
            kw = args.search.lower()
            hits = [
                p
                for p in pets
                if kw in (p.get("slug", "") + " " + p.get("displayName", "")).lower()
                or kw in (p.get("description", "") or "").lower()
            ]
        else:
            hits = pets[: args.list or 20]
        if args.json:
            print(json.dumps(hits, ensure_ascii=False, indent=2))
        else:
            print(f"共 {len(pets)} 只,匹配 {len(hits)} 只:")
            for p in hits:
                print(f"  {p['slug']:<32} {p.get('displayName',''):<24} {p.get('kind','')}")
        return 0

    if not args.slugs:
        ap.print_help()
        return 2

    manifest = load_manifest()
    targets = find_pets(manifest, args.slugs)
    if not targets:
        print("没有可导入的目标", file=sys.stderr)
        return 1

    ok = 0
    for pet in targets:
        try:
            good, msg = import_one(pet, out_root)
        except Exception as e:  # noqa: BLE001
            good, msg = False, f"{pet.get('slug')}: {type(e).__name__}: {e}"
        print(("  OK  " if good else "  FAIL") + " " + msg)
        ok += 1 if good else 0
    print(f"\n完成:{ok}/{len(targets)} 只导入成功 → {out_root}")
    return 0 if ok == len(targets) else 1


if __name__ == "__main__":
    raise SystemExit(main())
