"""Spill 策略：超过阈值的大输出替换为定位符 + 按工具分策略的预览。

read 给头部（文件开头信息量最大）、run/run_code 给尾部（报错和结果都在最后）、
search/inspect 给头部命中片段。模型据此决定要不要 read 取回全文。
"""

from __future__ import annotations

import os

from backend.services.agent.spill.spill_store import SpillStore

DEFAULT_SPILL_THRESHOLD_BYTES = 8 * 1024
PREVIEW_CHARS = 4_000
_PREVIEW_LINES = 200

# 输出以尾部最有信息量的工具：报错/结果都在最后，给尾预览。
_TAIL_PREVIEW_TOOLS = {"run", "run_code", "test", "build", "typecheck", "lint"}


def _spill_threshold() -> int:
    """读取阈值环境变量；0 表示关闭 spill。"""

    raw = os.getenv("CODE_AGENT_SPILL_THRESHOLD_BYTES", "").strip()
    if not raw:
        return DEFAULT_SPILL_THRESHOLD_BYTES
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_SPILL_THRESHOLD_BYTES
    return max(0, value)


def _preview(text: str, tool_name: str) -> str:
    """按工具类型取头部或尾部预览，附行号区间帮助模型判断。"""

    lines = text.splitlines()
    total = len(lines)
    if tool_name in _TAIL_PREVIEW_TOOLS and total > _PREVIEW_LINES:
        tail = lines[-_PREVIEW_LINES:]
        preview = "\n".join(tail)
        return (
            f"---- 预览（最后 {_PREVIEW_LINES} 行 / 共 {total} 行，"
            f"行 {max(1, total - _PREVIEW_LINES + 1)}-{total}）----\n{preview}"
        )
    preview = "\n".join(lines[:_PREVIEW_LINES])
    if total > _PREVIEW_LINES:
        preview = f"{preview}\n…（共 {total} 行，仅预览前 {_PREVIEW_LINES} 行）"
    return f"---- 预览（前 {_PREVIEW_LINES} 行 / 共 {total} 行）----\n{preview}"


def maybe_spill_result(
    store: SpillStore,
    *,
    session_id: str,
    tool_name: str,
    text: str,
) -> str:
    """超阈值的大输出替换为 spill 定位符；小输出原样返回。"""

    content = str(text or "")
    threshold = _spill_threshold()
    if threshold <= 0 or len(content.encode("utf-8")) <= threshold:
        return content

    info = store.save(
        session_id=session_id,
        tool_name=tool_name,
        content=content,
    )
    preview = _preview(content, tool_name)[:PREVIEW_CHARS]

    return (
        f"[SPILLED] {tool_name} 输出较大（{info['bytes']} 字节 / {info['lines']} 行），"
        f"完整内容已落盘：{info['path']}\n"
        "如需查看完整内容，请使用 read 读取该相对路径。\n"
        f"{preview}"
    )


__all__ = ["maybe_spill_result", "DEFAULT_SPILL_THRESHOLD_BYTES"]

