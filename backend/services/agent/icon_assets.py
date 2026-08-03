"""确定性占位图标生成器（纯 Python 标准库，无 Pillow 依赖）。

Taro / 微信小程序的 tabBar ``iconPath`` 只接受 PNG 位图；Code Agent 只有文本工具，
模型可以写出引用路径但无法直接产出位图。此模块在每次编辑后扫描被修改文件中的
``iconPath`` 引用，为缺失的 PNG 生成简单的品牌色占位图标，保证引用不悬空、构建可过。

生成结果完全确定（固定尺寸、固定颜色、固定压缩），重跑不会产生内容漂移；
已存在的文件永远不会被覆盖，避免误伤用户后来替换的真实图标。
"""

from __future__ import annotations

import os
import re
import struct
import zlib
from pathlib import Path

from backend.utils.paths import is_build_output_path, resolve_inside


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    """读取整数环境变量并限制在安全区间。"""

    try:
        value = int(os.getenv(name, str(default)).strip())
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))


def _env_color(name: str, default: tuple[int, int, int]) -> tuple[int, int, int]:
    """读取 #RRGGBB 形式的环境变量颜色。"""

    raw = os.getenv(name, "").strip().lstrip("#")
    if len(raw) != 6:
        return default
    try:
        return tuple(int(raw[index : index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]
    except ValueError:
        return default


PLACEHOLDER_ICON_SIZE = _env_int("CODE_AGENT_ICON_SIZE", 96, 16, 512)
PLACEHOLDER_ICON_COLOR = _env_color("CODE_AGENT_ICON_COLOR", (76, 111, 255))
PLACEHOLDER_ICON_ACCENT = _env_color("CODE_AGENT_ICON_ACCENT", (255, 255, 255))

_ICON_PATH_PATTERN = re.compile(
    r"""iconPath["']?\s*[:=]\s*["']([^"']+?\.(?:png|jpe?g))["']""",
    re.IGNORECASE,
)


def _png_chunk(chunk_type: bytes, payload: bytes) -> bytes:
    """构造一个 PNG chunk（长度 + 类型 + 数据 + CRC）。"""

    return (
        struct.pack(">I", len(payload))
        + chunk_type
        + payload
        + struct.pack(">I", zlib.crc32(chunk_type + payload) & 0xFFFFFFFF)
    )


def _placeholder_rgba(
    size: int,
    color: tuple[int, int, int],
    accent: tuple[int, int, int],
) -> bytes:
    """生成透明背景、居中实心圆 + 白色内圆的 RGBA 像素数据。"""

    center = (size - 1) / 2.0
    outer = size * 0.42
    inner = size * 0.18
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # PNG filter: None
        dy = y - center
        for x in range(size):
            dx = x - center
            distance = (dx * dx + dy * dy) ** 0.5
            if distance <= inner:
                rows.extend(accent)
                rows.append(255)
            elif distance <= outer:
                rows.extend(color)
                rows.append(255)
            else:
                rows.extend((0, 0, 0, 0))
    return bytes(rows)


def generate_placeholder_icon(
    target: Path,
    *,
    size: int = PLACEHOLDER_ICON_SIZE,
    color: tuple[int, int, int] = PLACEHOLDER_ICON_COLOR,
    accent: tuple[int, int, int] = PLACEHOLDER_ICON_ACCENT,
) -> bool:
    """把占位 PNG 写入 target；已存在则跳过，绝不覆盖真实图标。"""

    target = target.resolve()
    if target.exists():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    size = max(16, min(512, int(size)))
    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    payload = _placeholder_rgba(size, color, accent)
    png_bytes = (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(payload, level=9))
        + _png_chunk(b"IEND", b"")
    )
    target.write_bytes(png_bytes)
    return True


def extract_icon_paths(content: str) -> list[str]:
    """从 app.config / app.json 文本中提取 tabBar 图标引用路径。"""

    return [str(match.group(1)).strip() for match in _ICON_PATH_PATTERN.finditer(content)]


def _icon_candidates(root: Path, changed_file: Path, icon_path: str) -> list[str]:
    """按 Taro / 微信约定生成候选落盘相对路径。

    Taro：tabBar ``iconPath`` 相对 ``src`` 目录（app.config.ts 所在目录）；
    微信原生：相对小程序根目录（app.json 所在目录即根目录）。
    已带 ``src/`` 前缀的路径按根目录解析；其余按配置文件所在目录优先，
    再回退到项目根目录，保证两种约定都能覆盖。
    """

    clean = icon_path.replace("\\", "/").lstrip("./").strip("/")
    if not clean or is_build_output_path(clean):
        return []
    try:
        parent_relative = (changed_file.parent / clean).relative_to(root).as_posix()
    except ValueError:
        parent_relative = ""
    under_src = "src" in changed_file.parent.parts
    if clean.startswith("src/"):
        return [clean] if clean == parent_relative else [clean, parent_relative]
    if under_src:
        return [parent_relative, clean] if parent_relative else [clean]
    return [clean]


def backfill_placeholder_icons(root: Path, changed_files: list[str]) -> list[str]:
    """扫描被修改文件中的 iconPath 引用，为缺失的 PNG 生成占位图标。

    返回实际创建的相对路径；只要任一候选位置已存在同名文件就跳过，
    避免生成重复占位或覆盖真实图标。
    """

    created: list[str] = []
    root = Path(root).resolve()
    for relative in changed_files:
        try:
            source = resolve_inside(root, relative)
        except ValueError:
            continue
        if not source.is_file():
            continue
        try:
            content = source.read_text("utf-8", errors="replace")
        except OSError:
            continue
        for icon_path in extract_icon_paths(content):
            candidates: list[Path] = []
            for candidate_relative in _icon_candidates(root, source, icon_path):
                try:
                    candidates.append(resolve_inside(root, candidate_relative))
                except ValueError:
                    continue
            if any(candidate.exists() for candidate in candidates):
                # 已有真实图标，不重复生成。
                continue
            for candidate in candidates:
                try:
                    if generate_placeholder_icon(candidate):
                        created.append(candidate.relative_to(root).as_posix())
                        break
                except OSError:
                    continue
    return list(dict.fromkeys(created))


__all__ = [
    "PLACEHOLDER_ICON_COLOR",
    "PLACEHOLDER_ICON_SIZE",
    "backfill_placeholder_icons",
    "extract_icon_paths",
    "generate_placeholder_icon",
]
