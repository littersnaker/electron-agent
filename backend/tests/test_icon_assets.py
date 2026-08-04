"""占位 PNG 图标生成与自动补齐测试。"""

from __future__ import annotations

import struct

from backend.services.agent.icon_assets import (
    backfill_placeholder_icons,
    extract_icon_paths,
    generate_placeholder_icon,
)
from backend.services.agent.loop_protocol import EditOperation
from backend.services.agent.workspace_tools import apply_edit_operations

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _png_dimensions(payload: bytes) -> tuple[int, int]:
    """从 IHDR 读取宽高。"""

    assert payload.startswith(PNG_SIGNATURE)
    width, height = struct.unpack(">II", payload[16:24])
    return width, height


def test_generates_valid_square_png(tmp_path) -> None:
    """生成的 PNG 必须是合法的正方形 RGBA 图片。"""

    target = tmp_path / "icon.png"

    assert generate_placeholder_icon(target, size=96)
    payload = target.read_bytes()

    assert payload.startswith(PNG_SIGNATURE)
    assert _png_dimensions(payload) == (96, 96)
    assert payload[24] == 8  # bit depth
    assert payload[25] == 6  # color type RGBA


def test_generation_is_deterministic(tmp_path) -> None:
    """相同参数重复生成必须得到完全一致的字节，避免重跑产生内容漂移。"""

    first = tmp_path / "a.png"
    second = tmp_path / "b.png"

    generate_placeholder_icon(first)
    generate_placeholder_icon(second)

    assert first.read_bytes() == second.read_bytes()


def test_generate_never_overwrites_existing_file(tmp_path) -> None:
    """已存在的文件不能被占位生成器覆盖。"""

    target = tmp_path / "icon.png"
    target.write_bytes(b"keep-me")

    assert not generate_placeholder_icon(target)
    assert target.read_bytes() == b"keep-me"


def test_extract_icon_paths_covers_icon_and_selected() -> None:
    """应同时识别 iconPath 与 selectedIconPath，以及 jpg 后缀。"""

    content = (
        '{"tabBar":{"list":['
        '{"iconPath":"assets/tab/home.png",'
        '"selectedIconPath":"assets/tab/home-active.jpg"}]}}'
    )

    assert extract_icon_paths(content) == [
        "assets/tab/home.png",
        "assets/tab/home-active.jpg",
    ]


def test_backfill_creates_taro_icon_under_src(tmp_path) -> None:
    """Taro app.config.ts 里的 iconPath 应在 src 下自动补齐 PNG。"""

    config = tmp_path / "src" / "app.config.ts"
    config.parent.mkdir(parents=True)
    config.write_text(
        '{"tabBar":{"list":[{"iconPath":"assets/tab/home.png"}]}}',
        "utf-8",
    )

    created = backfill_placeholder_icons(tmp_path, ["src/app.config.ts"])

    assert created == ["src/assets/tab/home.png"]
    assert (tmp_path / "src" / "assets" / "tab" / "home.png").is_file()


def test_backfill_skips_existing_icon(tmp_path) -> None:
    """图标已存在时不应重复生成或覆盖。"""

    icon = tmp_path / "src" / "assets" / "tab" / "home.png"
    icon.parent.mkdir(parents=True, exist_ok=True)
    icon.write_bytes(b"real-icon")
    config = tmp_path / "src" / "app.config.ts"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(
        '{"tabBar":{"list":[{"iconPath":"assets/tab/home.png"}]}}',
        "utf-8",
    )

    created = backfill_placeholder_icons(tmp_path, ["src/app.config.ts"])

    assert created == []
    assert icon.read_bytes() == b"real-icon"


def test_edit_hook_auto_backfills_icon(tmp_path) -> None:
    """写 app.config.ts 后，编辑执行器应自动补齐缺失的占位图标。"""

    result = apply_edit_operations(
        tmp_path,
        [
            EditOperation(
                type="write",
                path="src/app.config.ts",
                content='{"tabBar":{"list":[{"iconPath":"assets/tab/home.png"}]}}',
            )
        ],
    )

    assert "src/assets/tab/home.png" in result.changed_files
    assert (tmp_path / "src" / "assets" / "tab" / "home.png").is_file()
    assert "占位图标" in result.diff_preview
