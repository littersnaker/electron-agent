"""标签定位测试：颜色无关（多色/白色）+ 叠放排位 + 失败场景。"""

from __future__ import annotations

import io

import pytest
from PIL import Image, ImageDraw

from backend.services.image.locate import TagBox, locate_tags


def _make_image(
    width: int = 800,
    height: int = 600,
    background: tuple[int, int, int] = (60, 60, 62),
) -> bytes:
    image = Image.new("RGB", (width, height), background)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _draw_tag(
    draw: ImageDraw.ImageDraw,
    *,
    center: tuple[int, int],
    size: int = 60,
    color: tuple[int, int, int],
    shape: str = "ellipse",
) -> None:
    x0 = center[0] - size // 2
    y0 = center[1] - size // 2
    x1 = center[0] + size // 2
    y1 = center[1] + size // 2
    if shape == "ellipse":
        draw.ellipse([x0, y0, x1, y1], fill=color)
    else:
        draw.rectangle([x0, y0, x1, y1], fill=color)


def _image_with_tags(tags: list[dict]) -> bytes:
    image = Image.new("RGB", (800, 600), (60, 60, 62))
    draw = ImageDraw.Draw(image)
    for tag in tags:
        _draw_tag(
            draw,
            center=(tag["x"], tag["y"]),
            size=tag.get("size", 60),
            color=tag["color"],
            shape=tag.get("shape", "ellipse"),
        )
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_locate_multicolor_tags() -> None:
    """红/蓝/黄/白标签混合，全部应被定位且行列正确。"""

    raw = _image_with_tags(
        [
            {"x": 120, "y": 120, "color": (220, 30, 30)},  # 红
            {"x": 260, "y": 120, "color": (30, 30, 220)},  # 蓝
            {"x": 400, "y": 120, "color": (220, 200, 30)},  # 黄
            {"x": 120, "y": 300, "color": (235, 235, 235), "shape": "rectangle"},  # 白
            {"x": 260, "y": 300, "color": (30, 200, 30)},  # 绿
        ]
    )
    boxes = locate_tags(image_bytes=raw)
    assert boxes is not None
    assert len(boxes) == 5
    by_position = {(box.row, box.col): box for box in boxes}
    assert (1, 1) in by_position
    assert (1, 2) in by_position
    assert (1, 3) in by_position
    assert (2, 1) in by_position
    assert (2, 2) in by_position
    # 行序自上而下、列序自左而右
    assert all(isinstance(box, TagBox) for box in boxes)


def test_locate_stacked_tags_same_position(monkeypatch: pytest.MonkeyPatch) -> None:
    """同一货位叠放两个标签：同 (row, col)，rank 分别为 1、2。"""

    from backend.services.image import locate as locate_module

    monkeypatch.setattr(locate_module, "MIN_TAGS", 1)
    raw = _image_with_tags(
        [
            {"x": 200, "y": 160, "color": (220, 30, 30)},
            {"x": 200, "y": 235, "color": (30, 30, 220)},  # 同一位内紧挨下方（叠放）
            {"x": 450, "y": 150, "color": (220, 200, 30)},
        ]
    )
    boxes = locate_tags(image_bytes=raw)
    assert boxes is not None
    assert len(boxes) == 3
    stacked = [box for box in boxes if box.row == 1 and box.col == 1]
    assert len(stacked) == 2
    ranks = sorted(box.rank for box in stacked)
    assert ranks == [1, 2]
    # 排位按 y 排序：靠上的排 1
    top = sorted(stacked, key=lambda box: box.y)[0]
    assert top.rank == 1


def test_locate_empty_image_returns_none() -> None:
    """纯灰黑背景（无标签）应返回 None，触发整图回退。"""

    assert locate_tags(image_bytes=_make_image()) is None


def test_locate_plain_background_returns_none() -> None:
    """低饱和纯色背景也无标签：S 通道 Otsu 阈值过低被跳过。"""

    # 全图浅灰（低饱和），S 通道阈值接近 0 → 跳过；灰度通道也能分出标签才有用。
    raw = _make_image(background=(150, 150, 150))
    assert locate_tags(image_bytes=raw) is None


def test_locate_too_few_tags_returns_none() -> None:
    """标签数低于下限（默认 5）应返回 None，交给整图路径。"""

    raw = _image_with_tags(
        [
            {"x": 120, "y": 120, "color": (220, 30, 30)},
            {"x": 260, "y": 120, "color": (30, 30, 220)},
            {"x": 400, "y": 120, "color": (220, 200, 30)},
        ]
    )
    assert locate_tags(image_bytes=raw) is None


def test_locate_invalid_bytes_returns_none() -> None:
    assert locate_tags(image_bytes=b"not-an-image") is None
