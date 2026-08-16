"""颜色无关的标签定位：饱和度+灰度双通道 Otsu → 轮廓过滤 → 层/位/排位聚类。

不硬编码任何颜色：彩色标签（红/蓝/黄…）在 HSV 的 S 通道高饱和、灰黑背景低饱和，
Otsu 自动阈值统一分离；白/黑等低饱和标签由灰度通道 Otsu 兜底，两通道取并集。
定位结果的行列排位由坐标聚类确定，不依赖模型数“第几层第几位”。

定位到少于 ``IMAGE_LOCATE_MIN_TAGS`` 个标签时返回 None，由上层回退整图 GLM 路径。
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass

USE_S_CHANNEL = os.getenv("IMAGE_LOCATE_USE_S", "1").strip().lower() not in {
    "0",
    "false",
    "off",
    "no",
}
USE_GRAY_CHANNEL = os.getenv("IMAGE_LOCATE_USE_GRAY", "1").strip().lower() not in {
    "0",
    "false",
    "off",
    "no",
}
MIN_AREA_RATIO = float(os.getenv("IMAGE_LOCATE_MIN_AREA_RATIO", "0.0008"))
MAX_AREA_RATIO = float(os.getenv("IMAGE_LOCATE_MAX_AREA_RATIO", "0.05"))
MIN_ASPECT = float(os.getenv("IMAGE_LOCATE_MIN_ASPECT", "0.5"))
MAX_ASPECT = float(os.getenv("IMAGE_LOCATE_MAX_ASPECT", "2.0"))
MIN_CIRCULARITY = float(os.getenv("IMAGE_LOCATE_MIN_CIRCULARITY", "0"))
NMS_IOU_THRESHOLD = float(os.getenv("IMAGE_LOCATE_NMS_IOU", "0.5"))
# 聚类阈值 = 标签中位尺寸 × 系数。同一货位内叠放/同一层并排的标签中心距
# 接近标签尺寸（相接），层板间/货位间空隙显著更大：行系数取 1.3 保证
# 叠放（≈1.0×）并组、层板（≥1.5×）分割；列系数取 1.2 让叠放（x 距 0）
# 并位、相邻货位（间距 >1.2×）分开。不同照片可用 env 微调。
ROW_GAP_FACTOR = float(os.getenv("IMAGE_LOCATE_ROW_GAP", "1.3"))
COL_GAP_FACTOR = float(os.getenv("IMAGE_LOCATE_COL_GAP", "1.2"))
MIN_TAGS = int(os.getenv("IMAGE_LOCATE_MIN_TAGS", "5"))
PADDING_FACTOR = float(os.getenv("IMAGE_LOCATE_PADDING", "0.06"))
# Otsu 阈值过低说明该通道几乎没有前景可分（如纯背景 S 通道全 0），跳过。
# 真实照片中 S/灰度 Otsu 阈值通常几十，这里只拦截接近 0 的纯背景通道。
_MIN_OTSU_THRESHOLD = 4


@dataclass(frozen=True, slots=True)
class TagBox:
    """定位到的一个标签及其推导出的行列排位。"""

    x: int
    y: int
    w: int
    h: int
    row: int = 1
    col: int = 1
    rank: int = 1

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2


def locate_tags(*, image_bytes: bytes) -> list[TagBox] | None:
    """定位照片中的标签并推导层/位/排位；标签过少返回 None（交由整图路径兜底）。"""

    try:
        import cv2
        import numpy as np
    except ImportError as exc:  # pragma: no cover - 构建环境必带 OpenCV
        raise RuntimeError("标签定位依赖 OpenCV 未安装。") from exc

    image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        return None
    height, width = image.shape[:2]
    if height == 0 or width == 0:
        return None

    binary_masks: list = []
    if USE_S_CHANNEL:
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        threshold, binary = cv2.threshold(
            hsv[:, :, 1], 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
        )
        if threshold > _MIN_OTSU_THRESHOLD:
            binary_masks.append(binary)
    if USE_GRAY_CHANNEL:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        threshold, binary = cv2.threshold(
            gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
        )
        if threshold > _MIN_OTSU_THRESHOLD:
            binary_masks.append(binary)
    if not binary_masks:
        return None

    combined = binary_masks[0]
    for binary in binary_masks[1:]:
        combined = cv2.bitwise_or(combined, binary)
    # 小核形态学：只去孤立噪点，不把叠放货物上相邻标签的缝隙粘连。
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel)
    combined = cv2.morphologyEx(combined, cv2.MORPH_OPEN, kernel)

    contours, _ = cv2.findContours(
        combined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    total_pixels = width * height
    min_area = MIN_AREA_RATIO * total_pixels
    max_area = MAX_AREA_RATIO * total_pixels
    boxes: list[tuple[int, int, int, int]] = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < min_area or area > max_area:
            continue
        x, y, w, h = cv2.boundingRect(contour)
        aspect = w / h if h > 0 else 0.0
        if aspect < MIN_ASPECT or aspect > MAX_ASPECT:
            continue
        if MIN_CIRCULARITY > 0:
            perimeter = cv2.arcLength(contour, True)
            circularity = (
                4 * math.pi * area / (perimeter * perimeter) if perimeter > 0 else 0.0
            )
            if circularity < MIN_CIRCULARITY:
                continue
        boxes.append((x, y, w, h))

    kept = _non_max_suppression(boxes)
    if len(kept) < MIN_TAGS:
        return None
    padded = [_pad(box, height, width) for box in kept]
    return _assign_grid(padded)


def _non_max_suppression(
    boxes: list[tuple[int, int, int, int]],
) -> list[tuple[int, int, int, int]]:
    """按面积降序保留互不重叠（IoU 低于阈值）的候选框。"""

    ordered = sorted(boxes, key=lambda box: box[2] * box[3], reverse=True)
    kept: list[tuple[int, int, int, int]] = []
    for box in ordered:
        if any(_iou(box, existing) > NMS_IOU_THRESHOLD for existing in kept):
            continue
        kept.append(box)
    return kept


def _iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax0, ay0, aw, ah = a
    bx0, by0, bw, bh = b
    inter_w = max(0, min(ax0 + aw, bx0 + bw) - max(ax0, bx0))
    inter_h = max(0, min(ay0 + ah, by0 + bh) - max(ay0, by0))
    inter = inter_w * inter_h
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def _pad(
    box: tuple[int, int, int, int], height: int, width: int
) -> tuple[int, int, int, int]:
    """给裁剪框加少量外边距，避免裁到标签边缘，并限制在图内。"""

    x, y, w, h = box
    pad_x = max(1, int(w * PADDING_FACTOR))
    pad_y = max(1, int(h * PADDING_FACTOR))
    x0 = max(0, x - pad_x)
    y0 = max(0, y - pad_y)
    x1 = min(width, x + w + pad_x)
    y1 = min(height, y + h + pad_y)
    return x0, y0, x1 - x0, y1 - y0


def _assign_grid(
    boxes: list[tuple[int, int, int, int]],
) -> list[TagBox]:
    """按坐标三层聚类：y 分层（层板间隙）→ 行内 x 分位 → 桶内 y 排序得排位。

    - 聚类阈值基于标签中位尺寸：同一货位内叠放/同一层并排标签的中心距
      接近标签尺寸，层板间/货位间的空隙显著更大，固定阈值即可稳定分割，
      不采用自适应中位数（稀疏布局下单个大空隙会污染中位数）。
    - 同一 (层,位) 桶内多个标签按 y 排序得到排位（垂直叠放，靠上为排 1）。
    - 层号从下到上：照片最下面（y 最大）为第 1 层，符合货架惯例。
    """

    heights = sorted(box[3] for box in boxes)
    widths = sorted(box[2] for box in boxes)
    median_h = heights[len(heights) // 2]
    median_w = widths[len(widths) // 2]
    row_gap = max(8.0, median_h * ROW_GAP_FACTOR)
    col_gap = max(8.0, median_w * COL_GAP_FACTOR)

    ordered = sorted(boxes, key=lambda box: box[1] + box[3] / 2)
    rows: list[list[tuple[int, int, int, int]]] = []
    current: list[tuple[int, int, int, int]] = []
    previous_cy: float | None = None
    for box in ordered:
        cy = box[1] + box[3] / 2
        if previous_cy is None or cy - previous_cy <= row_gap:
            current.append(box)
        else:
            rows.append(current)
            current = [box]
        previous_cy = cy
    if current:
        rows.append(current)

    # 层号从下到上：最下面（y 最大的行）为第 1 层。
    row_count = len(rows)
    tagged: list[TagBox] = []
    for row_index, row_boxes in enumerate(rows):
        row_boxes = sorted(row_boxes, key=lambda box: box[0] + box[2] / 2)
        columns: list[list[tuple[int, int, int, int]]] = []
        current_column: list[tuple[int, int, int, int]] = []
        previous_cx: float | None = None
        for box in row_boxes:
            cx = box[0] + box[2] / 2
            if previous_cx is None or cx - previous_cx <= col_gap:
                current_column.append(box)
            else:
                columns.append(current_column)
                current_column = [box]
            previous_cx = cx
        if current_column:
            columns.append(current_column)
        for col_index, column_boxes in enumerate(columns, start=1):
            column_boxes = sorted(column_boxes, key=lambda box: box[1])
            for rank, box in enumerate(column_boxes, start=1):
                tagged.append(
                    TagBox(
                        x=box[0],
                        y=box[1],
                        w=box[2],
                        h=box[3],
                        row=row_count - row_index,
                        col=col_index,
                        rank=rank,
                    )
                )
    return tagged


__all__ = ["TagBox", "locate_tags"]
