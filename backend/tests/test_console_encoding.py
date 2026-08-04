"""Windows 开发终端 UTF-8 配置测试。"""

from __future__ import annotations

from backend.core.logging import _reconfigure_text_stream


class ReconfigurableStream:
    """记录 reconfigure 参数的最小测试流。"""

    def __init__(self) -> None:
        """初始化空调用记录。"""

        self.arguments: dict[str, object] = {}

    def reconfigure(self, **kwargs: object) -> None:
        """保存调用参数，模拟标准输出流。"""

        self.arguments = kwargs


def test_reconfigure_text_stream_uses_utf8() -> None:
    """终端流必须使用 UTF-8、替换非法字符并开启行缓冲。"""

    stream = ReconfigurableStream()
    _reconfigure_text_stream(stream)  # type: ignore[arg-type]

    assert stream.arguments == {
        "encoding": "utf-8",
        "errors": "replace",
        "line_buffering": True,
    }


def test_reconfigure_text_stream_accepts_none() -> None:
    """没有标准输出流时不应抛出异常。"""

    _reconfigure_text_stream(None)
