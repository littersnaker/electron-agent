"""工厂审计快速通道：本地先校验，需要判断时只打一次 LLM。

针对“审查/补齐 Mock、契约、数据源”这类纯数据层 Work：不再让模型 9 轮循环，
而是 1) 确定性校验本地产物；2) 产物缺失时确定性生成；3) 有产物后单次 LLM
直接返回“复用 / 打补丁 / 无法修复”的 JSON 结论；4) 按结论应用或收尾。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from backend.services.agent.harness import ProjectHarness
from backend.services.agent.shared.domain_rules import (
    default_factory_domain_id,
    factory_audit_rules,
)
from backend.services.agent.shared.loop_protocol import _parse_operations
from backend.services.agent.shared.loop_support import usage_add
from backend.services.agent.shared.work_models import WorkItem
from backend.services.agent.shared.work_state import WorkExecutionResult, WorkWorkerState
from backend.services.agent.shared.workspace_tools import apply_edit_operations
from backend.services.agent.worker.factory_work import (
    CheckpointCallback,
    EmitCallback,
    _default_output_root,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage
from backend.services.tools.code_tools import execute_code_tool

MAX_AUDIT_CONTEXT_CHARS = 24_000
MAX_AUDIT_FILES = 8
MAX_AUDIT_FILE_CHARS = 4_000
MAX_AUDIT_FILE_BYTES = 200_000

_OUT_OF_SCOPE_TERMS = tuple(
    str(item)
    for item in factory_audit_rules().get("outOfScopeTerms") or ()
)
_PATH_PATTERN = re.compile(r"[\w./\\-]+\.(?:ts|tsx|js|jsx|vue|py)")


def _classify_validation_errors(
    errors: list[object],
    output_root: str,
) -> tuple[list[str], list[str]]:
    """把校验错误分为数据层内错误与页面接入（目录外）错误。

    指向 ``output_root`` 之外的页面导入/绑定错误属于页面接入 Work 的职责，
    不应阻塞数据层审计 Work。
    """

    normalized_root = output_root.strip("/")
    in_scope: list[str] = []
    out_of_scope: list[str] = []
    for raw in errors:
        text = str(raw or "")
        lowered = text.lower()
        referenced_paths = _PATH_PATTERN.findall(lowered)
        points_outside = any(
            path and not path.strip("/").startswith(normalized_root)
            for path in referenced_paths
        )
        if points_outside or any(
            term in text for term in _OUT_OF_SCOPE_TERMS
        ):
            out_of_scope.append(text)
        else:
            in_scope.append(text)
    return in_scope, out_of_scope


def _collect_artifact_summary(root: Path, output_root: str) -> list[dict[str, str]]:
    """读取数据层产物的紧凑摘要，供 LLM 一次性判断。"""

    base = root / output_root
    if not base.is_dir():
        return []
    files: list[Path] = []
    for path in sorted(base.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            if path.stat().st_size > MAX_AUDIT_FILE_BYTES:
                continue
        except OSError:
            continue
        files.append(path)
    result: list[dict[str, str]] = []
    for path in files[:MAX_AUDIT_FILES]:
        try:
            content = path.read_text("utf-8", errors="replace")
        except OSError:
            continue
        relative = path.relative_to(root).as_posix()
        result.append(
            {
                "path": relative,
                "content": content[:MAX_AUDIT_FILE_CHARS],
            }
        )
        if sum(len(item["content"]) for item in result) >= MAX_AUDIT_CONTEXT_CHARS:
            break
    return result


def _compact_validation(
    validation: Any,
    output_root: str,
) -> dict[str, Any]:
    """把校验结果压缩成 LLM 可读清单，并按职责范围分类错误。"""

    if not isinstance(validation, dict):
        return {"ok": False, "errors": ["校验工具返回了无效结果"]}
    raw_errors = [str(item) for item in validation.get("errors", [])]
    in_scope, out_of_scope = _classify_validation_errors(
        raw_errors,
        output_root,
    )
    return {
        # 只有数据层内错误才影响本 Work 的成败；页面接入类错误由页面 Work 处理。
        "ok": not in_scope,
        "errors": in_scope[:10],
        "warnings": [str(item) for item in validation.get("warnings", [])][:10],
        "outOfScope": out_of_scope[:10],
    }


def _audit_prompt(
    *,
    work: WorkItem,
    request_text: str,
    output_root: str,
    validation: dict[str, Any],
    artifacts: list[dict[str, str]],
) -> tuple[str, str]:
    """生成单次审计调用的系统提示与用户上下文。"""

    system = """你是 Software Factory 数据层审计员。只返回一个 JSON 对象，不得附加 Markdown：
{
  "verdict": "reuse" | "patch" | "cannot_fix",
  "reason": "一句话说明判断依据",
  "operations": []
}
verdict 规则：
- reuse：现有产物已满足当前 Work 验收标准，无需修改；
- patch：产物大体可用，只需小幅补齐，operations 按 edit 协议填写
  （write 用 content，replace 用 oldText/newText），path 必须是相对路径且位于数据层目录内；
- cannot_fix：需要整批重新生成或缺失关键文件，无法用补丁解决。
错误必须修复后才能返回 reuse；只有警告时可以 reuse。"""
    user = {
        "request": request_text[:2_000],
        "work": {
            "id": work.id,
            "title": work.title,
            "objective": work.objective[:2_000],
            "acceptanceCriteria": work.acceptance_criteria[:8],
        },
        "outputRoot": output_root,
        "validation": validation,
        "artifacts": artifacts,
    }
    return system, json.dumps(user, ensure_ascii=False, indent=2)


def _parse_verdict(text: str, output_root: str) -> dict[str, Any]:
    """解析单次审计结论；非法输出抛出 ValueError。"""

    stripped = text.strip()
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end < start:
        raise ValueError("审计模型没有返回 JSON 结论")
    raw = json.loads(stripped[start : end + 1])
    if not isinstance(raw, dict):
        raise ValueError("审计模型返回必须是 JSON 对象")
    verdict = str(raw.get("verdict") or "").strip().lower()
    if verdict not in {"reuse", "patch", "cannot_fix"}:
        raise ValueError(f"审计结论无效：{verdict or '空'}")
    operations = []
    if verdict == "patch":
        operations = _parse_operations(raw.get("operations"))
        for operation in operations:
            normalized = operation.path.strip("/").replace("\\", "/")
            if not normalized.startswith(output_root.strip("/")):
                raise ValueError(
                    f"补丁路径 {operation.path} 超出数据层目录 {output_root}"
                )
    return {
        "verdict": verdict,
        "reason": str(raw.get("reason") or "")[:500],
        "operations": operations,
    }


async def execute_factory_audit_work(
    *,
    root: Path,
    request_text: str,
    work: WorkItem,
    harness: ProjectHarness,
    preferred_model_id: str,
    credentials: LlmCredentials,
    state: WorkWorkerState,
    emit: EmitCallback,
    checkpoint: CheckpointCallback,
    slot: int,
) -> WorkExecutionResult:
    """执行一次“校验 → 补生成 → 单次 LLM 判定”的快速审计。"""

    agent_id = f"factory_audit:{work.id}"
    output_root = _default_output_root(harness)
    await emit(
        "lifecycle",
        {
            "role": "software_factory",
            "agentId": agent_id,
            "slot": slot,
            "status": "running",
            "detail": f"{work.id} · {work.title}：本地校验数据层产物",
            "toolName": "software_factory.validate",
        },
    )

    async def run_validate() -> dict[str, Any]:
        result = await execute_code_tool(
            "software_factory.validate",
            root=root,
            arguments={"output_root": output_root},
            permissions={"read"},
            agent_id=agent_id,
            task_id=work.id,
        )
        return _compact_validation(result, output_root)

    validation = await run_validate()
    state.factory_validations[output_root] = bool(validation.get("ok"))

    # 产物整体缺失（无生成清单）时，先确定性补生成，不调用模型。
    if not validation.get("ok") and any(
        "找不到生成清单" in str(error) for error in validation.get("errors", [])
    ):
        await emit(
            "lifecycle",
            {
                "role": "software_factory",
                "agentId": agent_id,
                "slot": slot,
                "status": "running",
                "detail": f"{work.id}：数据层产物缺失，确定性生成中",
                "toolName": "software_factory.generate",
            },
        )
        try:
            await execute_code_tool(
                "software_factory.generate",
                root=root,
                arguments={
                    "request_text": request_text,
                    "domain_id": default_factory_domain_id(),
                    "output_root": output_root,
                    "mock_count": 12,
                    "overwrite": False,
                },
                permissions={"write"},
                agent_id=agent_id,
                task_id=work.id,
            )
            validation = await run_validate()
            state.factory_validations[output_root] = bool(validation.get("ok"))
        except Exception as exc:
            return WorkExecutionResult(
                work_id=work.id,
                succeeded=False,
                summary="",
                error=f"FACTORY AUDIT GENERATE FAILED: {exc}",
                state=state,
                failure_kind="code",
            )

    artifacts = _collect_artifact_summary(root, output_root)
    system, user = _audit_prompt(
        work=work,
        request_text=request_text,
        output_root=output_root,
        validation=validation,
        artifacts=artifacts,
    )
    await emit(
        "lifecycle",
        {
            "role": "software_factory",
            "agentId": agent_id,
            "slot": slot,
            "status": "running",
            "detail": f"{work.id}：单次模型判定产物可用性与缺口",
        },
    )
    try:
        text, usage, model = await GATEWAY.complete(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=[
                LlmMessage("system", system),
                LlmMessage("user", user),
            ],
            temperature=0.1,
            audit={"agentRole": "factory_audit"},
        )
    except Exception as exc:
        return WorkExecutionResult(
            work_id=work.id,
            succeeded=False,
            summary="",
            error=f"FACTORY AUDIT LLM FAILED: {exc}",
            state=state,
            failure_kind="runtime",
        )
    usage_add(state.usage, usage)
    state.model_name = model.name
    await checkpoint()

    try:
        verdict = _parse_verdict(text, output_root)
    except ValueError as exc:
        return WorkExecutionResult(
            work_id=work.id,
            succeeded=False,
            summary="",
            error=f"FACTORY AUDIT PROTOCOL: {exc}",
            state=state,
            failure_kind="runtime",
        )

    if verdict["verdict"] == "reuse":
        state.factory_validations[output_root] = True
        await emit(
            "lifecycle",
            {
                "role": "software_factory",
                "agentId": agent_id,
                "slot": slot,
                "status": "completed",
                "detail": f"{work.id}：产物可复用，{verdict['reason'][:120]}",
            },
        )
        await checkpoint()
        return WorkExecutionResult(
            work_id=work.id,
            succeeded=True,
            summary=f"数据层产物可直接复用：{verdict['reason']}" or "产物已满足要求",
            error="",
            state=state,
        )

    if verdict["verdict"] == "cannot_fix":
        return WorkExecutionResult(
            work_id=work.id,
            succeeded=False,
            summary="",
            error=f"FACTORY AUDIT CANNOT FIX: {verdict['reason']}",
            state=state,
            failure_kind="code",
        )

    try:
        edit_result = apply_edit_operations(root, verdict["operations"])
    except Exception as exc:
        return WorkExecutionResult(
            work_id=work.id,
            succeeded=False,
            summary="",
            error=f"FACTORY AUDIT PATCH FAILED: {exc}",
            state=state,
            failure_kind="code",
        )
    for path in edit_result.changed_files:
        if path not in state.changed_files:
            state.changed_files.append(path)
    validation_after = await run_validate()
    state.factory_validations[output_root] = bool(validation_after.get("ok"))
    await checkpoint()
    if not validation_after.get("ok"):
        return WorkExecutionResult(
            work_id=work.id,
            succeeded=False,
            summary="",
            error=(
                "FACTORY AUDIT PATCH STILL INVALID: "
                + "；".join(validation_after.get("errors") or [])
            ),
            state=state,
            failure_kind="code",
        )
    await emit(
        "lifecycle",
        {
            "role": "software_factory",
            "agentId": agent_id,
            "slot": slot,
            "status": "completed",
            "detail": f"{work.id}：已补齐 {len(edit_result.changed_files)} 个数据层文件并通过校验",
        },
    )
    return WorkExecutionResult(
        work_id=work.id,
        succeeded=True,
        summary=(
            f"已补齐 {len(edit_result.changed_files)} 个数据层文件并通过一致性校验"
        ),
        error="",
        state=state,
    )


__all__ = ["execute_factory_audit_work"]
