"""分镜视频合并服务。

优先使用系统 ffmpeg，找不到时回退到 imageio-ffmpeg 自带的静态二进制。
合并策略：先尝试无损 concat（-c copy）；失败时统一重编码为 H.264 + yuv420p，
避免不同分镜的编码/尺寸不一致导致黑帧或花屏。
"""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Callable


def resolve_ffmpeg() -> str | None:
    """返回可用的 ffmpeg 可执行文件路径，找不到返回 None。"""

    system = shutil.which("ffmpeg")
    if system:
        return system
    try:
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def resolve_ffprobe() -> str | None:
    """返回可用的 ffprobe 路径（仅探测视频尺寸时使用）。"""

    system = shutil.which("ffprobe")
    if system:
        return system
    try:
        import imageio_ffmpeg  # type: ignore

        return str(Path(imageio_ffmpeg.get_ffmpeg_exe()).with_name("ffprobe"))
    except Exception:
        return None


async def _run(cmd: list[str]) -> tuple[int, str]:
    """异步执行命令并返回 (exit_code, stderr 摘要)。"""

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _stdout, stderr = await process.communicate()
    return process.returncode or 0, stderr.decode("utf-8", errors="replace")[-4000:]


async def merge_videos(
    video_paths: list[str],
    output_path: str,
    *,
    on_progress: Callable[[int, int], None] | None = None,
) -> dict[str, object]:
    """把多个分镜视频按顺序合并成单个 mp4。

    video_paths: 本地视频文件路径（按分镜顺序）。
    output_path: 合并产物路径（父目录必须已存在）。
    on_progress: (当前分镜序号, 总分镜数) 进度回调。
    """

    ffmpeg = resolve_ffmpeg()
    if not ffmpeg:
        raise RuntimeError(
            "未找到 ffmpeg：请安装 ffmpeg 或 pip install imageio-ffmpeg"
        )
    sources = [Path(path) for path in video_paths]
    sources = [path for path in sources if path.is_file()]
    if not sources:
        raise ValueError("没有可合并的视频文件")

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    list_file = output.with_suffix(".concat.txt")
    lines = []
    for index, source in enumerate(sources):
        lines.append(f"file '{source.as_posix()}'")
        if on_progress:
            on_progress(index + 1, len(sources))
    list_file.write_text("\n".join(lines), encoding="utf-8")

    try:
        # 先尝试无损 concat
        code, stderr = await _run(
            [
                ffmpeg,
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                list_file.as_posix(),
                "-c",
                "copy",
                output.as_posix(),
            ]
        )
        if code == 0 and output.is_file() and output.stat().st_size > 0:
            return {
                "outputPath": output.as_posix(),
                "videoCount": len(sources),
                "strategy": "copy",
                "size": output.stat().st_size,
            }

        # 失败则统一重编码（编码/尺寸不一致时安全）
        code, stderr = await _run(
            [
                ffmpeg,
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                list_file.as_posix(),
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-preset",
                "medium",
                "-c:a",
                "aac",
                output.as_posix(),
            ]
        )
        if code != 0 or not output.is_file() or output.stat().st_size == 0:
            raise RuntimeError(f"视频合并失败：{stderr}")
        return {
            "outputPath": output.as_posix(),
            "videoCount": len(sources),
            "strategy": "reencode",
            "size": output.stat().st_size,
        }
    finally:
        if list_file.exists():
            list_file.unlink()


__all__ = ["merge_videos", "resolve_ffmpeg", "resolve_ffprobe"]
