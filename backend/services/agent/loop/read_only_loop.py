"""Code Agent 只读分析工具循环。

只读问题以前只把索引首轮命中的少量文件塞给模型；一旦关键词没有命中，模型便会错误地
声称没有上下文。本模块让只读问题也能持续调用 search/read，并且在真正使用工具前禁止
直接得出“没有项目文件”的结论。
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, cast

from backend.services.agent.loop.service_events import lifecycle, usage_packet
from backend.services.agent.shared.loop_protocol import coerce_read_paths
from backend.services.agent.shared.tool_registry import render_tool_catalog
from backend.services.agent.shared.workspace_tools import ReadBatchResult, render_workspace_tree
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage, LlmUsage
from backend.services.tools.code_tools import execute_code_tool
from backend.utils.sse import encode_sse

MAX_READ_ONLY_ITERATIONS = 12
MAX_SAME_ACTION_REPEATS = 2


def _trim(entries: list[str]) -> str:
    """把工具观察完整拼接；单次任务内不做截断或总量裁剪。"""

    return "\n\n".join(entries)


def _append_transcript(entries: list[str], entry: str) -> None:
    """追加观察；单次任务内完整保留，不做截断或总量裁剪。"""

    entries.append(str(entry or ""))


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
    if kind not in {"search", "read", "inspect", "finish"}:
        raise ValueError(f"只读 Agent 不允许动作：{kind or '空'}")
    action["action"] = kind
    return action


def _action_fingerprint(action: dict[str, Any]) -> str:
    """生成只读动作指纹，用于阻止模型重复读取同一路径。"""

    kind = str(action.get("action") or "")
    if kind == "search":
        return f"search:{str(action.get('query') or '').strip().lower()}"
    paths = action.get("paths")
    normalized = sorted(str(item).strip().lower() for item in paths or [])
    return f"{kind}:{'|'.join(normalized)}"


def _system_prompt() -> str:
    """返回只读项目分析的工具协议。"""

    return f"""你是本地代码库分析 Agent。必须根据当前项目的真实文件回答，不能凭空猜测。
你拥有以下后端受控工具：
{render_tool_catalog(read_only=True)}

每轮只返回一个 JSON 对象，不得附加 Markdown：
1. {{"action":"search","query":"文件名、业务词或符号名"}}
2. {{"action":"read","paths":["相对路径"]}}
3. {{"action":"inspect","paths":["Python 相对路径"],"query":"可选符号名"}}
4. {{"action":"finish","answer":"基于已读取文件的最终中文回答"}}

规则：
- 在 finish 前至少执行一次 search 或 read；初始索引未命中不代表项目没有文件。
- 对项目能力、架构或完整度做判断时，优先搜索并读取 package.json、README、路由、页面、状态管理、API、数据库和测试文件。
- search 直接扫描当前磁盘，能够看到索引遗漏或刚写入的文件。
- 禁止请求 .env、.env.*、私钥和凭据；工具会返回 SECURITY SKIP，收到后不得重试同一路径。
- 需要配置结构时只读 .env.example、类型定义、构建配置或源码中的环境变量名称。
- 不读取二进制文件，不越出项目根目录。
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
        f"PROJECT TREE:\n{render_workspace_tree(root, limit=800)}",
        f"INITIAL INDEX CONTEXT:\n{initial_context}",
    ]
    usage_total = LlmUsage()
    used_tool = False
    invalid_rounds = 0
    iterations = 0
    action_counts: dict[str, int] = {}

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
        iterations += 1
        if iterations > MAX_READ_ONLY_ITERATIONS:
            raise ValueError("只读 Agent 达到最大分析轮次，请缩小问题范围后重试。")
        text, usage, _model = await GATEWAY.complete(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=[
                LlmMessage("system", _system_prompt()),
                LlmMessage("user", _trim(transcript)),
            ],
            temperature=0.1,
            timeout_seconds=90,
            audit={"agentRole": "read_only"},
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
            _append_transcript(
                transcript,
                f"PROTOCOL ERROR: {exc}\n请返回合法的单动作 JSON。",
            )
            if invalid_rounds >= 3:
                raise ValueError(f"只读 Agent 连续返回无效工具协议：{exc}") from exc
            continue

        kind = str(action["action"])
        if kind != "finish":
            fingerprint = _action_fingerprint(action)
            action_counts[fingerprint] = action_counts.get(fingerprint, 0) + 1
            if action_counts[fingerprint] > MAX_SAME_ACTION_REPEATS:
                _append_transcript(
                    transcript,
                    "DUPLICATE ACTION REJECTED：该 search/read/inspect 已执行，"
                    "结果没有变化。请改用其他安全路径，或根据现有证据 finish。"
                )
                continue
        if kind == "finish":
            answer = str(action.get("answer") or action.get("summary") or "").strip()
            if not used_tool:
                _append_transcript(
                    transcript,
                    "FINISH REJECTED: 尚未使用 search/read。必须先检查真实项目文件。"
                )
                continue
            if not answer:
                _append_transcript(transcript, "FINISH REJECTED: answer 不能为空。")
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
                _append_transcript(transcript, "SEARCH ERROR: query 不能为空。")
                continue
            result = await execute_code_tool(
                "workspace.search",
                root=root,
                arguments={"query": query},
                permissions={"read"},
                agent_id="read_only_agent",
            )
            used_tool = True
            _append_transcript(
                transcript,
                f"ACTION search query={query}\nOBSERVATION:\n{result}",
            )
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

        if kind == "inspect":
            paths = coerce_read_paths(action.get("paths", action.get("path")))
            query = str(action.get("query") or "").strip()
            if not paths and not query:
                _append_transcript(
                    transcript,
                    "INSPECT ERROR: paths 或 query 至少提供一个。",
                )
                continue
            result = await execute_code_tool(
                "code.inspect",
                root=root,
                arguments={"paths": paths, "query": query},
                permissions={"read"},
                agent_id="read_only_agent",
            )
            used_tool = True
            _append_transcript(
                transcript,
                f"ACTION inspect paths={paths} query={query}\nOBSERVATION:\n{result}"
            )
            yield encode_sse(
                {
                    "type": "AGENT_LIFECYCLE",
                    "payload": lifecycle(
                        role="researcher",
                        status="running",
                        detail="已完成 AST、符号与影响分析，继续整理证据…",
                        tool_name="code_intelligence",
                    ),
                }
            )
            continue

        paths = coerce_read_paths(action.get("paths", action.get("path")))
        if not paths:
            _append_transcript(transcript, "READ ERROR: paths 必须是非空数组。")
            continue
        read_result = cast(
            ReadBatchResult,
            await execute_code_tool(
                "workspace.read",
                root=root,
                arguments={"paths": paths},
                permissions={"read"},
                agent_id="read_only_agent",
            ),
        )
        used_tool = used_tool or bool(read_result.versions)
        _append_transcript(
            transcript,
            f"ACTION read paths={paths}\nOBSERVATION:\n{read_result.content}"
        )
        yield encode_sse(
            {
                "type": "AGENT_LIFECYCLE",
                "payload": lifecycle(
                    role="researcher",
                    status="running",
                    detail=(
                        f"已读取 {len(read_result.versions)} 个安全文件；"
                        f"跳过 {len(read_result.blocked_paths)} 个敏感路径，继续分析…"
                    ),
                    tool_name="read_file_from_disk",
                ),
            }
        )
