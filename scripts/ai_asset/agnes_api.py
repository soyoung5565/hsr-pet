"""Agnes AI API 封装（图 + 视频），供 AI 素材流水线调用。

为什么单独一层:
  - Agnes 的视频接口是**异步 + 队列制**，队列满会返回 503 video_queue_full。
    直接在业务脚本里 retry 会到处散落，这里统一处理。
  - 视频 v2.0 已于 2026-09-25 下线，模型名/参数全变了：
      旧: model=agnes-video-v2.0, body.image, num_frames, frame_rate
      新: model=agnes-video-2.5, mode=text|keyframe|reference,
          seconds(字符串), size(720P/1080P/1K/2K), aspect_ratio,
          keyframe 模式用 first_frame / last_frame
    旧参数现在会直接报 "num_frames is a forbidden field" / "mode is required"。
  - 轮询地址也变了：GET /agnesapi?video_id=<id>&model_name=<model>
    （少了 model_name 只在 text 模式有效）

实测坑（2026-10-24）:
  - `GET /v1/models` 返回的 id 才是当前可用模型；
    `agnes-video-v2.0` 不在其中，会报 "temporarily unavailable"。
  - 图片接口**不能**带 response_format（否则 400）。
  - 视频提交成功 ≠ 立刻可下载，要轮询 status。
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

BASE_URL = "https://apihub.agnes-ai.com/v1"

IMAGE_MODEL = "agnes-image-2.1-flash"
VIDEO_MODEL = "agnes-video-2.5"


def load_api_key(env_path: str | Path = r"D:\hermes-data\.env") -> str:
    """从 .env 里读 AGNES_API_KEY（不打印明文）。"""
    text = Path(env_path).read_text(encoding="utf-8", errors="replace")
    m = re.search(r"^AGNES_API_KEY=(.*)$", text, re.M)
    if not m:
        raise RuntimeError(f"在 {env_path} 里找不到 AGNES_API_KEY")
    return m.group(1).strip().strip('"').strip("'")


def _request(
    url: str,
    method: str = "GET",
    body: dict | None = None,
    timeout: int = 120,
) -> tuple[int, dict | str]:
    """返回 (status, parsed_json_or_raw_text)。网络错误会抛。"""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "Authorization": f"Bearer {os.environ.get('_AGNES_KEY', '')}",
        "Content-Type": "application/json",
        "User-Agent": "hsr-pet-asset-pipeline/1.0",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            code = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        code = e.code
    try:
        return code, json.loads(raw)
    except json.JSONDecodeError:
        return code, raw


def _is_queue_full(payload) -> bool:
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return "video_queue_full" in text or "temporarily unavailable" in text


def _is_retryable(code: int, payload) -> bool:
    if code in (429, 500, 502, 503, 504):
        return True
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return "queue_full" in text or "temporarily unavailable" in text or "bad gateway" in text.lower()


# --------------------------------------------------------------------- 图片

def generate_image(
    prompt: str,
    size: str = "1024x1024",
    *,
    key: str,
    attempts: int = 4,
    timeout: int = 120,
) -> str:
    """文生图，返回图片 URL。

    ⚠ 绝不能加 response_format —— Agnes 会 400。
    """
    os.environ["_AGNES_KEY"] = key
    body = {"model": IMAGE_MODEL, "prompt": prompt, "size": size}
    last = ""
    for i in range(attempts):
        code, payload = _request(f"{BASE_URL}/images/generations", "POST", body, timeout)
        if code == 200 and isinstance(payload, dict):
            url = (payload.get("data") or [{}])[0].get("url")
            if url:
                return url
            last = f"200 但没返回 url: {payload}"
        else:
            last = f"HTTP {code}: {payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)[:300]}"
        if not _is_retryable(code, payload):
            break
        time.sleep(min(30, 5 * (2**i)))
    raise RuntimeError(f"图片生成失败: {last}")


def download(url: str, dest: Path, *, timeout: int = 180) -> Path:
    """下载远程文件到 dest。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "hsr-pet-asset-pipeline/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    dest.write_bytes(data)
    return dest


# --------------------------------------------------------------------- 视频

@dataclass
class VideoTask:
    row: str
    prompt: str
    video_id: str = ""
    task_id: str = ""
    status: str = "pending"
    url: str = ""
    error: str = ""
    submitted_at: float = 0.0
    attempts: int = 0
    meta: dict = field(default_factory=dict)


def submit_video(
    task: VideoTask,
    first_frame: str,
    *,
    key: str,
    model: str = VIDEO_MODEL,
    seconds: str = "5",
    size: str = "720P",
    aspect_ratio: str = "16:9",
    attempts: int = 8,
    timeout: int = 150,
) -> VideoTask:
    """提交视频任务（keyframe 模式，锁定首帧）。

    队列满会返回 503 → 指数退避重试。这里**只负责提交**，
    提交成功的任务由 poll_video 统一轮询（并行提交更快）。
    """
    os.environ["_AGNES_KEY"] = key
    body = {
        "model": model,
        "mode": "keyframe",
        "seconds": seconds,
        "size": size,
        "aspect_ratio": aspect_ratio,
        "first_frame": first_frame,
        "prompt": task.prompt,
    }
    last = ""
    for i in range(attempts):
        task.attempts += 1
        code, payload = _request(f"{BASE_URL}/videos", "POST", body, timeout)
        if code == 200 and isinstance(payload, dict) and payload.get("video_id"):
            task.video_id = payload["video_id"]
            task.task_id = payload.get("task_id") or payload.get("id") or ""
            task.status = payload.get("status", "queued")
            task.submitted_at = time.time()
            task.meta = {"seconds": payload.get("seconds"), "size": payload.get("size")}
            return task
        last = f"HTTP {code}: {payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)[:300]}"
        if not _is_retryable(code, payload):
            break
        wait = min(90, 8 * (2**i))
        print(f"    [queue] {task.row} 第{i+1}次被拒，等待 {wait}s 重试", flush=True)
        time.sleep(wait)
    task.error = last
    task.status = "failed"
    return task


def poll_video(
    task: VideoTask,
    *,
    key: str,
    model: str = VIDEO_MODEL,
    timeout_sec: int = 1800,
    interval: int = 4,
) -> VideoTask:
    """轮询单个任务直到 completed / failed。"""
    os.environ["_AGNES_KEY"] = key
    url = f"{BASE_URL}/../agnesapi?video_id={task.video_id}&model_name={model}"
    url = f"https://apihub.agnes-ai.com/agnesapi?video_id={task.video_id}&model_name={model}"
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        code, payload = _request(url, "GET", None, 60)
        if code == 200 and isinstance(payload, dict):
            st = payload.get("status") or payload.get("internal_status")
            task.status = st or task.status
            if st in ("completed", "succeeded"):
                # 官方文档：结果 URL 在 url 字段（旧版是 remixed_from_video_id）
                task.url = (
                    payload.get("url")
                    or payload.get("remixed_from_video_id")
                    or payload.get("video_url")
                    or ""
                )
                if not task.url:
                    task.error = f"completed 但没拿到 url: {json.dumps(payload, ensure_ascii=False)[:300]}"
                    task.status = "failed"
                return task
            if st == "failed":
                task.error = json.dumps(payload.get("error") or payload, ensure_ascii=False)[:300]
                return task
        else:
            task.error = f"poll HTTP {code}: {str(payload)[:200]}"
        time.sleep(interval)
    task.error = task.error or "轮询超时"
    task.status = "failed"
    return task


def list_models(key: str) -> list[str]:
    """当前可用模型 id 列表（用于自检，别硬编码模型名）。"""
    os.environ["_AGNES_KEY"] = key
    code, payload = _request(f"{BASE_URL}/models", "GET", None, 60)
    if code == 200 and isinstance(payload, dict):
        return [m.get("id", "") for m in payload.get("data", [])]
    return []
