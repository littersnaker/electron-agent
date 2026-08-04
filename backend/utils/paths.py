"""文件路径安全工具。"""

from __future__ import annotations

from pathlib import Path


class UnsafePathError(ValueError):
    """表示某个文件路径越出了允许的工作区。"""


def resolve_inside(root: Path, relative_path: str) -> Path:
    """把相对路径解析为工作区内的绝对路径。

    如果路径包含 ``..``、绝对路径或符号链接逃逸，函数会抛出 ``UnsafePathError``。
    """

    clean = relative_path.replace("\\", "/").strip().lstrip("/")
    if not clean:
        raise UnsafePathError("文件路径不能为空")

    root_resolved = root.resolve()
    candidate = (root_resolved / clean).resolve()
    try:
        candidate.relative_to(root_resolved)
    except ValueError as exc:
        raise UnsafePathError(f"路径越出工作区：{relative_path}") from exc
    return candidate


def is_probably_binary(path: Path) -> bool:
    """通过读取文件前 4KB 判断文件是否更像二进制文件。"""

    try:
        sample = path.read_bytes()[:4096]
    except OSError:
        return False
    return b"\x00" in sample
