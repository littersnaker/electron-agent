"""Code Agent Work 的生成类与写入后审查路径。

从原 work_worker.py 拆分：空 targetFiles 的一次性生成、分块直写后的单次
审查判定（complete / patch / cannot_fix）。不包含多轮 ReAct 主循环。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

from backend.services.agent.runtime.action_guard import guard_edit
from backend.services.agent.shared.loop_protocol import parse_agent_action
from backend.services.agent.shared.loop_support import ExecutionMode, usage_add
from backend.services.agent.shared.resource_coordinator import WorkspaceResourceCoordinator
from backend.services.agent.shared.work_models import WorkItem
from backend.services.agent.shared.work_state import (
    CheckpointCallback,
    EmitCallback,
    WorkExecutionResult,
    WorkWorkerState,
)
from backend.services.agent.shared.workspace_tools import (
    EditBatchResult,
    read_workspace_files_with_versions,
)
from backend.services.agent.worker.work_batch_writer import (
    _GENERATE_ALL_SYSTEM,
    _GENERATE_MISSING_SYSTEM,
    _REVIEW_SYSTEM,
    _chunk_batch_targets,
    _is_generation_work,
    _is_greenfield_root,
    _try_batch_write,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage
from backend.services.tools.code_tools import execute_code_tool


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
        system_prompt = (
            _GENERATE_MISSING_SYSTEM
            if not _is_greenfield_root(root)
            else _GENERATE_ALL_SYSTEM
        )
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
            system_prompt=system_prompt,
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
            emit=emit,
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
    emit: EmitCallback,
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


__all__ = [
    "_try_generate_all_files",
    "_try_write_then_review",
    "_extract_review_json",
    "_apply_review_patch",
]
