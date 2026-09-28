"""分镜视频合并服务。

优先使用系统 ffmpeg，找不到时回退到 imageio-ffmpeg 自带的静态二进制。
合并策略：先尝试无损 concat（-c copy）；失败时统一重编码为 H.264 + yuv420p，
避免不同分镜的编码/尺寸不一致导致黑帧或花屏。
"""

from __future__ import annotations

import asyncio
import shutil
from collections.abc import Callable
from pathlib import Path


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


def ffmpeg_supports_filter(ffmpeg_path: str, filter_name: str) -> bool:
    """探测 ffmpeg 是否编译了某个滤镜（如字幕烧录需要的 libass）。"""

    import subprocess

    try:
        result = subprocess.run(
            [ffmpeg_path, "-hide_banner", "-filters"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return filter_name in (result.stdout or "")


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
        raise RuntimeError("未找到 ffmpeg：请安装 ffmpeg 或 pip install imageio-ffmpeg")
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


async def merge_video_episode(
    video_paths: list[str],
    output_path: str,
    *,
    audio_paths: list[str | None] | None = None,
    srt_path: str | None = None,
    bgm_path: str | None = None,
    on_progress: Callable[[int, int], None] | None = None,
) -> dict[str, object]:
    """把分镜视频与其配音轨合并为完整一集，可烧字幕、混 BGM。

    三阶段：① 逐镜把 TTS 音轨复用进视频（统一重编码保证可拼接）；
    ② concat 拼接；③ 烧字幕 + 可选 BGM 混音。
    没有任何音频/字幕/BGM 需求时直接退化为 :func:`merge_videos`。
    返回 ``{"outputPath", "videoCount", "subtitleBurned", "audioClips"}``。
    """

    ffmpeg = resolve_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("未找到 ffmpeg：请安装 ffmpeg 或 pip install imageio-ffmpeg")
    audios = list(audio_paths or [])
    has_audio = any(path for path in audios)
    subtitle_supported = bool(
        srt_path and Path(srt_path).is_file() and ffmpeg_supports_filter(ffmpeg, "subtitles")
    )
    if not has_audio and not subtitle_supported and not bgm_path:
        result = await merge_videos(video_paths, output_path, on_progress=on_progress)
        return {"subtitleBurned": False, "audioClips": 0, **result}

    workdir = Path(output_path).parent
    clips: list[Path] = []
    audio_count = 0
    total = len(video_paths)
    for index, video_path in enumerate(video_paths):
        source = Path(video_path)
        if not source.is_file():
            continue
        clip = workdir / f".clip_{index:02d}.mp4"
        audio = audios[index] if index < len(audios) and audios[index] else None
        cmd = [ffmpeg, "-y", "-i", source.as_posix()]
        if audio and Path(audio).is_file():
            cmd += ["-i", audio, "-map", "0:v:0", "-map", "1:a:0"]
            audio_count += 1
        else:
            cmd += ["-map", "0:v:0"]
        cmd += [
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-c:a",
            "aac",
            "-shortest",
            clip.as_posix(),
        ]
        code, stderr = await _run(cmd)
        if code != 0 or not clip.is_file() or clip.stat().st_size == 0:
            raise RuntimeError(f"分镜 {index + 1} 音视频合成失败：{stderr}")
        clips.append(clip)
        if on_progress:
            on_progress(index + 1, total)
    if not clips:
        raise ValueError("没有可合并的视频文件")

    list_file = workdir / ".episode.concat.txt"
    list_file.write_text("\n".join(f"file '{clip.as_posix()}'" for clip in clips), encoding="utf-8")
    concat_output = workdir / ".episode.concat.mp4"
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
            concat_output.as_posix(),
        ]
    )
    if code != 0:
        raise RuntimeError(f"分镜拼接失败：{stderr}")

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    subtitle_filter = ""
    if subtitle_supported and srt_path:
        # subtitles 滤镜的路径需要转义冒号与引号（Windows 盘符场景）。
        escaped = srt_path.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
        subtitle_filter = f"subtitles='{escaped}'"

    if not subtitle_filter and not bgm_path:
        concat_output.replace(output)
        _cleanup(clips, list_file, concat_output)
        return {
            "outputPath": output.as_posix(),
            "videoCount": len(clips),
            "subtitleBurned": False,
            "audioClips": audio_count,
            "size": output.stat().st_size,
        }

    cmd = [ffmpeg, "-y", "-i", concat_output.as_posix()]
    bgm_index = -1
    if bgm_path and Path(bgm_path).is_file():
        cmd += ["-stream_loop", "-1", "-i", bgm_path]
        bgm_index = 1
    filters: list[str] = []
    video_label = "0:v"
    if subtitle_filter:
        filters.append(f"[0:v]{subtitle_filter}[vout]")
        video_label = "[vout]"
    if bgm_index >= 0:
        filters.append(f"[{bgm_index}:a]volume=0.22[bgm]")
        filters.append("[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]")
        audio_label = "[aout]"
    else:
        audio_label = "0:a"
    filter_complex = ";".join(filters)
    cmd += ["-map", video_label]
    if filters:
        cmd += ["-filter_complex", filter_complex]
    cmd += [
        "-map",
        audio_label,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "medium",
        "-c:a",
        "aac",
        "-shortest",
        output.as_posix(),
    ]
    code, stderr = await _run(cmd)
    _cleanup(clips, list_file, concat_output)
    if code != 0 or not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError(f"字幕/背景音合成失败：{stderr}")
    return {
        "outputPath": output.as_posix(),
        "videoCount": len(clips),
        "subtitleBurned": bool(subtitle_filter),
        "audioClips": audio_count,
        "size": output.stat().st_size,
    }


def _cleanup(clips: list[Path], list_file: Path, concat_output: Path) -> None:
    """清理合成过程的临时分镜与清单文件。"""

    for clip in clips:
        try:
            clip.unlink(missing_ok=True)
        except OSError:
            pass
    try:
        list_file.unlink(missing_ok=True)
    except OSError:
        pass
    try:
        concat_output.unlink(missing_ok=True)
    except OSError:
        pass


__all__ = [
    "ffmpeg_supports_filter",
    "merge_video_episode",
    "merge_videos",
    "resolve_ffmpeg",
    "resolve_ffprobe",
]
