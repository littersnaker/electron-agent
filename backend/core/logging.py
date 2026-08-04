"""日志和终端编码初始化模块。"""

from __future__ import annotations

import logging
import os
import sys
from typing import TextIO

from backend.core.config import get_settings


def _reconfigure_text_stream(stream: TextIO | None) -> None:
    """把可重新配置的文本流固定为 UTF-8，避免 Windows 管道输出出现中文乱码。"""

    if stream is None:
        return
    reconfigure = getattr(stream, "reconfigure", None)
    if not callable(reconfigure):
        return
    try:
        reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except (AttributeError, OSError, ValueError):
        # 某些测试流、IDE 控制台或已关闭流不允许 reconfigure；日志仍可继续使用。
        return


def configure_console_encoding() -> None:
    """统一 Python 标准输出编码，兼容 Windows Terminal、concurrently 和 Uvicorn reload。"""

    # 环境变量会被 Uvicorn 的父进程与热重载 worker 继承，确保后续新进程也使用 UTF-8。
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    _reconfigure_text_stream(sys.stdout)
    _reconfigure_text_stream(sys.stderr)


def configure_logging() -> None:
    """初始化统一日志格式。

    只显示时间、级别、模块名和消息，不记录请求头与请求正文，避免意外输出 API Key。
    """

    configure_console_encoding()
    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level, logging.INFO),
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        force=True,
    )
