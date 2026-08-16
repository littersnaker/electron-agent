"""图片识别 Agent 的共享数据模型。"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class SheetRecognition:
    """货架识别结果中的单个图纸编号，携带三维货架坐标。

    - ``layer``：货架层号（1 = 最下层，从下到上）
    - ``position``：层内货位序号（1 = 最左，从左到右）
    - ``stack``：同一货位内叠放排号（1 = 最下，叠放货物上下编号）
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
    （``cells[stack-1][position-1]``）；格子为 ``None`` 表示该位置
    没有识别出编号（看不清/不确定，前端渲染为空）。
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
    "build_layers",
]
