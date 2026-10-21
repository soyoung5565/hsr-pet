#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 Blender 渲染出的透明 PNG 序列拼成 Desktop-pet 要求的精灵表。

契约（来自 docs/素材规格-hatch-pet格式.md + 源码实测）：
  1536x1872 = 8 cols x 9 rows, 单帧 192x208
  行语义固定：0 idle / 1 right / 2 left / 3 waving / 4 jumping
              5 failed / 6 waiting / 7 running / 8 review

输入目录约定：
  <render_root>/row0/*.png  row1/ ... row8/
  或者扁平结构 <render_root>/*.png 按前缀 00_ 01_ ... 排序

关键约束（踩过坑的）：
  1. 每行从最左格连续排列，禁止中间空帧；
  2. 未用格子必须全透明 (alpha=0)；
  3. 渲染器会把「偏暗且高饱和的青/绿/品红/蓝」（通道差 > 70）打成透明，
     所以这里要主动检查并把这类像素**报告出来**，让制作者去调材质，
     而不是默默让它消失；
  4. 每格内容尽量靠近格子中心（程序用中心 8x8 采样判非空）。

用法：
  python build_sheet.py <render_root> -o out.webp [--compress 100]
  python build_sheet.py <render_root> -o out.png  --report-only
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

FRAME_W = 192
FRAME_H = 208
COLS = 8
ROWS = 9

ROW_NAMES = [
    "idle", "running-right", "running-left", "waving", "jumping",
    "failed", "waiting", "running", "review",
]
# 参考值：Codex 规范每行帧数
ROW_REF = [6, 8, 8, 4, 5, 8, 6, 6, 6]

PNG_EXT = {".png", ".webp"}


# ---------------------------------------------------------------- 发现与排序
def collect(root: Path) -> list[list[Path | None]]:
    """返回 rows[r][c] = png 路径，固定 ROWS×COLS（缺失位 None）。

    支持两种布局：
      嵌套  <root>/row0/*.png（也接受 idle/ 0/ 00/ 等语义名）
      扁平  <root>/row0_000.png，按文件名里的行号/帧号分组
    """
    return _collect_nested(root) if _has_nested(root) else _collect_flat(root)


def _has_nested(root: Path) -> bool:
    for r in range(ROWS):
        for cand in (f"row{r}", f"{r:02d}", ROW_NAMES[r]):
            if (root / cand).is_dir():
                return True
    return False


def _collect_nested(root: Path) -> list[list[Path | None]]:
    rows: list[list[Path | None]] = [[None] * COLS for _ in range(ROWS)]

    # 先试嵌套目录
    nested_found = False
    for r in range(ROWS):
        d = None
        for cand in (f"row{r}", f"{r:02d}", ROW_NAMES[r]):
            p = root / cand
            if p.is_dir():
                d = p
                break
        if d is None:
            continue
        nested_found = True
        files = sorted(p for p in d.iterdir() if p.is_file() and p.suffix.lower() in PNG_EXT)
        for c, f in enumerate(files[:COLS]):
            rows[r][c] = f

    if nested_found:
        return rows

    # 扁平：文件名带行号，如 row0_000.png / 00-1.png / idle_01.png
    pat_row = re.compile(r"(?:row)?(\d)[_\-.]?(\d+)", re.I)
    for p in sorted(root.iterdir()):
        if not p.is_file() or p.suffix.lower() not in PNG_EXT:
            continue
        m = pat_row.search(p.stem)
        if not m:
            continue
        r, c = int(m.group(1)), int(m.group(2))
        if 0 <= r < ROWS and 0 <= c < COLS and rows[r][c] is None:
            rows[r][c] = p
    return rows


# ---------------------------------------------------------------- 规范化单帧
def fit_frame(path: Path) -> tuple[np.ndarray, dict]:
    """把任意尺寸的渲染图规范成 FRAME_W x FRAME_H 的 RGBA ndarray。

    做法：等比缩放 → 贴到正方形画布居中（保留透明）→ 缩到 208 高的格子，
    这样 192x208 的格子不会把角色拉变形。
    """
    im = Image.open(path).convert("RGBA")

    # 等比缩放进 192x192 的正方形，再纵向放到 208（上下留白给跳跃动作）
    box = max(im.size)
    sq = Image.new("RGBA", (box, box), (0, 0, 0, 0))
    sq.paste(im, ((box - im.width) // 2, (box - im.height) // 2))
    scale = FRAME_H / box
    sq = sq.resize((max(1, round(box * scale)), max(1, round(box * scale))), Image.LANCZOS)

    canvas = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
    canvas.paste(sq, ((FRAME_W - sq.width) // 2, (FRAME_H - sq.height) // 2))

    arr = np.asarray(canvas).astype(np.uint8)
    return arr, {"src_size": im.size, "pasted_size": sq.size}


# ---------------------------------------------------------------- 危险像素体检
def should_clear_guide_pixel(r: int, g: int, b: int, a: int) -> bool:
    """逐字复刻 hatch-pet-host.tsx:194-204 的 shouldClearGuidePixel。

    渲染器加载精灵表时会对每个像素跑这个判定，命中的直接清 alpha=0。
    所以我们必须在生成阶段就检出这些像素 —— 否则素材看着正常，装进桌宠
    身上会「少一块/多一块透明」。
    """
    if a < 8:
        return True
    saturated = max(r, g, b) - min(r, g, b) > 70
    if not saturated:
        return False
    return (
        (r < 95 and g > 110 and b > 110)      # 青
        or (g < 95 and r > 120 and b > 110)   # 品红/紫
        or (r < 95 and g < 110 and b > 120)   # 蓝
        or (r < 95 and g > 120 and b < 110)   # 绿
    )


def guide_color_report(arr: np.ndarray) -> dict:
    """统计「会被渲染器打成透明」的高饱和青/绿/品红/蓝像素。

    注意：这里要排除 a<8 的本来就透明的像素，否则整张图的透明背景
    都会被算成风险（渲染器对它们的处理本来就是对的）。
    """
    a = arr[:, :, 3]
    rgb = arr[:, :, :3]
    # 一次性向量化 4 条分支，避免逐像素 Python 循环（72 帧 × 40128 px 太久）
    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    sat = (np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)) > 70
    cond = (
        ((r < 95) & (g > 110) & (b > 110))
        | ((g < 95) & (r > 120) & (b > 110))
        | ((r < 95) & (g < 110) & (b > 120))
        | ((r < 95) & (g > 120) & (b < 110))
    )
    visible = a >= 8
    opaque = visible & (a > 24)
    risky = visible & sat & cond
    return {
        "visible_px": int(visible.sum()),
        "opaque_px": int(opaque.sum()),
        "risky_px": int(risky.sum()),
        "risky_pct": round(100.0 * risky.sum() / max(1, int(visible.sum())), 2),
    }


# ---------------------------------------------------------------- 主流程
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("render_root", type=Path)
    ap.add_argument("-o", "--out", type=Path, required=True)
    ap.add_argument("--compress", type=int, default=100,
                    help="webp quality; 100 = lossless")
    ap.add_argument("--report-only", action="store_true")
    args = ap.parse_args()

    rows = collect(args.render_root)
    print(f"render_root = {args.render_root}")

    sheet = Image.new("RGBA", (COLS * FRAME_W, ROWS * FRAME_H), (0, 0, 0, 0))
    report: dict = {"rows": [], "warnings": []}

    all_risky = 0
    for r in range(ROWS):
        frames = rows[r]
        present = sum(1 for f in frames if f is not None)
        idxs = [c for c, f in enumerate(frames) if f is not None]

        # 真正的「连续」判据是渲染器的判据：中心 8x8 有 alpha>0 才算非空帧。
        # 只看文件是否存在是不够的 —— 空图文件同样会破坏播放。
        center_hits: list[int] = []
        for c, f in enumerate(frames):
            if f is None:
                center_hits.append(0)
                continue
            arr, _ = fit_frame(f)
            a = arr[:, :, 3]
            cy, cx = FRAME_H // 2, FRAME_W // 2
            patch = a[cy - 4:cy + 4, cx - 4:cx + 4]
            center_hits.append(int((patch > 8).sum()))

        eff_present = sum(1 for v in center_hits if v > 0)
        eff_idxs = [c for c, v in enumerate(center_hits) if v > 0]
        contiguous = eff_idxs == list(range(len(eff_idxs)))

        row_risky = 0
        row_opaque = 0
        cells = []
        for c, f in enumerate(frames):
            if f is None:
                cells.append(0)
                continue
            arr, _ = fit_frame(f)
            rep = guide_color_report(arr)
            row_risky += rep["risky_px"]
            row_opaque += rep["opaque_px"]
            cells.append(rep["opaque_px"])
            sheet.paste(Image.fromarray(arr), (c * FRAME_W, r * FRAME_H))

        all_risky += row_risky
        row_total = sum(cells)
        ok_present = eff_present == ROW_REF[r]
        note = []
        if eff_present != present:
            note.append(f"{present - eff_present} 帧中心为空（内容偏离中心）")
        if not ok_present:
            note.append(f"有效帧数 {eff_present}，参考 {ROW_REF[r]}")
        if not contiguous:
            note.append("中间有空帧（左连续被破坏）")
        if row_total == 0:
            note.append("整行为空")
        if row_opaque and row_risky / row_opaque > 0.005:
            note.append(f"导引色风险像素 {row_risky}（{100*row_risky/row_opaque:.1f}%）")

        print(f"row {r} {ROW_NAMES[r]:<14} frames={present}/{ROW_REF[r]} "
              f"effective={eff_present} opaque={row_total:>8}  risky={row_risky:>7}  "
              f"{'OK' if not note else '| ' + ' | '.join(note)}")
        print(f"    per-cell opaque: {cells}")
        print(f"    center8x8      : {center_hits}")
        report["rows"].append({
            "row": r, "name": ROW_NAMES[r], "files": present,
            "effective_frames": eff_present, "ref": ROW_REF[r],
            "contiguous": contiguous, "opaque_total": row_total,
            "risky_px": row_risky, "per_cell_opaque": cells,
            "center8x8": center_hits, "notes": note,
        })
        if note:
            report["warnings"].extend([f"row{r}: {n}" for n in note])

    print("\n-- 汇总 --")

    if args.report_only:
        print("\n--report-only：未写出文件--")
    else:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        if args.out.suffix.lower() == ".webp":
            sheet.save(args.out, "WEBP", quality=args.compress, method=6)
        else:
            sheet.save(args.out)
        print(f"\n写出 {args.out}  ({sheet.size[0]}x{sheet.size[1]})")

    rep_path = args.out.with_suffix(args.out.suffix + ".report.json")
    report["sheet_size"] = list(sheet.size)
    report["all_risky_px"] = all_risky
    try:
        rep_path.write_text(json.dumps(report, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        print(f"报告 {rep_path}")
    except OSError as e:
        print(f"(报告写入失败: {e})")

    return 0 if not report["warnings"] else 2


if __name__ == "__main__":
    sys.exit(main())