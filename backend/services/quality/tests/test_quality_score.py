"""质量分计算测试：五维加权、无数据剔除归一化、边界。"""

from __future__ import annotations

from backend.services.quality.score import compute_quality_score


def test_all_five_dimensions_present() -> None:
    """五维都有数据时按权重加权。"""

    result = compute_quality_score(
        validation={"checks": [{"executed": True, "passed": True}]},
        patch_risk={"score": 10},
        review_artifact={"risks": []},
        process={"retries": 0, "guard_rejections": 0, "guard_stopped": False},
        efficiency={"consumed": 0, "limit": 128000, "compressed_count": 0},
    )
    assert result["score"] is not None
    assert result["score"] >= 90  # 全维度高分
    assert set(result["dimensions"].keys()) == {
        "validation",
        "risk",
        "review",
        "process",
        "efficiency",
    }
    assert abs(sum(result["activeWeights"].values()) - 1.0) < 0.01


def test_missing_dimension_excluded_and_normalized() -> None:
    """无审核数据时剔除该维度，权重重新归一化。"""

    result = compute_quality_score(
        validation={"checks": [{"executed": True, "passed": True}]},
        patch_risk={"score": 10},
        review_artifact=None,  # 无复盘记录 → 剔除
        process={"retries": 0, "guard_rejections": 0, "guard_stopped": False},
        efficiency={"consumed": 0, "limit": 128000, "compressed_count": 0},
    )
    assert "review" not in result["dimensions"]
    assert "review" not in result["activeWeights"]
    assert abs(sum(result["activeWeights"].values()) - 1.0) < 0.01
    assert result["score"] is not None


def test_guard_stopped_scores_zero_on_process() -> None:
    """守卫终止时过程维度为 0。"""

    result = compute_quality_score(
        process={"retries": 2, "guard_rejections": 5, "guard_stopped": True},
    )
    assert result["dimensions"]["process"] == 0


def test_validation_partial_pass_ratio() -> None:
    """验证部分通过按比例折算。"""

    result = compute_quality_score(
        validation={
            "checks": [
                {"executed": True, "passed": True},
                {"executed": True, "passed": False},
            ]
        },
    )
    assert result["dimensions"]["validation"] == 50


def test_empty_inputs_returns_null_score() -> None:
    """完全没有数据时返回空结果，不报错。"""

    result = compute_quality_score()
    assert result["score"] is None
    assert result["dimensions"] == {}
    assert result["activeWeights"] == {}
