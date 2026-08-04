"""Software Factory Work 的确定性本地执行入口。"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

from backend.services.agent.harness import ProjectHarness
from backend.services.agent.domain_rules import default_factory_domain_id
from backend.services.agent.loop_support import ExecutionMode
from backend.services.agent.validation_work import execute_validation_work
from backend.services.agent.work_models import WorkItem
from backend.services.agent.work_state import WorkExecutionResult, WorkWorkerState
from backend.tools.code_tools import execute_code_tool

EmitCallback = Callable[[str, dict[str, Any]], Awaitable[None]]
CheckpointCallback = Callable[[], Awaitable[None]]


async def execute_factory_work(
    *,
    root: Path,
    request_text: str,
    work: WorkItem,
    harness: ProjectHarness,
    state: WorkWorkerState,
    emit: EmitCallback,
    checkpoint: CheckpointCallback,
    slot: int,
) -> WorkExecutionResult:
    """本地执行 Factory 计划或生成，避免固定产物继续消耗 Worker LLM。"""

    mode = _factory_mode(work)
    output_root = _default_output_root(harness)
    agent_id = f"factory_worker:{work.id}"
    await emit(
        "lifecycle",
        {
            "role": "software_factory",
            "agentId": agent_id,
            "slot": slot,
            "status": "running",
            "detail": f"{work.id} · {work.title}：本地执行 Factory {mode}",
            "toolName": f"software_factory.{mode}",
        },
    )
    arguments = {
        "request_text": request_text,
        "domain_id": default_factory_domain_id(),
        "output_root": output_root,
        "mock_count": 12,
        "overwrite": False,
    }
    try:
        result = await execute_code_tool(
            f"software_factory.{mode}",
            root=root,
            arguments=arguments,
            permissions={"write"} if mode == "generate" else {"read"},
            agent_id=agent_id,
            task_id=work.id,
        )
    except FileExistsError:
        # 已有完整生成目录时先做一致性校验，避免恢复任务重复覆盖稳定产物。
        validation = await _validate_existing(
            root=root,
            output_root=output_root,
            agent_id=agent_id,
            work_id=work.id,
        )
        if _factory_artifacts_reusable(validation):
            state.quality["softwareFactory"] = validation
            state.append_transcript(
                "FACTORY REUSE: 已存在一致的生成产物，本次直接复用并跳过覆盖。"
            )
            await checkpoint()
            return WorkExecutionResult(
                work_id=work.id,
                succeeded=True,
                summary="已复用通过一致性校验的 Software Factory 产物。",
                error="",
                state=state,
            )
        return WorkExecutionResult(
            work_id=work.id,
            succeeded=False,
            summary="",
            error=(
                "SOFTWARE FACTORY EXISTING ARTIFACT INVALID: "
                + json.dumps(validation, ensure_ascii=False)[:4_000]
            ),
            state=state,
        )
    except Exception as exc:
        return WorkExecutionResult(
            work_id=work.id,
            succeeded=False,
            summary="",
            error=f"SOFTWARE FACTORY FAILED: {exc}",
            state=state,
        )

    if not isinstance(result, dict):
        return WorkExecutionResult(
            work_id=work.id,
            succeeded=False,
            summary="",
            error="SOFTWARE FACTORY FAILED: 工具返回了无效结果",
            state=state,
        )
    changed = [str(item) for item in result.get("changedFiles", []) if str(item)]
    for path in changed:
        if path not in state.changed_files:
            state.changed_files.append(path)
    state.quality["softwareFactory"] = _compact_factory_result(result)
    state.append_transcript(
        f"FACTORY {mode.upper()} COMPLETED: outputRoot={output_root}; changed={changed}"
    )
    await checkpoint()
    await emit(
        "lifecycle",
        {
            "role": "software_factory",
            "agentId": agent_id,
            "slot": slot,
            "status": "completed",
            "detail": f"{work.id} 已本地完成 Factory {mode}",
        },
    )
    return WorkExecutionResult(
        work_id=work.id,
        succeeded=True,
        summary=(
            f"已生成 {len(changed)} 个统一数据层文件。"
            if mode == "generate"
            else "已完成领域、Mock 与 API 契约生成计划。"
        ),
        error="",
        state=state,
    )


async def execute_factory_validation_work(
    *,
    root: Path,
    work: WorkItem,
    harness: ProjectHarness,
    state: WorkWorkerState,
    execution_mode: ExecutionMode,
    emit: EmitCallback,
    checkpoint: CheckpointCallback,
    slot: int,
) -> WorkExecutionResult:
    """先校验 Factory 契约，再执行 Harness 已识别的项目质量命令。"""

    output_root = _default_output_root(harness)
    validation = await _validate_existing(
        root=root,
        output_root=output_root,
        agent_id=f"factory_validation:{work.id}",
        work_id=work.id,
    )
    state.quality["softwareFactoryValidation"] = validation
    state.factory_validations[output_root] = bool(validation.get("ok"))
    await checkpoint()
    if not bool(validation.get("ok")):
        return WorkExecutionResult(
            work_id=work.id,
            succeeded=False,
            summary="",
            error=(
                "SOFTWARE FACTORY VALIDATION FAILED: "
                + json.dumps(validation, ensure_ascii=False)[:6_000]
            ),
            state=state,
        )

    commands = work.validation_commands or harness.quality_commands
    validation_work = replace(work, validation_commands=list(commands))
    return await execute_validation_work(
        root=root,
        work=validation_work,
        state=state,
        execution_mode=execution_mode,
        emit=emit,
        checkpoint=checkpoint,
        slot=slot,
    )


async def _validate_existing(
    *,
    root: Path,
    output_root: str,
    agent_id: str,
    work_id: str,
) -> dict[str, Any]:
    """通过 Tool Gateway 校验已生成的数据契约和页面接入状态。"""

    result = await execute_code_tool(
        "software_factory.validate",
        root=root,
        arguments={"output_root": output_root},
        permissions={"read"},
        agent_id=agent_id,
        task_id=work_id,
    )
    return result if isinstance(result, dict) else {"ok": False, "errors": ["无效校验结果"]}


def _factory_artifacts_reusable(validation: dict[str, Any]) -> bool:
    """允许数据层结构有效但尚未绑定页面的产物被恢复任务直接复用。"""

    if bool(validation.get("ok")):
        return True
    errors = [str(item) for item in validation.get("errors", []) if str(item)]
    if not errors:
        return False
    integration_markers = ("尚未接入真实页面", "页面数据源接入")
    return all(any(marker in error for marker in integration_markers) for error in errors)


def _factory_mode(work: WorkItem) -> str:
    """根据 Work 目标稳定判断 Factory 的 plan 或 generate 阶段。"""

    text = f"{work.title} {work.objective}".lower()
    if any(term in text for term in ("生成", "generate", "openapi", "mock", "数据源")):
        return "generate"
    return "plan"


def _default_output_root(harness: ProjectHarness) -> str:
    """根据 Harness 源码根返回与 Software Factory 一致的默认目录。"""

    prefix = harness.source_root.strip("./")
    return f"{prefix}/features/commerce" if prefix else "features/commerce"


def _compact_factory_result(result: dict[str, Any]) -> dict[str, Any]:
    """只保存可恢复摘要，避免完整生成内容进入 Checkpoint 和下一轮 Prompt。"""

    blueprint = result.get("blueprint")
    validation = result.get("validation")
    artifacts = result.get("artifacts")
    return {
        "blueprint": blueprint if isinstance(blueprint, dict) else {},
        "validation": validation if isinstance(validation, dict) else {},
        "artifactCount": len(artifacts) if isinstance(artifacts, list) else 0,
        "changedFiles": [str(item) for item in result.get("changedFiles", [])][:50],
    }


__all__ = ["execute_factory_validation_work", "execute_factory_work"]
