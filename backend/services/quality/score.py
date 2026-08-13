"""质量分：五维加权（验证/风险/审核/过程/效率），无数据维度剔除并重新归一化。

全部输入来自已有模块（ValidationEngine / PatchAnalyzer / review_artifacts /
WorkWorkerState / token_budget），不引入新的 LLM 打分。
"""

from __future__ import annotations

from typing import Any

# 五维权重（仅在有数据时参与，无数据维度剔除后重新归一化）。
DEFAULT_WEIGHTS: dict[str, float] = {
    "validation": 0.35,
    "risk": 0.20,
    "review": 0.15,
    "process": 0.15,
    "efficiency": 0.15,
}


def _validation_score(validation: dict[str, Any] | None) -> float | None:
    """验证维度：全过=100，部分按通过比例折算；无验证数据返回 None。"""

    if not isinstance(validation, dict):
        return None
    checks = validation.get("checks")
    if not isinstance(checks, list) or not checks:
        return None
    executed = [check for check in checks if check.get("executed")]
    if not executed:
        return None
    passed = sum(1 for check in executed if check.get("passed"))
    return round(passed / len(executed) * 100)


def _risk_score(patch_risk: dict[str, Any] | None) -> float | None:
    """风险维度：用 risk.score（0-100，越高风险越大），映射 100-score。"""

    if not isinstance(patch_risk, dict):
        return None
    score = patch_risk.get("score")
    if not isinstance(score, (int, float)):
        return None
    return max(0, min(100, round(100 - float(score))))


def _review_score(review_artifact: dict[str, Any] | None) -> float | None:
    """审核维度：审结记录存在时按 risks 数量折算；无记录返回 None（剔除）。"""

    if not isinstance(review_artifact, dict):
        return None
    risks = review_artifact.get("risks")
    if not isinstance(risks, list):
        return None
    # 有 risks 列表说明已审结；风险条目越多扣得越多。
    return max(0, 100 - len(risks) * 15)


def _process_score(process: dict[str, Any] | None) -> float | None:
    """过程维度：零返工=100，每次返工/守卫拒绝按比例扣，守卫终止直接 0。"""

    if not isinstance(process, dict):
        return None
    guard_stopped = bool(process.get("guard_stopped"))
    if guard_stopped:
        return 0.0
    penalties = int(process.get("retries") or 0) * 15 + int(
        process.get("guard_rejections") or 0
    ) * 5
    return max(0, 100 - penalties)


def _efficiency_score(efficiency: dict[str, Any] | None) -> float | None:
    """效率维度：token 预算利用率越低越好，压缩节省加分。"""

    if not isinstance(efficiency, dict):
        return None
    consumed = float(efficiency.get("consumed") or 0)
    limit = float(efficiency.get("limit") or 0)
    if limit <= 0:
        return None
    usage_ratio = min(1.0, consumed / limit)
    bonus = min(10, int(efficiency.get("compressed_count") or 0) * 5)
    return round(max(0, min(100, (1 - usage_ratio) * 100 + bonus)))


_DIMENSION_FUNCS = {
    "validation": _validation_score,
    "risk": _risk_score,
    "review": _review_score,
    "process": _process_score,
    "efficiency": _efficiency_score,
}


def compute_quality_score(
    *,
    validation: dict[str, Any] | None = None,
    patch_risk: dict[str, Any] | None = None,
    review_artifact: dict[str, Any] | None = None,
    process: dict[str, Any] | None = None,
    efficiency: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """计算五维加权质量分；无数据维度剔除并重新归一化权重。"""

    inputs = {
        "validation": validation,
        "risk": patch_risk,
        "review": review_artifact,
        "process": process,
        "efficiency": efficiency,
    }
    dimensions: dict[str, float] = {}
    active_weights: dict[str, float] = {}
    for name, func in _DIMENSION_FUNCS.items():
        value = func(inputs.get(name))
        if value is not None:
            dimensions[name] = value
            active_weights[name] = DEFAULT_WEIGHTS[name]

    if not dimensions:
        return {"score": None, "dimensions": {}, "activeWeights": {}}

    weight_sum = sum(active_weights.values())
    normalized = {key: value / weight_sum for key, value in active_weights.items()}
    total = round(
        sum(dimensions[name] * normalized[name] for name in dimensions), 1
    )
    return {
        "score": total,
        "dimensions": {name: round(value) for name, value in dimensions.items()},
        "activeWeights": {name: round(value, 3) for name, value in normalized.items()},
    }


__all__ = ["DEFAULT_WEIGHTS", "compute_quality_score"]
