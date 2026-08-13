"""Code Agent 最终质量审查编排。

该模块在全部 Work 收束后串联 Patch Intelligence、风险、验证、回归、质量门和
Artifact Memory，不修改现有 DAG 或并发执行结构。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from backend.services.agent.shared.command_runner import (
    CommandResult,
    is_high_risk_command,
    run_safe_command,
)
from backend.services.agent.shared.loop_support import ExecutionMode
from backend.services.agent.shared.work_state import WorkWorkerState
from backend.services.artifact_memory import ArtifactIndex, ArtifactRecord
from backend.services.quality.code_gate import CodeGate
from backend.services.quality.patch_analyzer import PatchAnalyzer
from backend.services.quality.regression_detector import ContractSnapshot, RegressionDetector
from backend.services.quality.validation_engine import ValidationEngine


@dataclass(slots=True)
class ExecutionQualityReport:
    """保存最终质量结论和 UI 所需的核心指标。"""

    payload: dict[str, Any]
    executed_commands: list[CommandResult]

    def to_json(self) -> dict[str, Any]:
        """返回稳定 JSON 副本，避免调用方修改内部状态。"""

        return dict(self.payload)


async def review_execution(
    *,
    root: Path,
    changed_files: list[str],
    command_results: list[CommandResult],
    worker_states: dict[str, WorkWorkerState],
    execution_mode: ExecutionMode,
) -> ExecutionQualityReport:
    """执行最终质量链，并返回新增命令结果和结构化报告。"""

    artifact_dependencies = _artifact_dependencies(worker_states)
    patch = PatchAnalyzer().analyze(
        changed_files=changed_files,
        artifact_dependencies=artifact_dependencies,
    )
    validation_engine = ValidationEngine()
    validation = validation_engine.from_existing_results(
        risk=patch.risk.level.value,
        results=command_results,
    )
    executed: list[CommandResult] = []
    skipped_high_risk: list[str] = []
    if execution_mode == "full_auto":
        plan = validation_engine.plan(
            root=root,
            changed_files=changed_files,
            risk=patch.risk.level.value,
        )
        existing_commands = {item.command for item in command_results}
        # 沙箱 A 层：会执行工作区代码/配置的验证命令（pytest/eslint 等）跳过，
        # 避免配置劫持。跳过项从 checks 移除，不计入验证失败，仅在报告中标注。
        plan.checks = [
            check
            for check in plan.checks
            if not (
                check.command not in existing_commands
                and is_high_risk_command(check.command)
            )
        ]
        for check in plan.checks:
            if check.command in existing_commands:
                check.result = next(
                    item for item in command_results if item.command == check.command
                )
                continue
            if is_high_risk_command(check.command):
                skipped_high_risk.append(check.command)
                continue
            check.result = await run_safe_command(root, check.command)
            executed.append(check.result)
        plan.executed = bool(plan.checks)
        validation = plan

    baseline = _merge_baselines(worker_states)
    regression = RegressionDetector().detect(
        root=root,
        baseline=baseline,
        validation=validation,
        artifact_dependencies=artifact_dependencies,
    )
    gate = CodeGate().evaluate(
        root=root,
        changed_files=changed_files,
        risk=patch.risk,
        validation=validation,
        regression=regression,
    )
    artifact_metrics = _index_artifacts(root, changed_files, worker_states)
    # 视觉验证标记：检测到前端文件改动时，通知前端截图 + GLM 视觉核对。
    frontend_changed = [
        path
        for path in changed_files
        if Path(path).suffix.lower() in {".tsx", ".ts", ".css", ".html", ".jsx"}
    ]
    visual_verify = {}
    if frontend_changed:
        task_summary = _task_summary(worker_states)
        visual_verify = {
            "requested": True,
            "frontendChanged": frontend_changed[:20],
            "taskSummary": task_summary,
        }
    # 质量分五维：验证/风险来自本轮 review，审核来自复盘落库，过程/效率来自 Worker 状态。
    from backend.services.quality.score import compute_quality_score

    process_state = _process_dimension(worker_states)
    efficiency_state = _efficiency_dimension(worker_states)
    quality_score = compute_quality_score(
        validation=validation.to_json(),
        patch_risk={"score": patch.risk.score},
        review_artifact=None,  # 审核维度由异步复盘填充，本轮不阻塞等待。
        process=process_state,
        efficiency=efficiency_state,
    )
    _record_quality_score(worker_states, quality_score)
    payload = {
        "changes": len(changed_files),
        "risk": patch.risk.level.value,
        "riskScore": patch.risk.score,
        "validationPassed": validation.passed,
        "validationExecuted": validation.executed,
        "regression": regression.regression,
        "apiContractChanged": regression.api_contract_changed,
        "codeGatePassed": gate.passed,
        "affectedFiles": patch.affected_files,
        "validationRequired": patch.validation_required,
        "validation": validation.to_json(),
        "regressionReport": regression.to_json(),
        "codeGate": gate.to_json(),
        "artifactMemory": artifact_metrics,
        # 沙箱 A 层：因会执行项目代码/配置而跳过的高危验证命令（不在报告中标记失败）。
        "validationSkippedHighRisk": skipped_high_risk,
        # 视觉验证：前端改动时请求截图 + GLM 视觉核对（纯增强，不阻塞 review）。
        "visualVerify": visual_verify,
        # 质量分：五维加权（验证/风险/审核/过程/效率），无数据维度剔除归一化。
        "qualityScore": quality_score,
    }
    for state in worker_states.values():
        state.quality = dict(payload)
    return ExecutionQualityReport(payload=payload, executed_commands=executed)


def _merge_baselines(worker_states: dict[str, WorkWorkerState]) -> ContractSnapshot:
    """合并各 Worker 第一次修改前保存的公共契约基线。"""

    merged = ContractSnapshot()
    for state in worker_states.values():
        current = ContractSnapshot.from_json(state.regression_baseline)
        for path, signature in current.signatures.items():
            merged.signatures.setdefault(path, signature)
        for path, content_hash in current.artifact_hashes.items():
            merged.artifact_hashes.setdefault(path, content_hash)
    return merged


def _artifact_dependencies(worker_states: dict[str, WorkWorkerState]) -> list[str]:
    """从 Work Context 汇总跨 Work 传递的 Artifact 引用。"""

    references: list[str] = []
    for state in worker_states.values():
        for value in state.work_context.get("artifactRefs", []):
            path = str(value)
            if path and path not in references:
                references.append(path)
    return references


def _process_dimension(worker_states: dict[str, WorkWorkerState]) -> dict[str, Any]:
    """过程维度数据：聚合各 Work 的返工/守卫计数。"""

    retries = max((state.attempt_number for state in worker_states.values()), default=0)
    rejections = sum(state.guard_rejections for state in worker_states.values())
    stopped = any(bool(state.quality.get("budgetCompacted")) for state in worker_states.values())
    return {
        "retries": max(0, retries - 1),
        "guard_rejections": rejections,
        "guard_stopped": stopped,
    }


def _efficiency_dimension(worker_states: dict[str, WorkWorkerState]) -> dict[str, Any]:
    """效率维度数据：token 预算利用率与压缩节省。"""

    consumed = 0.0
    limit = 0.0
    compressed = 0
    for state in worker_states.values():
        budget = state.token_budget or {}
        worker = budget.get("worker") or {}
        consumed += float(worker.get("consumed") or 0)
        limit += float(worker.get("limit") or 0)
        compressed += int(worker.get("compressed") or 0)
    return {"consumed": consumed, "limit": limit, "compressed_count": compressed}


def _record_quality_score(
    worker_states: dict[str, WorkWorkerState],
    quality_score: dict[str, Any],
) -> None:
    """把质量分写入 quality_scores 表（失败只告警）。"""

    score = quality_score.get("score")
    if score is None or not worker_states:
        return
    try:
        from backend.services.workspace.database import dumps_json, open_database, utc_now_iso

        work_id = next(iter(worker_states))
        async def _write() -> None:
            async with open_database() as connection:
                await connection.execute(
                    "INSERT INTO quality_scores "
                    "(work_id, session_id, score, dimensions_json, active_weights_json, created_at) "
                    "VALUES (?, '', ?, ?, ?, ?)",
                    (
                        work_id,
                        float(score),
                        dumps_json(quality_score.get("dimensions") or {}),
                        dumps_json(quality_score.get("activeWeights") or {}),
                        utc_now_iso(),
                    ),
                )
        import asyncio

        asyncio.get_running_loop().create_task(_write())
    except Exception:  # noqa: BLE001 - 质量分落库失败不影响 review。
        pass


def _task_summary(worker_states: dict[str, WorkWorkerState]) -> str:
    """从 Worker 状态中提取任务目标摘要，供视觉验证 prompt 使用。"""

    summaries: list[str] = []
    for state in worker_states.values():
        context = state.work_context or {}
        objective = str(context.get("objective") or "").strip()
        if objective:
            summaries.append(objective[:300])
    return "；".join(summaries)[:1000] or "前端页面改动"


def _index_artifacts(
    root: Path,
    changed_files: list[str],
    worker_states: dict[str, WorkWorkerState],
) -> dict[str, int]:
    """将结构化产物写入持久化索引，并统计新增、更新和复用数量。"""

    index = ArtifactIndex(root / ".agent-data" / "artifact-memory.json")
    source_by_path = {
        path: work_id
        for work_id, state in worker_states.items()
        for path in state.changed_files
    }
    created = 0
    updated = 0
    reused = 0
    for relative in changed_files:
        path = root / relative
        if not path.is_file() or path.suffix.lower() not in {
            ".json",
            ".yaml",
            ".yml",
            ".html",
            ".md",
        }:
            continue
        content = path.read_bytes()
        content_hash = hashlib.sha256(content).hexdigest()
        artifact_id = str(uuid5(NAMESPACE_URL, relative.replace("\\", "/")))
        existed = index.get(artifact_id) is not None
        _, was_reused = index.upsert(
            ArtifactRecord(
                id=artifact_id,
                hash=content_hash,
                type=path.suffix.lower().lstrip("."),
                dependencies=[],
                source_work=source_by_path.get(relative, ""),
                path=relative.replace("\\", "/"),
            )
        )
        if was_reused:
            reused += 1
        elif existed:
            updated += 1
        else:
            created += 1
    return {"created": created, "updated": updated, "reused": reused}


__all__ = ["ExecutionQualityReport", "review_execution"]
