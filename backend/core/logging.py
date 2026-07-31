"""日志初始化模块。"""

from __future__ import annotations

import logging

from backend.core.config import get_settings


def configure_logging() -> None:
    """初始化统一日志格式。

    只显示时间、级别、模块名和消息，不记录请求头与请求正文，避免意外输出 API Key。
    """

    settings = get_settings()
    logging.basicConfig(
        level=getattr(logging, settings.log_level, logging.INFO),
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        force=True,
    )
