"""Code Agent 只读分析工具循环。

只读问题以前只把索引首轮命中的少量文件塞给模型；一旦关键词没有命中，模型便会错误地
声称没有上下文。本模块让只读问题也能持续调用 search/read，并且在真正使用工具前禁止
直接得出“没有项目文件”的结论。
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from backend.services.agent.service_events import lifecycle, usage_packet
from backend.services.agent.tool_registry import render_tool_catalog
from backend.services.agent.workspace_tools import (
    read_workspace_files,
    render_workspace_tree,
    search_workspace,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage, LlmUsage
from backend.utils.sse import encode_sse

MAX_READ_ONLY_TRANSCRIPT_CHARS = 220_000


def _trim(entries: list[str]) -> str:
    """从后向前保留足够的工具观察，避免长项目无限占用上下文。"""

    selected: list[str] = []
    consumed = 0
    for entry in reversed(entries):
        remaining = MAX_READ_ONLY_TRANSCRIPT_CHARS - consumed
        if remaining <= 0:
            break
        selected.append(entry[-remaining:])
        consumed += min(len(entry), remaining)
    selected.reverse()
    return "\n\n".join(selected)


def _parse_action(text: str) -> dict[str, Any]:
    """解析只读代理返回的单动作 JSON。"""

    stripped = text.strip()
    if "```" in stripped:
        parts = stripped.split("```")
        stripped = parts[1].removeprefix("json").strip() if len(parts) >= 3 else stripped
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end < start:
        raise ValueError("只读 Agent 没有返回工具 JSON")
    try:
        action = json.loads(stripped[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError(f"只读 Agent 工具 JSON 无效：{exc.msg}") from exc
    if not isinstance(action, dict):
        raise ValueError("只读 Agent 响应必须是 JSON 对象")
    kind = str(action.get("action") or "").strip().lower()
    if kind not in {"search", "read", "finish"}:
        raise ValueError(f"只读 Agent 不允许动作：{kind or '空'}")
    action["action"] = kind
    return action


def _system_prompt() -> str:
    """返回只读项目分析的工具协议。"""

    return f"""你是本地代码库分析 Agent。必须根据当前项目的真实文件回答，不能凭空猜测。
你拥有以下后端受控工具：
{render_tool_catalog(read_only=True)}

每轮只返回一个 JSON 对象，不得附加 Markdown：
1. {{"action":"search","query":"文件名、业务词或符号名"}}
2. {{"action":"read","paths":["相对路径"]}}
3. {{"action":"finish","answer":"基于已读取文件的最终中文回答"}}

规则：
- 在 finish 前至少执行一次 search 或 read；初始索引未命中不代表项目没有文件。
- 对项目能力、架构或完整度做判断时，优先搜索并读取 package.json、README、路由、页面、状态管理、API、数据库和测试文件。
- search 直接扫描当前磁盘，能够看到索引遗漏或刚写入的文件。
- 不读取 .env、密钥、二进制文件，不越出项目根目录。
- 最终回答先给结论，再列证据文件路径、已有能力、缺口与建议；不要声称读过未提供的文件。
"""


async def stream_read_only_tool_answer(
    *,
    root: Path,
    user_text: str,
    initial_context: str,
    preferred_model_id: str,
    credentials: LlmCredentials,
) -> AsyncIterator[str]:
    """执行可持续搜索和读取的只读分析循环，并输出前端 SSE。"""

    transcript = [
        f"USER QUESTION:\n{user_text}",
        f"PROJECT TREE:\n{render_workspace_tree(root)}",
        f"INITIAL INDEX CONTEXT:\n{initial_context}",
    ]
    usage_total = LlmUsage()
    used_tool = False
    invalid_rounds = 0

    yield encode_sse(
        {
            "type": "AGENT_LIFECYCLE",
            "payload": lifecycle(
                role="researcher",
                status="running",
                detail="正在使用项目搜索与文件读取工具分析真实代码…",
                tool_name="search_codebase",
            ),
        }
    )

    while True:
        text, usage, _model = await GATEWAY.complete(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=[
                LlmMessage("system", _system_prompt()),
                LlmMessage("user", _trim(transcript)),
            ],
            temperature=0.1,
        )
        usage_total.prompt += usage.prompt
        usage_total.completion += usage.completion
        usage_total.total += usage.total
        yield usage_packet(
            usage_total.prompt,
            usage_total.completion,
            usage_total.total,
        )

        try:
            action = _parse_action(text)
            invalid_rounds = 0
        except ValueError as exc:
            invalid_rounds += 1
            transcript.append(f"PROTOCOL ERROR: {exc}\n请返回合法的单动作 JSON。")
            if invalid_rounds >= 3:
                raise ValueError(f"只读 Agent 连续返回无效工具协议：{exc}") from exc
            continue

        kind = str(action["action"])
        if kind == "finish":
            answer = str(action.get("answer") or action.get("summary") or "").strip()
            if not used_tool:
                transcript.append(
                    "FINISH REJECTED: 尚未使用 search/read。必须先检查真实项目文件。"
                )
                continue
            if not answer:
                transcript.append("FINISH REJECTED: answer 不能为空。")
                continue
            yield encode_sse(
                {
                    "type": "AGENT_LIFECYCLE",
                    "payload": lifecycle(
                        role="researcher",
                        status="completed",
                        detail="已根据真实搜索和读取结果完成项目分析。",
                        tool_name="read_file_from_disk",
                    ),
                }
            )
            yield encode_sse({"type": "TEXT", "content": answer})
            return

        if kind == "search":
            query = str(action.get("query") or "").strip()
            if not query:
                transcript.append("SEARCH ERROR: query 不能为空。")
                continue
            result = search_workspace(root, query)
            used_tool = True
            transcript.append(f"ACTION search query={query}\nOBSERVATION:\n{result}")
            yield encode_sse(
                {
                    "type": "AGENT_LIFECYCLE",
                    "payload": lifecycle(
                        role="search_agent",
                        status="completed",
                        detail=f"已直接搜索磁盘：{query[:120]}",
                        tool_name="search_codebase",
                    ),
                }
            )
            continue

        raw_paths = action.get("paths")
        paths = (
            list(dict.fromkeys(str(item).strip() for item in raw_paths if str(item).strip()))
            if isinstance(raw_paths, list)
            else []
        )
        if not paths:
            transcript.append("READ ERROR: paths 必须是非空数组。")
            continue
        result = read_workspace_files(root, paths)
        used_tool = True
        transcript.append(f"ACTION read paths={paths}\nOBSERVATION:\n{result}")
        yield encode_sse(
            {
                "type": "AGENT_LIFECYCLE",
                "payload": lifecycle(
                    role="researcher",
                    status="running",
                    detail=f"已读取 {len(paths)} 个项目文件，继续分析…",
                    tool_name="read_file_from_disk",
                ),
            }
        )
