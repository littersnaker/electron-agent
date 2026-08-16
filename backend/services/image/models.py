"""图片识别 Agent 的共享数据模型。"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class SheetRecognition:
    """货架识别结果中的一行：某个图纸编号的位置。"""

    sheet_no: str
    row: str
    col: str
    source_image: str
    note: str = ""

    def to_json(self) -> dict[str, str]:
        """转换为前端可消费的 JSON。"""

        return {
            "sheetNo": self.sheet_no,
            "row": self.row,
            "col": self.col,
            "sourceImage": self.source_image,
            "note": self.note,
        }


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
            "rows": [item.to_json() for item in self.rows],
            "failures": [item.to_json() for item in self.failures],
            "summary": self.summary,
            "excelFileName": self.excel_file_name,
            "excelDownloadUrl": self.excel_download_url,
        }


__all__ = [
    "ImageRecognitionFailure",
    "RecognitionOutcome",
    "SheetRecognition",
]
