"""标签定位测试：颜色无关（多色/白色）+ 叠放排位 + 失败场景。"""

from __future__ import annotations

import io

import pytest
from PIL import Image, ImageDraw

from backend.services.image.locate import TagBox, absolutize_columns, locate_tags


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
            {"x": 120, "y": 120, "color": (220, 30, 30)},  # 红（顶层）
            {"x": 260, "y": 120, "color": (30, 30, 220)},  # 蓝
            {"x": 400, "y": 120, "color": (220, 200, 30)},  # 黄
            {"x": 120, "y": 480, "color": (235, 235, 235), "shape": "rectangle"},  # 白（底层）
            {"x": 260, "y": 480, "color": (30, 200, 30)},  # 绿
        ]
    )
    boxes = locate_tags(image_bytes=raw)
    assert boxes is not None
    assert len(boxes) == 5
    # 层号从上到下：y=120（画面上方）应是第 1 层（row 最小），y=480 是下层。
    bottom = [box for box in boxes if box.y > 400]
    top = [box for box in boxes if box.y < 200]
    assert bottom and top
    assert all(top_box.row < box.row for box in bottom for top_box in top)
    # 同一层内列自左而右
    by_row = sorted({box.row for box in boxes})
    row1_boxes = sorted(
        (box for box in boxes if box.row == by_row[0]),
        key=lambda box: box.x,
    )
    assert [box.col for box in row1_boxes] == list(range(1, len(row1_boxes) + 1))
    assert all(isinstance(box, TagBox) for box in boxes)


def test_absolutize_columns_preserves_left_gap() -> None:
    """层内最左位空缺时，绝对列号整体右移，空位由上层回填为"空"。"""

    boxes = [
        # 第1层：x 从 100 起，说明物理第1位（x≈0）空缺
        TagBox(x=100, y=100, w=60, h=60, row=1, col=1, rank=1),
        TagBox(x=200, y=100, w=60, h=60, row=1, col=2, rank=1),
        TagBox(x=300, y=100, w=60, h=60, row=1, col=3, rank=1),
        TagBox(x=400, y=100, w=60, h=60, row=1, col=4, rank=1),
        # 第2层：x 从 0 起（第1位存在）
        TagBox(x=0, y=250, w=60, h=60, row=2, col=1, rank=1),
        TagBox(x=100, y=250, w=60, h=60, row=2, col=2, rank=1),
    ]
    absolutized = absolutize_columns(boxes)
    row1 = sorted((b for b in absolutized if b.row == 1), key=lambda b: b.col)
    row2 = sorted((b for b in absolutized if b.row == 2), key=lambda b: b.col)
    assert [b.col for b in row1] == [2, 3, 4, 5]
    assert [b.col for b in row2] == [1, 2]


def test_locate_stacked_tags_same_position(monkeypatch: pytest.MonkeyPatch) -> None:
    """同一货位叠放两个标签（相接）：同 (row, col)，rank 分别为 1、2。"""

    from backend.services.image import locate as locate_module

    monkeypatch.setattr(locate_module, "MIN_TAGS", 1)
    raw = _image_with_tags(
        [
            {"x": 200, "y": 148, "color": (220, 30, 30)},
            {"x": 200, "y": 212, "color": (30, 30, 220)},  # 同一位内上下叠放（标签间留可见缝隙）
            {"x": 450, "y": 148, "color": (220, 200, 30)},
            {"x": 450, "y": 212, "color": (30, 200, 30)},  # 第二位也叠放两个
        ]
    )
    boxes = locate_tags(image_bytes=raw)
    assert boxes is not None
    assert len(boxes) == 4
    stacked_col1 = [box for box in boxes if box.col == 1]
    assert len(stacked_col1) == 2
    ranks = sorted(box.rank for box in stacked_col1)
    assert ranks == [1, 2]
    # 排位按 y 排序：靠上的排 1
    top = sorted(stacked_col1, key=lambda box: box.y)[0]
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
