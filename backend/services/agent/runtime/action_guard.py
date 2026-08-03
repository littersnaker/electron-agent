"""代码写入前的轻量守卫与回归基线采集。"""

from __future__ import annotations

from pathlib import Path

from backend.quality.regression_detector import ContractSnapshot, RegressionDetector
from backend.services.agent.loop_protocol import EditOperation
from backend.services.agent.runtime.decision_gate import DecisionGate, DecisionGateResult
from backend.services.agent.runtime.reasoning_controller import ReasoningController
from backend.services.agent.runtime.reasoning_state import ReasoningState
from backend.services.agent.work_models import WorkItem
from backend.services.agent.work_state import WorkWorkerState


def guard_edit(
    *,
    root: Path,
    work: WorkItem,
    state: WorkWorkerState,
    operations: list[EditOperation],
) -> DecisionGateResult:
    """执行 Decision Gate，并在获批后保存修改前公共契约基线。"""

    reasoning = (
        ReasoningState.from_json(state.reasoning_state)
        if state.reasoning_state
        else ReasoningController().prepare(work)
    )
    result = DecisionGate().evaluate(
        work=work,
        operations=operations,
        reasoning=reasoning,
        validation_commands=work.validation_commands,
    )
    state.reasoning_state = reasoning.to_json()
    state.decision_gate = result.to_json()
    if result.approved:
        _merge_regression_baseline(root, state, [item.path for item in operations])
    return result


def record_factory_decision(
    *,
    work: WorkItem,
    state: WorkWorkerState,
    output_root: str,
) -> None:
    """为批量 Artifact 生成记录可审计决策，避免绕过修改前判断。"""

    target = output_root.strip() or "software-factory-default"
    state.decision_gate = {
        "approved": True,
        "reason": f"Software Factory 生成用于完成 {work.id}：{work.objective[:300]}",
        "validation": list(work.validation_commands or work.acceptance_criteria),
        "affectedModules": [target],
        "recovery": "生成失败时保留原文件，并通过 factory validate 检查一致性。",
    }


def _merge_regression_baseline(
    root: Path,
    state: WorkWorkerState,
    paths: list[str],
) -> None:
    """只记录第一次修改前签名，后续编辑不得覆盖原始基线。"""

    existing = ContractSnapshot.from_json(state.regression_baseline)
    captured = RegressionDetector().capture(root, paths)
    for path, signature in captured.signatures.items():
        existing.signatures.setdefault(path, signature)
    for path, content_hash in captured.artifact_hashes.items():
        existing.artifact_hashes.setdefault(path, content_hash)
    state.regression_baseline = existing.to_json()


__all__ = ["guard_edit", "record_factory_decision"]
