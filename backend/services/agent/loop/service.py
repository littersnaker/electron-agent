"""Code Agent 主业务编排。

只读请求使用流式回答；建议模式保留人工批准；自动编辑与全自动模式使用多轮工具循环，
可持续搜索、读取、分批修改、验证并根据错误返工。
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from pathlib import Path
from typing import cast
from uuid import uuid4

from backend.core.background import spawn
from backend.schemas.chat import ChatRequest
from backend.services.agent.loop.autonomous_stream import stream_prepared_autonomous
from backend.services.agent.loop.checkpoint_runtime import plan_from_json
from backend.services.agent.loop.read_only_loop import stream_read_only_tool_answer
from backend.services.agent.loop.service_events import lifecycle, usage_packet, workspace_info_text
from backend.services.agent.loop.trace import (
    TraceHandle,
    add_trace_event,
    finish_trace,
    start_trace,
)
from backend.services.agent.planner.classifier import classify_request
from backend.services.agent.planner.plan_screen import (
    refine_plan_works,
    screen_plan_anomalies,
)
from backend.services.agent.planner.request_routing import route_code_request
from backend.services.agent.planner.task_planner import (
    CodeTaskPlan,
    PreparedTask,
    prepare_code_task,
)
from backend.services.agent.shared.context import ensure_context, render_context
from backend.services.agent.shared.proposal import generate_proposal, proposal_to_json
from backend.services.agent.shared.work_models import FileSystemOperation, WorkItem
from backend.services.agent.shared.workspace_tools import (
    render_workspace_tree,
    score_workspace_paths,
)
from backend.services.agent.worker.filesystem_executor import parse_direct_filesystem_request
from backend.services.agent.worker.pending import (
    find_pending_command_by_request_id,
    parse_interactive_reply,
    pop_pending_action,
    resolve_pending_command,
    save_pending_action,
)
from backend.services.agent.worker.run_checkpoint import resolve_run_checkpoint
from backend.services.checkpoints.store import get_checkpoint, update_checkpoint
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.types import LlmUsage
from backend.services.tools.code_tools import execute_code_tool
from backend.services.workspace.indexer import index_project
from backend.services.workspace.repository import get_project, resolve_project_root
from backend.utils.sse import encode_sse, encode_sse_comment

LOGGER = logging.getLogger(__name__)


def _last_user_text(body: ChatRequest) -> str:
    """返回请求中最后一条用户消息。"""

    for message in reversed(body.messages):
        if message.role == "user":
            return message.content.strip()
    return ""


async def _handle_interactive_reply(
    *, body: ChatRequest, user_text: str
) -> AsyncIterator[str]:
    """处理建议模式中的文件写入批准。"""

    request_id, mode, answer = parse_interactive_reply(user_text)
    action = await pop_pending_action(request_id)
    if not action:
        yield encode_sse({"type": "TEXT", "content": "⚠️ 这条批准请求已失效，请重新提交原任务。"})
        return

    normalized = (answer or "").strip().lower()
    approved = mode == "auto" or normalized in {"approve", "create", "yes", "y"}
    if not approved:
        yield encode_sse({"type": "TEXT", "content": "已取消本次文件修改，没有写入任何文件。"})
        return

    project_id = str(action.get("projectId") or body.project_id)
    root = await resolve_project_root(project_id)
    yield encode_sse(
        {
            "type": "AGENT_LIFECYCLE",
            "payload": lifecycle(role="merge", status="running", detail="已获得批准，正在安全写入文件…"),
        }
    )
    changed = cast(
        list[str],
        await execute_code_tool(
            "workspace.apply_proposal",
            root=root,
            arguments={"action": action},
            permissions={"write"},
            agent_id="suggestion_approval",
            task_id=request_id,
        ),
    )
    spawn(index_project(project_id))
    yield encode_sse(
        {
            "type": "AGENT_LIFECYCLE",
            "payload": lifecycle(
                role="merge",
                status="completed",
                detail=f"已写入 {len(changed)} 个文件并重建索引。",
            ),
        }
    )
    summary = str(action.get("summary") or "修改完成")
    file_list = "\n".join(f"- `{path}`" for path in changed)
    yield encode_sse({"type": "TEXT", "content": f"{summary}\n\n已修改文件：\n{file_list}"})
    usage = action.get("usage") if isinstance(action.get("usage"), dict) else {}
    yield usage_packet(
        int(usage.get("prompt") or 0),
        int(usage.get("completion") or 0),
        int(usage.get("total") or 0),
    )


def _prepare_direct_filesystem_task(
    user_text: str,
    operations: list[FileSystemOperation],
) -> PreparedTask:
    """把明确的单文件重命名请求转换为完全不调用 Planner 的本地计划。"""

    paths = [
        path
        for operation in operations
        for path in (operation.source_path, operation.target_path)
        if path
    ]
    plan = CodeTaskPlan(
        raw_request=user_text,
        optimized_prompt=user_text,
        objective="执行明确的本地文件重命名",
        constraints=["不得覆盖已有目标路径", "不得越出项目根目录"],
        acceptance_criteria=["源路径消失且目标路径存在"],
        non_goals=["不修改文件内容"],
        validation_commands=[],
        works=[
            WorkItem(
                id="W001",
                title="本地重命名文件",
                objective=user_text,
                priority=1,
                target_files=paths,
                execution_type="filesystem",
                file_operations=operations,
            )
        ],
    )
    return PreparedTask(plan=plan, usage=LlmUsage(), model_name="")


async def _stream_suggest_mode(
    *,
    body: ChatRequest,
    root: Path,
    user_text: str,
    context_text: str,
    preferred_model_id: str,
    credentials: LlmCredentials,
    trace: TraceHandle,
) -> AsyncIterator[str]:
    """生成一次可人工审阅的完整文件提案。"""

    yield encode_sse(
        {
            "type": "AGENT_LIFECYCLE",
            "payload": lifecycle(role="planner", status="running", detail="正在生成文件修改提案…"),
        }
    )
    proposal = await generate_proposal(
        root=root,
        user_request=user_text,
        context_text=context_text,
        preferred_model_id=preferred_model_id,
        credentials=credentials,
    )
    request_id = f"approval_{uuid4().hex}"
    action = proposal_to_json(proposal)
    action["projectId"] = body.project_id
    await save_pending_action(
        request_id=request_id,
        session_id=body.session_id,
        project_id=body.project_id,
        action=action,
    )
    paths = [item.path for item in proposal.files]
    await add_trace_event(
        trace,
        category="hitl",
        name="workspace_write_approval",
        status="info",
        metadata={"files": paths},
    )
    yield encode_sse(
        {
            "type": "INTERACTIVE_REQUEST",
            "payload": {
                "id": request_id,
                "source": "risk_approval",
                "command": "apply_file_changes",
                "prompt": f"Agent 准备修改 {len(paths)} 个文件，是否批准写入？",
                "description": proposal.summary,
                "mode": "normal",
                "suggestedMode": "user",
                "kind": "confirm",
                "allowMultiple": False,
                "options": [
                    {"label": "批准并继续", "value": "approve"},
                    {"label": "拒绝", "value": "reject"},
                ],
                "promptRound": 1,
                "recentOutput": "\n".join(paths),
                "title": "文件修改需要批准",
                "approvalKind": "workspace_write",
                "riskLevel": "medium",
                "toolName": "apply_file_change",
                "toolArguments": {"files": paths},
            },
        }
    )


async def stream_code_agent(
    *,
    body: ChatRequest,
    preferred_model_id: str,
    credentials: LlmCredentials,
    runtime_context: str = "",
) -> AsyncIterator[str]:
    """执行本地项目 Code Agent 工作流并持续输出 SSE。

    ``runtime_context`` 由统一 Context Manager 构建，包含 Skill 和 Memory；旧调用方省略时
    仍保持原有行为，从而支持小步迁移。
    """

    yield encode_sse_comment()
    user_text = _last_user_text(body)
    if not user_text:
        yield encode_sse({"type": "TEXT", "content": "⚠️ 请求中没有用户问题。"})
        return
    if classify_request(user_text) == "interactive_reply":
        request_id, reply_mode, answer = parse_interactive_reply(user_text)
        command_pending = await find_pending_command_by_request_id(request_id)
        if command_pending:
            normalized = (answer or "").strip().lower()
            approved = reply_mode == "auto" or normalized in {"approve", "yes", "y"}
            await resolve_pending_command(request_id, approved=approved)
            checkpoint_ref = str(command_pending.get("checkpointId") or "")
            if not checkpoint_ref:
                yield encode_sse(
                    {"type": "TEXT", "content": "⚠️ 该命令审批缺少 Checkpoint，无法恢复。"}
                )
                return
            # 命令审批回复：写入决定后按原 Checkpoint 恢复 Work 循环。
            body.resume_checkpoint_id = checkpoint_ref
        else:
            async for frame in _handle_interactive_reply(body=body, user_text=user_text):
                yield frame
            return
    if not body.project_id.strip():
        yield encode_sse({"type": "TEXT", "content": "⚠️ 当前 Code 会话没有绑定项目，请重新选择或添加项目。"})
        return

    checkpoint_id, resume_state = await resolve_run_checkpoint(body)
    project = await get_project(body.project_id)
    trace = await start_trace(
        session_id=body.session_id,
        project_id=body.project_id,
        model=preferred_model_id,
        request_preview=user_text,
    )
    try:
        if resume_state:
            root = await resolve_project_root(body.project_id)
            plan_payload = resume_state.get("taskPlan")
            if not isinstance(plan_payload, dict):
                raise ValueError("Checkpoint 缺少可恢复的任务规格")
            prepared = PreparedTask(
                plan=plan_from_json(plan_payload),
                usage=LlmUsage(),
                model_name=str(resume_state.get("modelName") or ""),
            )
            yield encode_sse(
                {
                    "type": "AGENT_LIFECYCLE",
                    "payload": lifecycle(
                        role="checkpoint_manager",
                        status="completed",
                        detail="已从 SQLite 恢复完整 WorkList、成功产物和验证记录。",
                    ),
                }
            )
            async for frame in stream_prepared_autonomous(
                body=body,
                root=root,
                prepared=prepared,
                context_text="",
                preferred_model_id=preferred_model_id,
                credentials=credentials,
                trace=trace,
                checkpoint_id=checkpoint_id,
                resume_state=resume_state,
            ):
                yield frame
            current = await get_checkpoint(checkpoint_id)
            if current and current.status == "paused":
                await finish_trace(trace, status="paused")
                return
            await update_checkpoint(
                checkpoint_id, status="completed", resumable=False
            )
            await finish_trace(trace, status="completed")
            return

        yield encode_sse({"type": "STATUS", "content": "🤖 Agent 已接收请求，正在识别任务类型…"})
        routed_request = route_code_request(body, user_text)
        request_mode = routed_request.mode
        effective_user_text = routed_request.effective_text
        capability_names = routed_request.tool_names
        await add_trace_event(
            trace,
            category="router",
            name="request_classifier",
            status="completed",
            metadata={
                "mode": request_mode,
                "agentMode": body.agent_mode,
                "tools": list(capability_names),
            },
        )
        yield encode_sse(
            {
                "type": "AGENT_LIFECYCLE",
                "payload": lifecycle(
                    role="router",
                    status="completed",
                    detail=(
                        f"请求已识别为 {request_mode}，执行模式为 {body.agent_mode}；"
                        f"本轮工具：{', '.join(capability_names)}。"
                    ),
                ),
            }
        )
        if request_mode == "workspace_info":
            yield encode_sse({"type": "TEXT", "content": workspace_info_text(project)})
            await update_checkpoint(checkpoint_id, status="completed", resumable=False)
            await finish_trace(trace, status="completed")
            return

        yield encode_sse(
            {
                "type": "AGENT_LIFECYCLE",
                "payload": lifecycle(
                    role="search_agent",
                    status="running",
                    detail="正在检索项目索引和相关文件…",
                    tool_name="search_project_index",
                ),
            }
        )
        root, files = await ensure_context(body.project_id, effective_user_text)
        context_text = render_context(files)
        if runtime_context.strip():
            # Runtime 约束必须放在项目索引上下文之前，避免长文件片段将 Skill 和 Memory 挤出。
            context_text = f"{runtime_context.strip()}\n\n{context_text}"
        yield encode_sse(
            {
                "type": "AGENT_LIFECYCLE",
                "payload": lifecycle(
                    role="search_agent",
                    status="completed",
                    detail=f"已找到 {len(files)} 个初始相关文件。",
                ),
            }
        )
        if request_mode == "read_only":
            async for frame in stream_read_only_tool_answer(
                root=root,
                user_text=effective_user_text,
                initial_context=context_text,
                preferred_model_id=preferred_model_id,
                credentials=credentials,
            ):
                yield frame
            await update_checkpoint(checkpoint_id, status="completed", resumable=False)
            await finish_trace(trace, status="completed")
            return

        yield encode_sse(
            {
                "type": "AGENT_LIFECYCLE",
                "payload": lifecycle(
                    role="prompt_optimizer",
                    status="running",
                    detail="正在保留 model、Base URL 和文件路径原值的前提下优化任务提示词…",
                ),
            }
        )
        direct_operations = parse_direct_filesystem_request(root, effective_user_text)
        if direct_operations:
            prepared = _prepare_direct_filesystem_task(
                effective_user_text, direct_operations
            )
        else:
            prepared = await prepare_code_task(
                user_request=effective_user_text,
                project_tree=await asyncio.to_thread(
                    render_workspace_tree,
                    root,
                    limit=800,
                ),
                initial_context=context_text,
                preferred_model_id=preferred_model_id,
                credentials=credentials,
                candidate_files=await asyncio.to_thread(
                    score_workspace_paths,
                    root,
                    effective_user_text,
                    limit=12,
                ),
            )
            # 全盘路径评分扫描较重，放到 worker 线程执行，避免阻塞 SSE 事件循环。
            anomalies = await asyncio.to_thread(
                screen_plan_anomalies,
                root,
                prepared.plan.works,
            )
            if anomalies:
                yield encode_sse(
                    {
                        "type": "AGENT_LIFECYCLE",
                        "payload": lifecycle(
                            role="high_level_planner",
                            status="running",
                            detail=(
                                f"内容筛查发现 {len(anomalies)} 个 Work 的 targetFiles "
                                "可疑，正在细分修正…"
                            ),
                        ),
                    }
                )
                try:
                    screen_usage, screen_model, applied_ids = await refine_plan_works(
                        prepared.plan,
                        anomalies,
                        preferred_model_id,
                        credentials,
                    )
                except Exception as exc:
                    # 计划细化 LLM 调用失败（缺 Key / 超时 / 供应商错误）不终止任务：
                    # 使用基础计划继续执行，避免用户整次任务白等。
                    yield encode_sse(
                        {
                            "type": "AGENT_LIFECYCLE",
                            "payload": lifecycle(
                                role="high_level_planner",
                                status="completed",
                                detail=(
                                    f"计划细化失败（{str(exc)[:160]}），"
                                    "使用基础计划继续执行。"
                                ),
                            ),
                        }
                    )
                    screen_usage, screen_model, applied_ids = LlmUsage(), "", []
                prepared.usage = LlmUsage(
                    prompt=prepared.usage.prompt + screen_usage.prompt,
                    completion=prepared.usage.completion + screen_usage.completion,
                    total=prepared.usage.total + screen_usage.total,
                )
                if screen_model:
                    prepared.model_name = screen_model
                if applied_ids:
                    prepared.review_notes.append(
                        "内容筛查细分：修正 "
                        f"{len(applied_ids)} 个 Work 的 targetFiles"
                        f"（{', '.join(applied_ids)}）"
                    )
                yield encode_sse(
                    {
                        "type": "AGENT_LIFECYCLE",
                        "payload": lifecycle(
                            role="high_level_planner",
                            status="completed",
                            detail=(
                                f"已根据内容筛查细分修正 {len(anomalies)} 个 Work 的 "
                                "targetFiles。"
                            ),
                        ),
                    }
                )
        if prepared.usage.total:
            yield usage_packet(
                prepared.usage.prompt,
                prepared.usage.completion,
                prepared.usage.total,
            )
        optimize_detail = (
            "检测到明确的单文件重命名请求，已跳过 Planner 和 Worker 大模型。"
            if direct_operations
            else (
                "提示词优化模型返回异常，已安全保留原始需求并生成单 Work 计划。"
                if prepared.fallback_used
                else f"提示词已优化为可执行规格：{prepared.plan.objective[:160]}"
            )
        )
        yield encode_sse(
            {
                "type": "AGENT_LIFECYCLE",
                "payload": lifecycle(
                    role="prompt_optimizer",
                    status="completed",
                    detail=optimize_detail,
                ),
            }
        )
        yield encode_sse(
            {
                "type": "AGENT_LIFECYCLE",
                "payload": lifecycle(
                    role="high_level_planner",
                    status="completed",
                    detail=f"已生成 {len(prepared.plan.works)} 个互不重复的 Work。",
                ),
            }
        )
        await add_trace_event(
            trace,
            category="planner",
            name="prompt_optimizer",
            status="completed",
            metadata={
                "fallbackUsed": prepared.fallback_used,
                "objective": prepared.plan.objective[:1000],
                "workIds": [item.id for item in prepared.plan.works],
                "reviewNotes": prepared.review_notes,
            },
        )

        if body.agent_mode == "suggest":
            async for frame in _stream_suggest_mode(
                body=body,
                root=root,
                user_text=prepared.plan.optimized_prompt,
                context_text=context_text,
                preferred_model_id=preferred_model_id,
                credentials=credentials,
                trace=trace,
            ):
                yield frame
            await update_checkpoint(checkpoint_id, status="paused", resumable=True)
            await finish_trace(trace, status="paused")
            return

        async for frame in stream_prepared_autonomous(
            body=body,
            root=root,
            prepared=prepared,
            context_text=context_text,
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            trace=trace,
            checkpoint_id=checkpoint_id,
        ):
            yield frame
        current = await get_checkpoint(checkpoint_id)
        if current and current.status == "paused":
            await finish_trace(trace, status="paused")
            return
        await update_checkpoint(checkpoint_id, status="completed", resumable=False)
        await finish_trace(trace, status="completed")
    except Exception as exc:
        LOGGER.exception("Code Agent 执行失败")
        await add_trace_event(
            trace,
            category="error",
            name="agent_failure",
            status="failed",
            metadata={"message": str(exc)[:500]},
        )
        await update_checkpoint(
            checkpoint_id,
            status="failed",
            resumable=True,
            error_message=str(exc),
        )
        await finish_trace(trace, status="failed", error_message=str(exc)[:1000])
        yield encode_sse({"type": "TEXT", "content": f"⚠️ {exc}"})
