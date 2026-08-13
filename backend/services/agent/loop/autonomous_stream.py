"""Code Agent 自主循环的 SSE 转换与最终交付格式。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from backend.core.background import spawn
from backend.schemas.chat import ChatRequest
from backend.services.agent.loop.runner import AgentLoopResult, stream_autonomous_loop
from backend.services.agent.loop.trace import TraceHandle, add_trace_event
from backend.services.agent.planner.task_planner import PreparedTask
from backend.services.llm.credentials import LlmCredentials
from backend.services.workspace.completed_works import record_completed_works
from backend.services.workspace.indexer import index_project
from backend.utils.sse import encode_sse


def _lifecycle(
    *,
    role: str,
    status: str,
    detail: str,
    iteration: int = 0,
    tool_name: str | None = None,
    agent_id: str | None = None,
    slot: int | None = None,
    current_files: list[str] | None = None,
) -> dict[str, Any]:
    """创建前端可消费的稳定生命周期事件。"""

    payload: dict[str, Any] = {
        "id": f"life_{uuid4().hex}",
        "agentId": agent_id or role,
        "role": role,
        "status": status.upper(),
        "iteration": iteration,
        "detail": detail,
        "createdAt": datetime.now(UTC).isoformat(),
    }
    if tool_name:
        payload["toolName"] = tool_name
    if current_files:
        payload["currentFiles"] = current_files
    if slot is not None:
        payload["slot"] = slot
    return payload


def _usage_packet(prompt: int, completion: int, total: int) -> str:
    """生成 Token 统计 SSE 帧。"""

    return encode_sse(
        {
            "type": "USAGE",
            "content": {
                "prompt": prompt,
                "completion": completion,
                "total": total,
                "unit": "tokens",
                "label": "Tokens",
            },
        }
    )


def _format_loop_result(result: AgentLoopResult, mode: str) -> str:
    """整理任务规格、WorkList、真实修改和验证记录。"""

    files = "\n".join(f"- `{path}`" for path in result.changed_files) or "- 没有文件变化"
    command_lines: list[str] = []
    for command in result.commands:
        if command.blocked_reason:
            status = f"已阻止：{command.blocked_reason}"
        elif command.timed_out:
            status = "超时"
        else:
            status = "通过" if command.exit_code == 0 else f"失败（退出码 {command.exit_code}）"
        command_lines.append(f"- `{command.command}`：{status}")
    if not command_lines and mode == "auto_edit":
        command_lines.append("- 自动编辑模式未执行终端命令；切换到“全自动”可自动验证。")
    commands = "\n".join(command_lines) or "- 本轮没有需要执行的验证命令。"
    work_lines: list[str] = []
    status_labels = {
        "succeeded": "成功",
        "skipped": "跳过",
        "failed": "失败",
        "running": "执行中",
        "pending": "待办",
    }
    for item in result.worklist.get("items", []):
        if isinstance(item, dict):
            label = status_labels.get(str(item.get("status")), "待办")
            work_lines.append(f"- `{item.get('id')}` [{label}] {item.get('title')}")
    works = "\n".join(work_lines) or "- 未生成 WorkList"
    quality = result.quality
    quality_text = (
        f"变更 {quality.get('changes', 0)} 个 · "
        f"风险 {quality.get('riskScore', 0)} ({quality.get('risk', 'low')}) · "
        f"验证 {'通过' if quality.get('validationPassed') else '未通过或未执行'} · "
        f"回归 {'检测到' if quality.get('regression') else '未检测到'}"
    )
    return (
        f"{result.summary}\n\n"
        f"**优化后的执行目标**\n{result.objective}\n\n"
        f"**WorkList 结果**\n{works}\n\n"
        f"**实际修改文件（{len(result.changed_files)} 个）**\n{files}\n\n"
        f"**验证记录**\n{commands}\n\n"
        f"**工程质量**\n{quality_text}\n\n"
        f"代理共执行 {result.iterations} 轮工具循环，使用模型：{result.model_name or 'Auto'}。"
    )


async def stream_prepared_autonomous(
    *,
    body: ChatRequest,
    root: Path,
    prepared: PreparedTask,
    context_text: str,
    preferred_model_id: str,
    credentials: LlmCredentials,
    trace: TraceHandle,
    checkpoint_id: str = "",
    resume_state: dict[str, Any] | None = None,
) -> AsyncIterator[str]:
    """执行准备好的 WorkList 循环并转换成前端 SSE。"""

    result: AgentLoopResult | None = None
    async for event in stream_autonomous_loop(
        root=root,
        task_plan=prepared.plan,
        project_id=body.project_id,
        initial_context=context_text,
        preferred_model_id=preferred_model_id,
        credentials=credentials,
        execution_mode=body.agent_mode,
        initial_usage=prepared.usage,
        initial_model_name=prepared.model_name,
        checkpoint_id=checkpoint_id,
        resume_state=resume_state,
    ):
        if event.kind == "lifecycle":
            payload = event.payload
            yield encode_sse(
                {
                    "type": "AGENT_LIFECYCLE",
                    "payload": _lifecycle(
                        role=str(payload.get("role") or "modify_worker"),
                        status=str(payload.get("status") or "running"),
                        detail=str(payload.get("detail") or "正在执行代码任务"),
                        iteration=int(payload.get("iteration") or 0),
                        tool_name=str(payload.get("toolName") or "") or None,
                        agent_id=str(payload.get("agentId") or "") or None,
                        slot=(
                            int(payload.get("slot"))
                            if payload.get("slot") is not None
                            else None
                        ),
                        current_files=[
                            str(path)
                            for path in (payload.get("currentFiles") or [])
                            if path
                        ],
                    ),
                }
            )
        elif event.kind == "tool":
            yield encode_sse(
                {
                    "type": "TOOL_STATUS",
                    "content": str(event.payload.get("label") or "执行代码工具"),
                }
            )
        elif event.kind == "usage":
            yield _usage_packet(
                int(event.payload.get("prompt") or 0),
                int(event.payload.get("completion") or 0),
                int(event.payload.get("total") or 0),
            )
        elif event.kind == "worklist":
            yield encode_sse({"type": "WORKLIST_UPDATE", "payload": event.payload})
        elif event.kind == "result":
            result = event.result

    if not result:
        raise ValueError("Code Agent 循环异常结束，没有生成结果")
    if body.project_id.strip():
        await record_completed_works(
            body.project_id,
            list((result.worklist or {}).get("items") or []),
        )
    yield encode_sse(
        {
            "type": "AGENT_LIFECYCLE",
            "payload": _lifecycle(
                role="final_report_agent",
                status="completed",
                detail="已根据真实 WorkList、文件修改和验证结果生成交付摘要。",
                iteration=result.replans,
            ),
        }
    )
    # 重建索引不阻塞最终回复；ensure_context 已对 indexing 状态去重，避免并发重建。
    spawn(index_project(body.project_id))
    await add_trace_event(
        trace,
        category="agent",
        name="autonomous_loop",
        status="completed",
        metadata={
            "iterations": result.iterations,
            "changedFiles": result.changed_files,
            "commands": [item.command for item in result.commands],
            "agentMode": body.agent_mode,
            "worklist": result.worklist,
            "optimizedPrompt": result.optimized_prompt[:4000],
            "quality": result.quality,
        },
    )
    yield encode_sse({"type": "TEXT", "content": _format_loop_result(result, body.agent_mode)})
