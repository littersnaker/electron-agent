"""图片识别 Agent 的共享数据模型。"""

from __future__ import annotations

from dataclasses import dataclass, field

# 不确定标记：GLM 表达"看不清/不确定"时，该位置的编号不可信。
# 坐标仍要保留为占位（sheet_no 为空），前端/Excel 才能渲染出"空"格。
UNCERTAIN_MARKERS = ("无法辨认", "不确定", "模糊", "看不清", "?", "？", "未知")


@dataclass(frozen=True, slots=True)
class SheetRecognition:
    """货架识别结果中的单个图纸编号，携带三维货架坐标。

    - ``layer``：货架层号（1 = 最上层，从上到下）
    - ``position``：层内货位序号（1 = 最左，从左到右）
    - ``stack``：同一货位内叠放排号（1 = 最上，照片中最上面的图纸）
    - ``sheet_no``：图纸编号；空字符串表示"位置存在但编号无法辨认"（占位行），
      网格渲染为"空"，让用户知道该位置没读出来而不是不存在。
    """

    sheet_no: str
    layer: int = 1
    position: int = 1
    stack: int = 1
    source_image: str = ""
    note: str = ""


@dataclass(frozen=True, slots=True)
class ImageRecognitionFailure:
    """单张照片识别失败记录（降级不中断，成功张结果全部保留）。

    ``kind`` 区分失败性质，供前端展示正确引导：
    - ``rate_limited``：免费模型 429 限流，属于临时状态，稍后重试即可；
    - ``quality``：照片本身问题（预处理失败、无法辨认等），需要重拍；
    - ``other``：其他运行时错误。
    """

    image_name: str
    reason: str
    kind: str = "quality"

    def to_json(self) -> dict[str, str]:
        return {
            "imageName": self.image_name,
            "reason": self.reason,
            "kind": self.kind,
        }


def build_layers(rows: list[SheetRecognition]) -> list[dict[str, object]]:
    """把识别行组装成按层分组的货架网格。

    每个层输出 ``maxStack × maxPosition`` 的 cells 二维数组
    （``cells[stack-1][position-1]``）；格子为 ``None`` 表示没有该位置的数据，
    sheetNo 为空的格子表示"位置存在但编号无法辨认"（占位，前端渲染为"空"）。
    占位行同样参与 maxStack/maxPosition 计算，保证没读出来的位置在网格里可见。
    """

    layers_map: dict[int, list[SheetRecognition]] = {}
    for row in rows:
        layers_map.setdefault(row.layer, []).append(row)

    layers: list[dict[str, object]] = []
    for layer in sorted(layers_map):
        layer_rows = layers_map[layer]
        max_stack = max(item.stack for item in layer_rows)
        max_position = max(item.position for item in layer_rows)
        cells: list[list[dict[str, str] | None]] = [
            [None] * max_position for _ in range(max_stack)
        ]
        for item in layer_rows:
            cells[item.stack - 1][item.position - 1] = {
                "sheetNo": item.sheet_no,
                "sourceImage": item.source_image,
                "note": item.note,
            }
        layers.append(
            {
                "layer": layer,
                "maxStack": max_stack,
                "maxPosition": max_position,
                "cells": cells,
            }
        )
    return layers


def backfill_empty_slots(rows: list[SheetRecognition]) -> list[SheetRecognition]:
    """为定位路径回填"空货位"占位行，保留完整物理布局。

    定位路径把列号扩展成绝对货位号后，同一层同一排内 1..max_col 之间缺失的
    列说明该货位没有标签（空货位或漏检），这里补上 ``sheet_no`` 为空的占位行
    （note="空货位"），前端/Excel 渲染为"空"；空货位不是识别失败，不进入失败清单。
    位号超过安全上限（定位估计异常时）的层直接跳过回填，避免撑爆网格。
    """

    max_backfill_col = 40
    by_layer: dict[int, dict[int, set[int]]] = {}
    for item in rows:
        by_layer.setdefault(item.layer, {}).setdefault(item.stack, set()).add(
            item.position
        )
    result = list(rows)
    for layer, stacks in by_layer.items():
        for stack, positions in stacks.items():
            max_col = max(positions)
            if max_col > max_backfill_col:
                continue
            for position in range(1, max_col + 1):
                if position in positions:
                    continue
                result.append(
                    SheetRecognition(
                        sheet_no="",
                        layer=layer,
                        position=position,
                        stack=stack,
                        source_image="",
                        note="空货位",
                    )
                )
    return result


@dataclass(slots=True)
class RecognitionOutcome:
    """一次图片识别会话的完整结果。"""

    rows: list[SheetRecognition] = field(default_factory=list)
    failures: list[ImageRecognitionFailure] = field(default_factory=list)
    summary: str = ""
    excel_file_name: str = ""
    excel_download_url: str = ""

    def to_json(self) -> dict[str, object]:
        return {
            "layers": build_layers(self.rows),
            "failures": [item.to_json() for item in self.failures],
            "summary": self.summary,
            "excelFileName": self.excel_file_name,
            "excelDownloadUrl": self.excel_download_url,
        }


__all__ = [
    "ImageRecognitionFailure",
    "RecognitionOutcome",
    "SheetRecognition",
    "backfill_empty_slots",
    "build_layers",
]
