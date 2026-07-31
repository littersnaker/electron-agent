"""Server-Sent Events（SSE）辅助函数。"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi.responses import StreamingResponse


def encode_sse(payload: dict[str, Any]) -> str:
    """把一个 Python 字典编码成浏览器可识别的 SSE 数据帧。"""

    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def encode_sse_comment(comment: str = "connected") -> str:
    """生成 SSE 注释帧，用于尽快建立连接并防止代理缓冲。"""

    return f": {comment}\n\n"


def sse_packet(event_type: str, payload: Any) -> str:
    """生成使用 ``type`` 和 ``payload`` 字段的前端兼容事件。"""

    return encode_sse({"type": event_type, "payload": payload})


def create_sse_response(stream: AsyncIterator[str]) -> StreamingResponse:
    """把异步字符串迭代器包装成 FastAPI 流式响应。"""

    return StreamingResponse(
        stream,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
