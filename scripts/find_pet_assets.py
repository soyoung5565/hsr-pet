#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在 AnimeStudio 生成的 asset map 里搜随宠相关资源。

用法: python find_pet_assets.py <map.json> [关键字 ...]

先打印 map 的结构（第一次跑用来摸清 schema），再按关键字搜。
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

DEFAULT_KEYS = [
    "Pet", "pet", "Trailblazer", "TrailblazerPet", "Charm", "charm",
    "球棒", "随宠", "Suichong", "PetMarble",
]


def main() -> int:
    map_path = Path(sys.argv[1])
    keys = sys.argv[2:] or DEFAULT_KEYS
    data = json.loads(map_path.read_text(encoding="utf-8"))

    print(f"map = {map_path}")
    print(f"top-level type: {type(data).__name__}")
    if isinstance(data, dict):
        print(f"top-level keys: {list(data.keys())[:20]}")
        for k, v in list(data.items())[:3]:
            print(f"  {k}: {type(v).__name__} "
                  f"len={len(v) if hasattr(v, '__len__') else '?'}")
    elif isinstance(data, list):
        print(f"list length: {len(data)}")
        print(f"first entry: {json.dumps(data[0], ensure_ascii=False)[:500]}")

    # 统一成 list of dict
    if isinstance(data, list):
        entries = data
    else:
        entries = None
        for v in data.values():
            if isinstance(v, list) and v and isinstance(v[0], dict):
                entries = v
                break
        if entries is None:
            print("!! 找不到 entry 列表，需要人工看 schema")
            return 1

    print(f"\nentries = {len(entries)}")
    print(f"entry fields: {sorted(entries[0].keys())}")

    # 字段值分布，帮助判断哪个字段是名字/容器
    for field in entries[0]:
        vals = [e.get(field) for e in entries[:2000]]
        uniq = len({str(v) for v in vals})
        print(f"  field {field:<24} distinct(sampled 2000) = {uniq}")

    # ---- 搜索 ----
    def blob(e: dict) -> str:
        return " ".join(str(v) for v in e.values())

    print("\n" + "=" * 70)
    for key in keys:
        pat = re.compile(re.escape(key), re.I)
        hits = [e for e in entries if pat.search(blob(e))]
        if not hits:
            print(f"[{key}] 无命中")
            continue
        print(f"\n[{key}] 命中 {len(hits)} 条，前 8 条：")
        for e in hits[:8]:
            show = {k: v for k, v in e.items()
                    if isinstance(v, (str, int)) and len(str(v)) < 90}
            print("   ", json.dumps(show, ensure_ascii=False))

    # ---- 名称字段的全量词频，找可能的宠物命名规律 ----
    name_field = None
    for cand in ("Container", "container", "Path", "path", "Name", "name"):
        if cand in entries[0]:
            name_field = cand
            break
    if name_field:
        c = Counter()
        for e in entries:
            v = str(e.get(name_field, ""))
            for part in re.split(r"[/\\]", v):
                if part:
                    c[part] += 1
        print(f"\n== {name_field} 路径分段词频 top 40 ==")
        for part, n in c.most_common(40):
            print(f"  {n:>6}  {part}")
    return 0


if __name__ == "__main__":
    sys.exit(main())