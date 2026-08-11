"""单个 Code Agent Work 的独立工具循环。"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, Awaitable, Callable, cast

from backend.services.agent.harness import ProjectHarness, build_work_seed_context
from backend.services.agent.loop_protocol import AgentAction, parse_agent_action
from backend.services.agent.loop_support import ExecutionMode, usage_add
from backend.services.agent.resource_coordinator import WorkspaceResourceCoordinator
from backend.services.agent.runtime.execution_guard import (
    ExecutionLimits,
    WorkExecutionGuard,
)
from backend.services.agent.runtime.action_guard import guard_edit
from backend.services.agent.runtime.work_session import WorkIntelligenceSession
from backend.services.agent.task_planner import CodeTaskPlan
from backend.services.agent.tool_registry import render_tool_catalog
from backend.services.agent.work_action_handler import (
    WorkActionEnvironment,
    WorkActionHandler,
)
from backend.services.agent.work_models import WorkItem
from backend.services.agent.workspace_tools import (
    EditBatchResult,
    read_workspace_files_with_versions,
)
from backend.services.agent.work_state import (
    FailureKind,
    WorkExecutionResult,
    WorkWorkerState,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.protocols import ProviderRequestError
from backend.services.llm.types import LlmMessage
from backend.tools.code_tools import execute_code_tool
from backend.services.workspace.indexer import iter_project_files

EmitCallback = Callable[[str, dict[str, Any]], Awaitable[None]]
CheckpointCallback = Callable[[], Awaitable[None]]
LOGGER = logging.getLogger(__name__)
MAX_INVALID_PROTOCOL_ROUNDS = 3


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    """读取整数环境变量并限制在安全区间，异常值回退默认。"""

    try:
        value = int(os.getenv(name, str(default)).strip())
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))


MAX_BATCH_WRITE_FILES = _env_int("CODE_AGENT_BATCH_WRITE_FILES", 16, 1, 64)
# 单轮模型输出上限：超过说明模型在整文件重写或冗余输出，注入警告引导精确修改。
MAX_WORK_OUTPUT_TOKENS = _env_int("CODE_AGENT_MAX_OUTPUT_TOKENS", 8_000, 1_000, 200_000)


async def _try_batch_write(
    *,
    root: Path,
    work: WorkItem,
    preferred_model_id: str,
    credentials: LlmCredentials,
    execution_mode: ExecutionMode,
    coordinator: WorkspaceResourceCoordinator,
    state: WorkWorkerState,
    emit: EmitCallback,
    checkpoint: CheckpointCallback,
    slot: int,
    targets_override: list[str] | None = None,
) -> tuple[WorkExecutionResult | None, str]:
    """目标文件已知时，用单次 LLM 调用批量写入全部文件。

    返回 None 表示不适合批量写入（模型未配合/写入失败），调用方转入常规多轮循环。
    """

    if os.getenv("CODE_AGENT_BATCH_WRITE", "1").strip().lower() not in {
        "1",
        "true",
        "on",
    }:
        return None, "disabled"
    targets = list(
        dict.fromkeys(
            path
            for path in (targets_override or work.target_files)
            if path and path.strip()
        )
    )
    if not targets:
        return None, "empty_targets"
    if state.transcript and not targets_override:
        return None, "transcript"
    if len(targets) > MAX_BATCH_WRITE_FILES and not targets_override:
        return None, "too_many"
    read = read_workspace_files_with_versions(root, targets)

    system = """你是一次性批量写入 Agent。CURRENT WORK 的目标文件全文已在输入中。
直接返回一个 edit 动作 JSON，禁止返回 search/read/run 等其他动作，禁止附加 Markdown：
{"action":"edit","workId":"W001","summary":"一句话说明写入内容","operations":[{"type":"write","path":"相对路径","content":"完整文件内容","reason":"为什么这么写"}]}
规则：
- operations 一次覆盖全部目标文件，不要分批；已有文件可用 replace（oldText 必须与输入中的原文精确匹配），新文件用 write；
- 内容已满足验收标准的文件可以不包含 operation；
- 每个 operation 都必须带 reason；
- 输出必须能被 json.loads 解析。"""
    files_text = "\n\n".join(
        f"--- FILE: {path} ---\n{content}"
        for path, content in _split_read_content(read.content)
    )
    work_payload = {
        "id": work.id,
        "title": work.title,
        "objective": work.objective[:1_500],
        "acceptanceCriteria": work.acceptance_criteria[:8],
        "targetFiles": targets,
        "executionMode": execution_mode,
    }
    user = (
        "CURRENT WORK:\n"
        + json.dumps(work_payload, ensure_ascii=False)
        + "\n\n目标文件全文：\n"
        + files_text
    )
    try:
        text, usage, model = await GATEWAY.complete(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=[LlmMessage("system", system), LlmMessage("user", user)],
            temperature=0.1,
            timeout_seconds=300,
            stall_timeout_seconds=90,
            audit={
                "agentId": f"modify_worker:{work.id}",
                "agentRole": "batch_write",
                "parentRequestId": work.id,
            },
        )
    except Exception:
        return None, "write_failed"
    usage_add(state.usage, usage)
    await emit(
        "usage",
        {
            "workId": work.id,
            "prompt": usage.prompt,
            "completion": usage.completion,
            "total": usage.total,
        },
    )
    state.model_name = model.name
    try:
        action = parse_agent_action(text)
    except ValueError:
        return None, "model_skipped"
    if action.action != "edit":
        state.append_transcript(
            "BATCH WRITE SKIPPED: 模型未返回批量 edit 动作，转入常规循环。"
        )
        return None, "model_skipped"
    if not action.operations:
        # 批量直写提示词允许“内容已满足验收标准的文件可以不包含 operation”，
        # 此时空 operations 表示无需修改，直接成功收尾，避免被判协议错误。
        state.append_transcript(
            "BATCH WRITE COMPLETED: 目标文件已满足验收标准，无需修改。"
        )
        await checkpoint()
        return (
            WorkExecutionResult(
                work.id,
                True,
                "目标文件已满足验收标准，无需修改",
                "",
                state,
            ),
            "no_changes",
        )
    gate = guard_edit(
        root=root,
        work=work,
        state=state,
        operations=action.operations,
    )
    if not gate.approved:
        state.append_transcript(f"BATCH WRITE GATE REJECTED: {gate.reason}")
        return None, "gate_rejected"

    await emit(
        "lifecycle",
        {
            "role": "modify_worker",
            "agentId": f"modify_worker:{work.id}",
            "slot": slot,
            "status": "running",
            "detail": (
                f"{work.id}：正在写入 "
                f"{len(action.operations)} 个目标文件"
            ),
            "currentFiles": sorted(
                {operation.path for operation in action.operations}
            ),
        },
    )
    paths = {operation.path for operation in action.operations}
    try:
        async with coordinator.reserve(
            paths,
            owner=work.id,
            priority=work.priority,
        ):
            expected = {
                path: read.versions[path]
                for path in paths
                if path in read.versions
            }
            edit_result = cast(
                EditBatchResult,
                await execute_code_tool(
                    "workspace.edit",
                    root=root,
                    arguments={
                        "operations": action.operations,
                        "expected_versions": expected,
                    },
                    permissions={"write"},
                    agent_id=f"batch_write:{work.id}",
                    task_id=work.id,
                ),
            )
    except Exception as exc:
        state.append_transcript(
            f"BATCH WRITE FAILED: {exc}\n转入常规循环重试。"
        )
        return None, "write_failed"
    for path in edit_result.changed_files:
        if path not in state.changed_files:
            state.changed_files.append(path)
    state.append_transcript(
        f"BATCH WRITE APPLIED: {edit_result.changed_files}\n"
        f"DIFF:\n{edit_result.diff_preview[:4_000]}"
    )
    await emit(
        "lifecycle",
        {
            "role": "merge_agent",
            "agentId": f"merge_agent:{work.id}",
            "slot": slot,
            "status": "completed",
            "detail": (
                f"{work.id}：一次性批量写入 "
                f"{len(edit_result.changed_files)} 个文件"
            ),
            "currentFiles": list(edit_result.changed_files),
            "toolName": "apply_file_change",
        },
    )
    await checkpoint()
    return WorkExecutionResult(
        work_id=work.id,
        succeeded=True,
        summary=f"已一次性写入 {len(edit_result.changed_files)} 个目标文件。",
        error="",
        state=state,
    ), ""


def _split_read_content(content: str) -> list[tuple[str, str]]:
    """把 read 工具输出按文件头拆回 (路径, 内容) 对。"""

    sections: list[tuple[str, str]] = []
    current_path = ""
    current_lines: list[str] = []
    for line in content.splitlines():
        if line.startswith("--- ") and line.endswith(" ---"):
            if current_path:
                sections.append((current_path, "\n".join(current_lines)))
            current_path = line[5:-4].split(" [", 1)[0].strip()
            current_lines = []
        else:
            current_lines.append(line)
    if current_path:
        sections.append((current_path, "\n".join(current_lines)))
    return sections


def _is_generation_work(work: WorkItem, root: Path) -> bool:
    """按项目实际状态判断是否为“生成/补齐类”Work，不依赖标题关键词。

    - 有 targetFiles：目标文件大多尚不存在 → 批量写入快路径；
      目标文件大多已存在 → 常规循环做精准修改。
    - 无 targetFiles：只有空项目才走一键整站生成（空项目里“修改”无从谈起）；
      非空项目交给常规循环，模型先读文件再决定新建或修改。
    """

    targets = [path for path in work.target_files if path.strip()]
    if not targets:
        # Planner 没给 targetFiles 说明文件尚未创建：一律按“新建+全量写入”处理，
        # 不再进多轮循环；是否从零整站生成由项目是否为空决定。
        return True
    existing = sum(1 for path in targets if _exists(root, path))
    return existing <= len(targets) // 2


def _is_greenfield_root(root: Path, *, max_source_files: int = 5) -> bool:
    """判断项目目录是否基本为空（按可索引文件数，带上限避免大项目全量扫描）。"""

    try:
        count = 0
        for _ in iter_project_files(root):
            count += 1
            if count > max_source_files:
                return False
        return True
    except OSError:
        return False


def _exists(root: Path, path: str) -> bool:
    """检查相对路径在项目根下是否存在（安全解析）。"""

    try:
        return root.joinpath(*path.split("/")).is_file()
    except (OSError, ValueError):
        return False


def _file_byte_size(root: Path, path: str) -> int:
    """用文件字节数作为字符数的保守上界（UTF-8 下字节数 ≥ 字符数）。"""

    try:
        target = root.joinpath(*path.split("/"))
        return int(target.stat().st_size) if target.is_file() else 0
    except (OSError, ValueError):
        return 0


def _chunk_batch_targets(
    targets: list[str],
    root: Path,
    *,
    max_files: int = MAX_BATCH_WRITE_FILES,
    max_bytes: int = 44_000,
) -> list[list[str]]:
    """把目标文件切成可单次批量直写的大小：文件数 ≤16、总字节 ≤44K。"""

    chunks: list[list[str]] = []
    current: list[str] = []
    current_size = 0
    for path in targets:
        size = _file_byte_size(root, path)
        if current and (len(current) + 1 > max_files or current_size + size > max_bytes):
            chunks.append(current)
            current = []
            current_size = 0
        current.append(path)
        current_size += size
    if current:
        chunks.append(current)
    return chunks


_REVIEW_SYSTEM = """你是写入结果审查 Agent。目标文件已经一次性写入完成，写入后的文件内容已在输入中。
请基于 CURRENT WORK 的验收标准判断写入结果。只返回一个 JSON 对象，禁止附加 Markdown：
{"verdict":"complete","summary":"一句话结论"}
或
{"verdict":"patch","summary":"说明","operations":[{"type":"replace","path":"相对路径","oldText":"原内容片段","newText":"新内容","reason":"原因"}]}
或
{"verdict":"cannot_fix","reason":"为什么无法通过验收"}
如果写入内容已经满足验收标准，必须返回 complete；只有存在明确缺陷才返回 patch；只有任务本身不可行才返回 cannot_fix。"""


_GENERATE_ALL_SYSTEM = """你是从零生成 Agent。项目为空，CURRENT WORK 定义了要构建的内容，
目标文件尚未创建。请一次性返回一个 edit 动作 JSON，用 operations(type=write) 创建全部需要的文件，
每个文件给出完整内容。禁止 read/search/run，禁止附加 Markdown。输出必须能被 json.loads 解析。"""

_GENERATE_MISSING_SYSTEM = """你是新增文件生成 Agent。CURRENT WORK 定义了要创建的内容，
目标文件尚不存在；项目里已有其他代码，请只创建缺失的新文件，不要重写已有文件。
一次性返回一个 edit 动作 JSON，用 operations(type=write) 创建全部缺失文件，
每个文件给出完整可运行内容；禁止空文件、占位符或分步填空。
禁止 read/search/run，禁止附加 Markdown。输出必须能被 json.loads 解析。"""


async def _try_generate_all_files(
    *,
    root: Path,
    work: WorkItem,
    preferred_model_id: str,
    credentials: LlmCredentials,
    execution_mode: ExecutionMode,
    coordinator: WorkspaceResourceCoordinator,
    state: WorkWorkerState,
    emit: EmitCallback,
    checkpoint: CheckpointCallback,
    slot: int,
    system_prompt: str = _GENERATE_ALL_SYSTEM,
) -> WorkExecutionResult | None:
    """空 targetFiles 的生成类 Work：让模型一次性自命名创建全部文件。"""

    work_payload = {
        "id": work.id,
        "title": work.title,
        "objective": work.objective[:1_500],
        "acceptanceCriteria": work.acceptance_criteria[:8],
        "executionMode": execution_mode,
    }
    user = "CURRENT WORK:\n" + json.dumps(work_payload, ensure_ascii=False)
    await emit(
        "lifecycle",
        {
            "role": "modify_worker",
            "agentId": f"modify_worker:{work.id}",
            "slot": slot,
            "status": "running",
            "detail": f"{work.id}：一次性生成全部新文件",
            "currentFiles": [],
        },
    )
    try:
        text, usage, model = await GATEWAY.complete(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=[
                LlmMessage("system", system_prompt),
                LlmMessage("user", user),
            ],
            temperature=0.1,
            timeout_seconds=300,
            stall_timeout_seconds=90,
            audit={
                "agentId": f"modify_worker:{work.id}",
                "agentRole": "generate_all",
                "parentRequestId": work.id,
            },
        )
    except Exception:
        return None
    usage_add(state.usage, usage)
    await emit(
        "usage",
        {
            "workId": work.id,
            "prompt": usage.prompt,
            "completion": usage.completion,
            "total": usage.total,
        },
    )
    state.model_name = model.name
    try:
        action = parse_agent_action(text)
    except ValueError:
        return None
    if action.action != "edit" or not action.operations:
        state.append_transcript("GENERATE ALL SKIPPED: 模型未返回创建动作")
        return None
    if any(operation.type != "write" for operation in action.operations):
        state.append_transcript("GENERATE ALL SKIPPED: 一键生成只接受 write 新建操作")
        return None
    gate = guard_edit(
        root=root,
        work=work,
        state=state,
        operations=action.operations,
    )
    if not gate.approved:
        state.append_transcript(f"GENERATE ALL GATE REJECTED: {gate.reason}")
        return None
    paths = {operation.path for operation in action.operations}
    try:
        async with coordinator.reserve(
            paths,
            owner=work.id,
            priority=work.priority,
        ):
            edit_result = cast(
                EditBatchResult,
                await execute_code_tool(
                    "workspace.edit",
                    root=root,
                    arguments={
                        "operations": action.operations,
                        "expected_versions": {},
                    },
                    permissions={"write"},
                    agent_id=f"generate_all:{work.id}",
                    task_id=work.id,
                ),
            )
    except Exception as exc:
        state.append_transcript(f"GENERATE ALL FAILED: {exc}")
        return None
    for path in edit_result.changed_files:
        if path not in state.changed_files:
            state.changed_files.append(path)
    state.append_transcript(
        f"GENERATE ALL APPLIED: {edit_result.changed_files}\n"
        f"DIFF:\n{edit_result.diff_preview[:4_000]}"
    )
    await emit(
        "lifecycle",
        {
            "role": "merge_agent",
            "agentId": f"merge_agent:{work.id}",
            "slot": slot,
            "status": "completed",
            "detail": f"{work.id}：已生成 {len(edit_result.changed_files)} 个文件",
            "currentFiles": list(edit_result.changed_files),
            "toolName": "apply_file_change",
        },
    )
    await checkpoint()
    return WorkExecutionResult(
        work_id=work.id,
        succeeded=True,
        summary=f"已一次性生成 {len(edit_result.changed_files)} 个目标文件",
        error="",
        state=state,
    )


async def _try_generate_missing_files(
    *,
    root: Path,
    work: WorkItem,
    preferred_model_id: str,
    credentials: LlmCredentials,
    execution_mode: ExecutionMode,
    coordinator: WorkspaceResourceCoordinator,
    state: WorkWorkerState,
    emit: EmitCallback,
    checkpoint: CheckpointCallback,
    slot: int,
) -> WorkExecutionResult | None:
    """非空项目中的空 targetFiles 创建类 Work：一次性全量创建缺失文件。"""

    return await _try_generate_all_files(
        root=root,
        work=work,
        preferred_model_id=preferred_model_id,
        credentials=credentials,
        execution_mode=execution_mode,
        coordinator=coordinator,
        state=state,
        emit=emit,
        checkpoint=checkpoint,
        slot=slot,
        system_prompt=_GENERATE_MISSING_SYSTEM,
    )


async def _try_write_then_review(
    *,
    root: Path,
    work: WorkItem,
    preferred_model_id: str,
    credentials: LlmCredentials,
    execution_mode: ExecutionMode,
    coordinator: WorkspaceResourceCoordinator,
    state: WorkWorkerState,
    emit: EmitCallback,
    checkpoint: CheckpointCallback,
    slot: int,
) -> WorkExecutionResult | None:
    """批量直写失败后的“生成类”兜底：分块一次写完，再单次审查判定。

    只对生成/补齐类 Work 生效；任何一块写失败都会返回 None 转入常规循环，
    避免无限重试。审查只有一轮（最多附带一次补丁），不再走多轮 ReAct。
    """

    if not _is_generation_work(work, root):
        return None
    targets = list(dict.fromkeys(path for path in work.target_files if path.strip()))
    generated_all = False
    if not targets:
        if not _is_greenfield_root(root):
            # 非空项目：一次性创建缺失文件（不重写已有文件）。
            generated = await _try_generate_missing_files(
                root=root,
                work=work,
                preferred_model_id=preferred_model_id,
                credentials=credentials,
                execution_mode=execution_mode,
                coordinator=coordinator,
                state=state,
                emit=emit,
                checkpoint=checkpoint,
                slot=slot,
            )
        else:
            generated = await _try_generate_all_files(
                root=root,
                work=work,
                preferred_model_id=preferred_model_id,
                credentials=credentials,
                execution_mode=execution_mode,
                coordinator=coordinator,
                state=state,
                emit=emit,
                checkpoint=checkpoint,
                slot=slot,
            )
        if generated is None:
            return None
        targets = list(state.changed_files)
        if not targets:
            return generated
        generated_all = True
    if not generated_all:
        chunks = _chunk_batch_targets(targets, root)
        if not chunks or len(chunks) > 6:
            return None

        await emit(
            "lifecycle",
            {
                "role": "modify_worker",
                "agentId": f"modify_worker:{work.id}",
                "slot": slot,
                "status": "running",
                "detail": f"{work.id}：分块直写 {len(chunks)} 批目标文件",
                "currentFiles": targets,
            },
        )
        for index, chunk in enumerate(chunks, start=1):
            result, reason = await _try_batch_write(
                root=root,
                work=work,
                preferred_model_id=preferred_model_id,
                credentials=credentials,
                execution_mode=execution_mode,
                coordinator=coordinator,
                state=state,
                emit=emit,
                checkpoint=checkpoint,
                slot=slot,
                targets_override=chunk,
            )
            if result is None:
                state.append_transcript(
                    f"CHUNKED WRITE {index}/{len(chunks)} FAILED ({reason})，转常规循环"
                )
                return None

    read = read_workspace_files_with_versions(root, targets)
    state.read_versions.update(read.versions)
    work_payload = {
        "id": work.id,
        "title": work.title,
        "objective": work.objective[:1_500],
        "acceptanceCriteria": work.acceptance_criteria[:8],
        "targetFiles": targets,
    }
    user = (
        "CURRENT WORK:\n"
        + json.dumps(work_payload, ensure_ascii=False)
        + "\n\n写入后文件内容：\n"
        + read.content
    )
    try:
        text, usage, model = await GATEWAY.complete(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=[
                LlmMessage("system", _REVIEW_SYSTEM),
                LlmMessage("user", user),
            ],
            temperature=0.1,
            timeout_seconds=180,
            stall_timeout_seconds=90,
            audit={
                "agentId": f"modify_worker:{work.id}",
                "agentRole": "review_patch",
                "parentRequestId": work.id,
            },
        )
    except Exception:
        state.append_transcript("REVIEW CALL FAILED，接受已写入结果")
        return WorkExecutionResult(
            work_id=work.id,
            succeeded=True,
            summary=f"已分块写入 {len(targets)} 个目标文件（审查未执行）",
            error="",
            state=state,
        )
    usage_add(state.usage, usage)
    await emit(
        "usage",
        {
            "workId": work.id,
            "prompt": usage.prompt,
            "completion": usage.completion,
            "total": usage.total,
        },
    )
    state.model_name = model.name
    try:
        review = _extract_review_json(text)
    except ValueError as exc:
        state.append_transcript(f"REVIEW JSON INVALID: {exc}")
        return WorkExecutionResult(
            work_id=work.id,
            succeeded=True,
            summary="已分块写入并通过默认验收",
            error="",
            state=state,
        )

    verdict = str(review.get("verdict") or "").strip().lower()
    if verdict == "patch":
        patch_result = await _apply_review_patch(
            root=root,
            work=work,
            state=state,
            coordinator=coordinator,
            operations=review.get("operations"),
            slot=slot,
        )
        if patch_result is None:
            return WorkExecutionResult(
                work_id=work.id,
                succeeded=True,
                summary=str(review.get("summary") or "已分块写入（补丁未应用）")[:1000],
                error="",
                state=state,
            )
        return patch_result
    if verdict == "cannot_fix":
        return WorkExecutionResult(
            work_id=work.id,
            succeeded=False,
            summary="",
            error=str(review.get("reason") or "写入后审查判定任务不可行")[:2000],
            state=state,
            failure_kind="guard",
        )
    return WorkExecutionResult(
        work_id=work.id,
        succeeded=True,
        summary=str(review.get("summary") or "已分块写入并通过审查")[:1000],
        error="",
        state=state,
    )


def _extract_review_json(text: str) -> dict[str, object]:
    """从审查响应中提取 JSON 对象。"""

    stripped = text.strip()
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end < start:
        raise ValueError("审查未返回 JSON")
    value = json.loads(stripped[start : end + 1])
    if not isinstance(value, dict):
        raise ValueError("审查响应必须是 JSON 对象")
    return value


async def _apply_review_patch(
    *,
    root: Path,
    work: WorkItem,
    state: WorkWorkerState,
    coordinator: WorkspaceResourceCoordinator,
    operations: object,
    slot: int,
) -> WorkExecutionResult | None:
    """应用审查返回的补丁操作；失败返回 None（接受已写入结果）。"""

    if not isinstance(operations, list) or not operations:
        return None
    try:
        action = parse_agent_action(
            json.dumps(
                {
                    "action": "edit",
                    "workId": work.id,
                    "summary": "审查补丁",
                    "operations": operations,
                },
                ensure_ascii=False,
            )
        )
    except ValueError:
        return None
    gate = guard_edit(root=root, work=work, state=state, operations=action.operations)
    if not gate.approved:
        return None
    paths = {operation.path for operation in action.operations}
    try:
        async with coordinator.reserve(
            paths, owner=work.id, priority=work.priority
        ):
            expected = {
                path: state.read_versions[path]
                for path in paths
                if path in state.read_versions
            }
            edit_result = cast(
                EditBatchResult,
                await execute_code_tool(
                    "workspace.edit",
                    root=root,
                    arguments={
                        "operations": action.operations,
                        "expected_versions": expected,
                    },
                    permissions={"write"},
                    agent_id=f"review_patch:{work.id}",
                    task_id=work.id,
                ),
            )
    except Exception as exc:
        state.append_transcript(f"REVIEW PATCH FAILED: {exc}")
        return None
    for path in edit_result.changed_files:
        if path not in state.changed_files:
            state.changed_files.append(path)
    state.append_transcript(
        f"REVIEW PATCH APPLIED: {edit_result.changed_files}\n"
        f"DIFF:\n{edit_result.diff_preview[:4_000]}"
    )
    await emit(
        "lifecycle",
        {
            "role": "merge_agent",
            "agentId": f"merge_agent:{work.id}",
            "slot": slot,
            "status": "completed",
            "detail": f"{work.id}：审查补丁已应用",
            "currentFiles": list(edit_result.changed_files),
            "toolName": "apply_file_change",
        },
    )
    return WorkExecutionResult(
        work_id=work.id,
        succeeded=True,
        summary=f"已分块写入并通过审查（补丁 {len(edit_result.changed_files)} 个文件）",
        error="",
        state=state,
    )


def _shorten_paths(paths: list[str]) -> str:
    """把路径列表压缩成前端可读的短文本。"""

    unique = list(dict.fromkeys(str(item) for item in paths if str(item).strip()))
    if not unique:
        return "（未指定）"
    if len(unique) <= 5:
        return "、".join(unique)
    return "、".join(unique[:5]) + f" 等 {len(unique)} 个文件"


def _action_status(action: AgentAction, work: WorkItem) -> str:
    """把当前轮动作转换成“正在读/改什么文件”的可见状态。"""

    prefix = f"{work.id} · {work.title}："
    if action.action == "read":
        return f"{prefix}正在读取文件：{_shorten_paths(action.paths)}"
    if action.action == "search":
        return f"{prefix}正在搜索：{action.query[:80]}"
    if action.action == "inspect":
        files = _shorten_paths(action.paths)
        return f"{prefix}正在分析代码：{files}"
    if action.action == "edit":
        files = _shorten_paths(sorted({operation.path for operation in action.operations}))
        return f"{prefix}正在修改文件：{files}"
    if action.action == "factory":
        return f"{prefix}正在执行 Software Factory {action.factory_mode}"
    if action.action == "run":
        return f"{prefix}正在执行验证命令：{action.command[:80]}"
    if action.action == "complete_work":
        return f"{prefix}正在确认完成"
    return f"{prefix}正在执行 {action.action}"


def _action_files(action: AgentAction) -> list[str]:
    """提取当前动作涉及的文件路径，供前端展示“正在修改什么文件”。"""

    if action.action in {"read", "inspect"}:
        return list(action.paths)
    if action.action == "edit":
        return sorted({operation.path for operation in action.operations})
    return []


def _worker_prompt(
    work: WorkItem,
    harness: ProjectHarness,
    execution_mode: ExecutionMode,
    state: WorkWorkerState | None = None,
) -> str:
    """生成聚焦当前 Work 的短系统提示词，避免每轮重复完整用户需求。"""

    run_rule = (
        "允许 run 执行 Harness 已识别的受限质量命令。"
        if execution_mode == "full_auto"
        else "当前为自动编辑模式，run 会被跳过。"
    )
    work_payload = {
        "id": work.id,
        "title": work.title,
        "objective": work.objective[:1_500],
        "acceptanceCriteria": work.acceptance_criteria[:8],
        "dependencies": work.dependencies,
        "targetFiles": work.target_files[:30],
        "priority": work.priority,
    }
    factory_hint = ""
    if any(
        term in f"{work.title} {work.objective}".lower()
        for term in ("mock", "契约", "contract", "openapi", "数据源", "api client")
    ):
        factory_hint = (
            "- 涉及 Mock、契约或 API 生成时，优先调用 factory 工具（plan/generate/validate）"
            "按 outputRoot 落地；执行 generate 前先确认输出目录：产物已存在且 validate "
            "通过时直接复用，禁止重复生成或覆盖；只有确实需要补齐时才 generate。禁止把整份 "
            "Mock JSON 作为 edit 内容手写，大批量生成必须交给 factory，单轮 edit 只改必要文件。\n"
        )
    retry_directive = ""
    if state is not None and state.attempt_number > 1:
        retry_directive = (
            "- 当前是重试尝试：先 read 目标文件核对验收标准；如果改动已存在且符合要求，"
            "直接 complete_work，不要重复编辑；只补齐缺失部分，禁止重做已应用的内容。\n"
            "- 不要重新做完整审计：如果上次失败来自校验或错误信息，直接 read 错误提到的"
            "具体文件并只修复这些点，然后立即完成。\n"
        )
    return f"""你是 Code Agent 的并行 Worker，只处理 CURRENT WORK。
工具：
{render_tool_catalog(compact=True, execution_mode=execution_mode)}

协议：每轮只返回一个 JSON 对象，不得附加 Markdown。
  - 已知文件必须一次 read 批量读取；Harness 已预读的内容不得再次搜索。
  - 动手 edit 前先核对目标文件是否已满足 CURRENT WORK 的验收标准；已满足则直接
    complete_work，不要重复修改；只修改确实缺失的部分。
  - read 默认返回完整文件内容；超大文件可用 offsets（字符偏移）分页查看。
  - 最多补充必要上下文，随后立即 edit；通过验收后立即 complete_work。
  - factory 只用于尚未被本地 Factory Worker处理的数据层工作。
  {factory_hint}
  {retry_directive}
  - 文件版本冲突时重新 read 冲突文件；不得重做其他已成功 Work。
- edit 就是写入/新建文件工具：operations.type=write 可创建文件，replace 可精确修改。
- write 必须一次给出完整可运行内容；禁止空文件、占位符或分步填空；新建文件后不要反复
  read 验证，路径正确就直接 complete_work。
- 如果确认目标文件已满足验收标准或无法确定修改点，直接 complete_work 说明原因，
  不要返回空 operations 的 edit。
- 一次 edit 必须用多组 operations 完成本 Work 当前轮能确定的所有修改点；禁止
  “改一处 → read 验证 → 再改下一处”的小步循环，也不要逐轮拆分成多个 edit。
- edit 写入成功后不要 read 刚写过的文件验证：工具 OBSERVATION 已返回变更结果，
  直接 complete_work。read 只用于首次了解文件或编辑前的现状核对。
- write 只用于新建文件；修改已存在文件一律用 replace（可在同一 edit 内多组），
  禁止对已存在文件整文件 write 重写。
- 自动编辑模式无法运行命令：需要运行构建/测试才能验证的任务，做静态修复后应在
  complete_work 中说明“需切换全自动模式运行验证命令”。
- 敏感路径在目录树和工具层都会被过滤；收到 SECURITY SKIP 后不得重试该路径，改读 .env.example 或配置类型。
- tabBar/小程序图标必须引用真实存在的 PNG 位图（iconPath 支持 png/jpg/jpeg，不支持 SVG）；
  图标文件缺失时系统会自动补齐占位 PNG，你只需保证路径符合项目约定（Taro 相对 src，原生相对根目录），
  不要写空路径，也不要伪造二进制图片文件。
- 不读取密钥或越出项目；源码不超过 500 行；遵守中文注释、ESLint 和项目格式。
- {run_rule}

{harness.worker_directive(work)}

CURRENT WORK:
{json.dumps(work_payload, ensure_ascii=False)}
"""


async def execute_work(
    *,
    root: Path,
    task_plan: CodeTaskPlan,
    work: WorkItem,
    harness: ProjectHarness,
    initial_context: str,
    project_tree: str,
    ledger_snapshot: dict[str, Any],
    preferred_model_id: str,
    credentials: LlmCredentials,
    execution_mode: ExecutionMode,
    coordinator: WorkspaceResourceCoordinator,
    state: WorkWorkerState,
    emit: EmitCallback,
    checkpoint: CheckpointCallback,
    slot: int,
) -> WorkExecutionResult:
    """持续执行一个 Work，直到成功完成或产生可分类的真实失败。"""

    session = WorkIntelligenceSession(work, state)
    session.initialize(
        initial_context=initial_context,
        project_tree=project_tree,
        ledger_snapshot=ledger_snapshot,
        harness_context=build_work_seed_context(
            root=root,
            harness=harness,
            work=work,
        ),
        root=root,
    )
    agent_id = f"modify_worker:{work.id}"
    guard = WorkExecutionGuard(
        state,
        limits=ExecutionLimits.from_environment(len(work.target_files)),
    )
    consecutive_context_actions = 0
    handler = WorkActionHandler(
        WorkActionEnvironment(
            root=root,
            request_text=task_plan.raw_request,
            work=work,
            state=state,
            execution_mode=execution_mode,
            coordinator=coordinator,
            emit=emit,
            checkpoint=checkpoint,
            slot=slot,
            agent_id=agent_id,
        )
    )

    if work.execution_type in {"coding", "agent"}:
        batch_result, batch_reason = await _try_batch_write(
            root=root,
            work=work,
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            execution_mode=execution_mode,
            coordinator=coordinator,
            state=state,
            emit=emit,
            checkpoint=checkpoint,
            slot=slot,
        )
        if batch_result is not None:
            return batch_result
        if batch_reason not in {"disabled", "transcript"}:
            fast_result = await _try_write_then_review(
                root=root,
                work=work,
                preferred_model_id=preferred_model_id,
                credentials=credentials,
                execution_mode=execution_mode,
                coordinator=coordinator,
                state=state,
                emit=emit,
                checkpoint=checkpoint,
                slot=slot,
            )
            if fast_result is not None:
                return fast_result

    if state.attempt_number > 1:
        retry_reason = (
            str(dict(state.failure_summary).get("error") or "")
            if state.failure_summary
            else ""
        )
        await emit(
            "lifecycle",
            {
                "role": "modify_worker",
                "agentId": agent_id,
                "slot": slot,
                "status": "running",
                "detail": (
                    f"{work.id} · {work.title}：正在重试"
                    f"（第 {state.attempt_number} 次尝试）"
                    f"——上次失败原因：{(retry_reason or '未知')[:160]}"
                ),
            },
        )

    while True:
        model_gate = guard.before_model_call()
        if model_gate.stop:
            session.record_failure(action="execution_guard", error=model_gate.error)
            state.runtime_failures += 1
            await checkpoint()
            return WorkExecutionResult(
                work.id,
                False,
                "",
                model_gate.error,
                state,
                failure_kind="guard",
            )

        session_prompt = session.build_prompt()
        worker_budget = session.budget.get("worker")
        if (
            worker_budget.consumed > 0
            and worker_budget.remaining
            < session_prompt.estimated_tokens + 2_000
        ):
            # 预算不再作为调用前硬闸门：先压缩上下文腾出空间，再通过软信号
            # 引导模型本轮收尾（edit 或 complete_work），而不是直接失败交回 Planner。
            session.compact_for_budget()
            session_prompt = session.build_prompt()
        budget_hint = session.budget_directive(
            worker_budget,
            session_prompt.estimated_tokens,
        )
        user_text = f"{session_prompt.text}\n\n{guard.prompt_directive()}"
        if budget_hint:
            user_text = f"{user_text}\n\n{budget_hint}"
        next_attempt_iteration = state.attempt_iterations + 1
        attempt_note = (
            f" · 第 {state.attempt_number} 次尝试"
            if state.attempt_number > 1
            else ""
        )
        await emit(
            "lifecycle",
            {
                "role": "modify_worker",
                "agentId": agent_id,
                "slot": slot,
                "status": "running",
                "detail": (
                    f"{work.id} · {work.title}：正在执行第 "
                    f"{next_attempt_iteration} 轮{attempt_note}（输入约 "
                    f"{session_prompt.estimated_tokens} Tokens）"
                ),
            },
        )
        LOGGER.info(
            "Worker 模型调用开始 work=%s attempt=%s iteration=%s prompt_tokens=%s",
            work.id,
            state.attempt_number,
            next_attempt_iteration,
            session_prompt.estimated_tokens,
        )
        try:
            text, usage, model = await GATEWAY.complete(
                preferred_model_id=preferred_model_id,
                credentials=credentials,
                messages=[
                    LlmMessage(
                        "system",
                        _worker_prompt(work, harness, execution_mode, state),
                    ),
                    LlmMessage(
                        "user",
                        user_text,
                    ),
                ],
                temperature=0.1,
                timeout_seconds=guard.limits.model_timeout_seconds,
                stall_timeout_seconds=90.0,
                audit={
                    "agentId": agent_id,
                    "agentRole": "worker_loop",
                    "parentRequestId": work.id,
                },
            )
        except (TimeoutError, ProviderRequestError) as exc:
            if isinstance(exc, ProviderRequestError) and "超时" not in str(exc):
                raise
            error = (
                f"模型响应超时：{str(exc)}"
                "。已终止本次尝试，避免长期占用执行槽。"
            )
            session.record_failure(action="model_timeout", error=error)
            state.runtime_failures += 1
            await checkpoint()
            return WorkExecutionResult(
                work.id,
                False,
                "",
                error,
                state,
                failure_kind="runtime",
            )

        usage_add(state.usage, usage)
        if not session.record_usage(usage.total):
            worker_budget = dict(state.token_budget.get("worker") or {})
            budget_limit = int(worker_budget.get("limit") or 0)
            error = (
                "Worker Token 预算严重超限且已完成一次上下文压缩"
                f"（已消耗 {worker_budget.get('consumed') or 0} / "
                f"触发终止阈值 {budget_limit * 2} Tokens；"
                f"单 Work 预算上限 {budget_limit or '未知'}）。"
                "压缩后仍无法收尾，停止继续消耗。"
            )
            session.record_failure(action="token_budget", error=error)
            state.runtime_failures += 1
            await checkpoint()
            return WorkExecutionResult(
                work.id,
                False,
                "",
                error,
                state,
                failure_kind="guard",
            )
        state.model_name = model.name
        state.iterations += 1
        state.attempt_iterations += 1
        await emit(
            "usage",
            {
                "workId": work.id,
                "prompt": usage.prompt,
                "completion": usage.completion,
                "total": usage.total,
            },
        )
        LOGGER.info(
            "Worker 模型调用完成 work=%s attempt=%s iteration=%s total_tokens=%s",
            work.id,
            state.attempt_number,
            state.attempt_iterations,
            usage.total,
        )

        # 大输出监控：单轮 completion 过大说明模型在整文件重写或冗余输出，
        # 注入警告引导下一轮改用多组 replace 精确修改；连续两次升级措辞促收尾。
        if usage.completion > MAX_WORK_OUTPUT_TOKENS:
            large_outputs = int(state.quality.get("largeOutputCount") or 0) + 1
            state.quality["largeOutputCount"] = large_outputs
            if large_outputs >= 2:
                state.append_transcript(
                    f"LARGE OUTPUT WARNING（第 {large_outputs} 次）：上一轮输出 "
                    f"{usage.completion} Tokens，已连续大段输出。禁止整文件 write "
                    "重写，改用多组 replace 精确修改缺失部分，并在本轮 complete_work "
                    "收尾；继续超大输出会拖慢执行并浪费 Token。"
                )
            else:
                state.append_transcript(
                    f"LARGE OUTPUT WARNING：上一轮输出 {usage.completion} Tokens，"
                    f"超出单轮上限 {MAX_WORK_OUTPUT_TOKENS}。请改用多组 replace "
                    "精确修改，禁止整文件 write 重写；输出只包含必要变更。"
                )

        try:
            action = parse_agent_action(text)
            state.invalid_rounds = 0
            state.attempt_invalid_rounds = 0
        except ValueError as exc:
            state.invalid_rounds += 1
            state.attempt_invalid_rounds += 1
            bad_preview = " ".join(text.split())[:400]
            error_text = str(exc)
            if "read" in error_text:
                example = '{"action":"read","workId":"W001","paths":["src/mock/user.ts"]}'
            elif "inspect" in error_text:
                example = '{"action":"inspect","workId":"W001","paths":["src/mock/user.ts"],"query":"数据源"}'
            elif "search" in error_text:
                example = '{"action":"search","workId":"W001","query":"cart"}'
            else:
                example = "参考工具目录中对应动作的示例 JSON"
            feedback = (
                f"直接复制下面示例 JSON，只替换路径和 ID，不要改变结构：{example}\n"
                f"PROTOCOL ERROR: {exc}\n"
                f"上一轮输出（截断）：{bad_preview or '（空输出）'}\n"
                "下一轮必须只返回一个合法 JSON 动作，不得附加 Markdown 或解释。"
            )
            if "非空 operations" in error_text:
                feedback += (
                    "\n如果目标文件已满足验收标准或无法确定修改点，请直接返回 "
                    '{"action":"complete_work","workId":"W001","summary":"说明原因"}，'
                    "不要返回空 operations 的 edit。"
                )
            if state.attempt_invalid_rounds >= 3:
                feedback += (
                    "\n严重警告：已连续 3 次协议错误。下一轮请直接复制上面的示例并只替换"
                    "路径与 ID，不要改变 JSON 结构；再错将终止本次尝试。"
                )
            state.append_transcript(feedback)
            if state.attempt_invalid_rounds >= MAX_INVALID_PROTOCOL_ROUNDS:
                error = f"模型连续返回无效工具协议：{exc}"
                session.record_failure(action="protocol", error=error)
                state.runtime_failures += 1
                await checkpoint()
                return WorkExecutionResult(
                    work.id,
                    False,
                    "",
                    error,
                    state,
                    failure_kind="runtime",
                )
            continue

        if action.work_id and action.work_id != work.id:
            state.append_transcript(
                f"WORK ID ERROR: 当前只能处理 {work.id}，不能处理 {action.work_id}。"
            )
            continue
        if action.action == "finish":
            state.append_transcript(
                "FINISH REJECTED: 并行 Worker 必须使用 complete_work。"
            )
            continue
        if action.action == "edit" and not action.operations:
            state.append_transcript(
                "EMPTY EDIT REJECTED: edit 必须包含 operations；"
                "如果目标已满足或无法确定修改点，请用 complete_work 结束，不要返回空 edit。"
            )
            continue

        action_gate = guard.before_action(action)
        if not action_gate.allowed:
            state.append_transcript(action_gate.feedback or action_gate.error)
            await checkpoint()
            if action_gate.stop:
                error = action_gate.error or "执行守卫已终止重复动作。"
                session.record_failure(action=action.action, error=error)
                state.runtime_failures += 1
                await checkpoint()
                return WorkExecutionResult(
                    work.id,
                    False,
                    "",
                    error,
                    state,
                    failure_kind="guard",
                )
            continue

        await emit(
            "lifecycle",
            {
                "role": "modify_worker",
                "agentId": agent_id,
                "slot": slot,
                "status": "running",
                "detail": _action_status(action, work),
                "currentFiles": _action_files(action),
            },
        )
        outcome = await handler.execute(action)
        if action.action in {"search", "read", "inspect"}:
            consecutive_context_actions += 1
        else:
            consecutive_context_actions = 0
        if consecutive_context_actions >= 3:
            state.append_transcript(
                "READ-ONLY STALL WARNING: 已连续 3 轮只读动作。"
                "下一轮必须输出 edit、factory、run 或 complete_work；"
                "继续只读取会导致本 Work 被终止并交给 Planner。"
            )
            consecutive_context_actions = 0
        guard.record(
            action,
            outcome.kind,
            progress_made=outcome.progress_made,
            refresh_context=outcome.refresh_context,
        )
        session.reflect(
            action=action.action,
            outcome_kind=outcome.kind,
            summary=outcome.summary,
            error=outcome.error,
        )
        if outcome.kind == "continue":
            continue
        if outcome.kind == "failure":
            session.record_failure(action=action.action, error=outcome.error)
            await checkpoint()
            return WorkExecutionResult(
                work.id,
                False,
                "",
                outcome.error,
                state,
                failure_kind=_failure_kind(outcome.error),
            )
        return WorkExecutionResult(
            work.id,
            True,
            outcome.summary,
            "",
            state,
        )


def _failure_kind(error: str) -> FailureKind:
    """把工具失败区分为代码、验证或运行时错误，避免 Planner 修复协议本身。"""

    normalized = error.upper()
    if normalized.startswith("VALIDATION FAILED") or normalized.startswith("RUN "):
        return "validation"
    if "PARALLEL" in normalized or "并行冲突" in error:
        return "resource"
    if "PROTOCOL" in normalized or "TIMEOUT" in normalized:
        return "runtime"
    return "code"


__all__ = ["WorkExecutionResult", "WorkWorkerState", "execute_work"]
