"""视频 → 透明 PNG 帧序列（绿幕抠像 + 归一化 + 抽帧）。

算法直接沿用 dsh-pet (MIT) 的两个脚本，但做了三处针对本项目的改造：

1. **抠像**：HSV 色相判定（只认绿色色相 + 饱和度/明度达标）。
   相比 chromakey 的"以绿幕中心画圈"，HSV 判定不会把角色身上的
   蓝/白/红误抠掉 —— 我们的角色是橘猫，橘色色相 ~30°，本来就不在
   绿色区间 [70,170] 内，但**白色肚皮**的低饱和区域也必须排除
   （用 SAT_MIN / VAL_MIN 兜住）。

2. **归一化**：dsh-pet 归一化到 2160×1215 (16:9)，我们归一化到
   **1536×1872 的整张精灵表画布**（8列×9行，单格 192×208），
   角色水平居中、脚底对齐到"行内地面线"。

3. **抽帧**：dsh-pet 输出 webm 视频；我们直接抽成 PNG 序列，
   因为底座只吃精灵表，不需要中间视频。

⚠ 踩过的坑：
  - ffmpeg 在 Windows 管道下要用 `-f rawvideo` 逐帧读，不能假设一次 read 拿满。
  - PIL 打开网络/内存 bytes 必须包 io.BytesIO，否则会被当文件名去 os.fsdecode。
  - numpy 的 HSV 没有现成实现，必须手写向量化版本。
"""

from __future__ import annotations

import io
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

# ---- 精灵表契约（与 docs/素材规格-hatch-pet格式.md 一致）----
FRAME_W = 192
FRAME_H = 208
COLS = 8
ROWS = 9
SHEET_W = COLS * FRAME_W   # 1536
SHEET_H = ROWS * FRAME_H   # 1872

# ---- 抠像参数（与 dsh-pet chroma_step02.py 同思路）----
GREEN_HUE_MIN = 70.0
GREEN_HUE_MAX = 170.0
HUE_FEATHER = 8.0
SAT_MIN = 0.18
VAL_MIN = 0.12

# 角色在行内的垂直位置：脚底线。留出上方空间给跳跃动作。
FEET_MARGIN_RATIO = 0.18     # 脚底距行底 18%
HEAD_MARGIN_RATIO = 0.16     # 头顶距行顶 16%（留给跳跃）
TARGET_BODY_RATIO = 0.62     # 角色身高占行高比例


def find_ffmpeg() -> str:
    """找 ffmpeg：优先 PATH，其次本机 Hermes 自带。"""
    import shutil

    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    candidates = [
        Path(r"C:\Users\MR\AppData\Local\hermes\tools"),
        Path(r"D:\hermes-data\tools"),
    ]
    for root in candidates:
        if not root.exists():
            continue
        for p in root.rglob("ffmpeg.exe"):
            return str(p)
    raise RuntimeError("找不到 ffmpeg")


def find_ffprobe() -> str:
    import shutil

    exe = shutil.which("ffprobe")
    if exe:
        return exe
    for root in [Path(r"C:\Users\MR\AppData\Local\hermes\tools"), Path(r"D:\hermes-data\tools")]:
        if not root.exists():
            continue
        for p in root.rglob("ffprobe.exe"):
            return str(p)
    raise RuntimeError("找不到 ffprobe")


def _rgb_to_hsv(arr: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """RGB(0..1) → hue(0..360), sat(0..1), val(0..1)，numpy 向量化。

    PIL 有 HSV 模式但只有整图转换，混合 alpha 时不好用，自己写一份。
    """
    r = arr[..., 0].astype(np.float32) / 255.0
    g = arr[..., 1].astype(np.float32) / 255.0
    b = arr[..., 2].astype(np.float32) / 255.0

    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    delta = mx - mn
    nz = delta > 1e-6

    with np.errstate(divide="ignore", invalid="ignore"):
        hr = 60.0 * (((g - b) / np.where(nz, delta, 1.0)) % 6.0)
        hg = 60.0 * (((b - r) / np.where(nz, delta, 1.0)) + 2.0)
        hb = 60.0 * (((r - g) / np.where(nz, delta, 1.0)) + 4.0)

    hue = np.where((mx == r) & nz, hr, np.where((mx == g) & nz, hg, np.where((mx == b) & nz, hb, 0.0)))
    sat = np.where(mx > 1e-6, delta / np.maximum(mx, 1e-6), 0.0)
    return hue, sat, mx


def extract_rgba_frames(video: Path) -> list[np.ndarray]:
    """解码视频为 RGBA 帧序列（绿幕已抠成透明）。"""
    ffmpeg = find_ffmpeg()

    # 先问视频真实尺寸
    probe = subprocess.run(
        [find_ffprobe(), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,nb_frames,r_frame_rate",
         "-of", "csv=p=0", str(video)],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    parts = probe.stdout.strip().split(",")
    if len(parts) < 2:
        raise RuntimeError(f"ffprobe 读不到视频信息: {probe.stdout!r} {probe.stderr!r}")
    w, h = int(parts[0]), int(parts[1])

    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-i", str(video),
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_size = w * h * 3
    frames: list[np.ndarray] = []
    try:
        while True:
            buf = b""
            while len(buf) < frame_size:
                chunk = p.stdout.read(frame_size - len(buf))
                if not chunk:
                    break
                buf += chunk
            if len(buf) < frame_size:
                break
            rgb = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            frames.append(_chroma_to_rgba(rgb))
    finally:
        p.stdout.close()
        p.wait()
    if not frames:
        err = p.stderr.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"没解出任何帧: {err[:400]}")
    return frames


def _chroma_to_rgba(rgb: np.ndarray) -> np.ndarray:
    """绿幕 → 透明。返回 H×W×4 的 uint8。

    色相边界做线性渐变（feather），避免边缘锯齿。
    """
    hue, sat, val = _rgb_to_hsv(rgb)
    lo = GREEN_HUE_MIN - HUE_FEATHER
    hi = GREEN_HUE_MAX + HUE_FEATHER
    in_hue = np.clip((hue - lo) / HUE_FEATHER, 0, 1) * np.clip((hi - hue) / HUE_FEATHER, 0, 1)
    is_green = (sat >= SAT_MIN) & (val >= VAL_MIN) & (hue >= lo) & (hue <= hi)
    # 中心全透明 → 边界渐变 → 非绿全不透明
    alpha = np.where(is_green, (1.0 - in_hue) * 255.0, 255.0).astype(np.uint8)
    out = np.empty((*rgb.shape[:2], 4), dtype=np.uint8)
    out[..., :3] = rgb
    out[..., 3] = alpha
    return out


def normalize_to_cell(rgba: np.ndarray) -> Image.Image:
    """把一帧规范化成 192×208 的格子图（RGBA）。

    做法（对齐 dsh-pet normalize_step03 的思路）：
      1. 裁到非透明内容 bbox
      2. 等比缩放到目标身高（占行高 62%）
      3. 水平居中；垂直按"脚底对齐到 FEET 线"放置
      4. 贴到透明格子
    """
    a = rgba[..., 3]
    ys, xs = np.where(a > 10)
    if len(xs) == 0:
        return Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))

    x1, x2 = int(xs.min()), int(xs.max()) + 1
    y1, y2 = int(ys.min()), int(ys.max()) + 1
    crop = Image.fromarray(rgba[y1:y2, x1:x2], "RGBA")

    target_h = max(1, int(round(FRAME_H * TARGET_BODY_RATIO)))
    scale = target_h / crop.height
    target_w = max(1, int(round(crop.width * scale)))
    resized = crop.resize((target_w, target_h), Image.LANCZOS)

    canvas = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
    feet_y = int(FRAME_H * (1 - FEET_MARGIN_RATIO))
    canvas.paste(resized, ((FRAME_W - target_w) // 2, feet_y - target_h), resized)
    return canvas


def pick_frames(frames: list[np.ndarray], count: int) -> list[np.ndarray]:
    """从整段视频里挑 count 帧组成循环。

    策略：**均匀取样整段**，但跳过最开头/最末尾的过渡帧
    —— 首尾通常是"回到站姿"的过渡，中间才是动作本体。
    这样避免抽到几乎相同的两帧。

    若视频帧数不足 count，就全部用上（允许重复末帧补齐）。
    """
    n = len(frames)
    if n <= count:
        out = list(frames)
        while len(out) < count:
            out.append(frames[-1])
        return out

    # 在 [8%, 92%] 区间内均匀取 count 个点
    lo = max(0, int(n * 0.08))
    hi = min(n, int(n * 0.92))
    span = hi - lo
    idxs = [lo + int(round(i * (span - 1) / max(1, count - 1))) for i in range(count)]
    return [frames[i] for i in idxs]


def write_row_frames(
    frames: list[np.ndarray],
    out_dir: Path,
    count: int,
    prefix: str = "f",
) -> list[Path]:
    """规范化并落盘 count 张 PNG，返回路径列表。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    picked = pick_frames(frames, count)
    paths: list[Path] = []
    for i, fr in enumerate(picked):
        img = normalize_to_cell(fr)
        p = out_dir / f"{prefix}{i:02d}.png"
        img.save(p)
        paths.append(p)
    return paths


def sheet_quality_report(row_dir: Path, count: int) -> dict:
    """体检一行帧：中心 8×8 非空（渲染器的判据）、bbox 连续、导引色风险。"""
    paths = sorted(row_dir.glob("*.png"))
    cells = []
    for p in paths:
        img = Image.open(p).convert("RGBA")
        a = np.asarray(img)[..., 3]
        cy, cx = FRAME_H // 2, FRAME_W // 2
        patch = a[cy - 4:cy + 4, cx - 4:cx + 4]
        center_hits = int((patch > 8).sum())
        ys, xs = np.where(a > 8)
        opaque = int((a > 8).sum())
        risky = 0
        if len(xs):
            rgb = np.asarray(img)[..., :3].astype(np.int16)
            r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
            sat = (np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)) > 70
            cond = (
                ((r < 95) & (g > 110) & (b > 110))
                | ((g < 95) & (r > 120) & (b > 110))
                | ((r < 95) & (g < 110) & (b > 120))
                | ((r < 95) & (g > 120) & (b < 110))
            )
            risky = int((sat & cond & (a > 8)).sum())
        cells.append({
            "file": p.name,
            "center_hits": center_hits,
            "opaque": opaque,
            "risky_px": risky,
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(xs) else None,
        })
    return {
        "count": len(paths),
        "expected": count,
        "cells": cells,
        "empty_frames": [c["file"] for c in cells if c["center_hits"] == 0],
        "total_risky": sum(c["risky_px"] for c in cells),
    }


def load_png_bytes(data: bytes) -> Image.Image:
    """PIL 从 bytes 打开（必须包 BytesIO，否则 PIL 会把 bytes 当文件名）。"""
    return Image.open(io.BytesIO(data)).convert("RGBA")
