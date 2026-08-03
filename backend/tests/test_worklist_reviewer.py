"""WorkList 确定性审查与再分配测试。"""

from __future__ import annotations

from backend.services.agent.work_models import WorkItem
from backend.services.agent.worklist_reviewer import review_worklist


def _work(
    work_id: str,
    title: str,
    objective: str,
    *,
    dependencies: list[str] | None = None,
    target_files: list[str] | None = None,
    execution_type: str = "coding",
) -> WorkItem:
    """构造测试 Work。"""

    return WorkItem(
        id=work_id,
        title=title,
        objective=objective,
        dependencies=dependencies or [],
        target_files=target_files or [],
        execution_type=execution_type,  # type: ignore[arg-type]
    )


def test_dependency_cycle_is_broken() -> None:
    """W001→W002→W001 的依赖环必须被确定性移除一条边。"""

    works = [
        _work("W001", "A", "x", dependencies=["W002"]),
        _work("W002", "B", "y", dependencies=["W001"]),
    ]

    normalized, report = review_worklist(works)

    assert any("依赖环" in note for note in report.adjustments)
    by_id = {item.id: item for item in normalized}
    assert "W002" not in by_id["W001"].dependencies
    # 环断开一条边后，剩下的 W002→W001 是合法依赖，不再是环。
    assert "W001" in by_id["W002"].dependencies


def test_invalid_and_self_dependencies_are_removed() -> None:
    """无效依赖与自引用依赖应被清理。"""

    works = [
        _work("W001", "A", "x", dependencies=["W001", "W999"]),
    ]

    normalized, report = review_worklist(works)

    assert normalized[0].dependencies == []
    assert any("自引用" in note for note in report.adjustments)
    assert any("不存在" in note for note in report.adjustments)


def test_sensitive_paths_are_filtered() -> None:
    """敏感路径（如 .env）不得进入 Work 目标文件。"""

    works = [
        _work("W001", "配置", "x", target_files=["src/app.ts", ".env"]),
    ]

    normalized, report = review_worklist(works)

    assert normalized[0].target_files == ["src/app.ts"]
    assert any("敏感路径" in note for note in report.adjustments)


def test_factory_generate_work_reclassified_to_artifact() -> None:
    """纯契约/Mock 生成类 Work 应改走确定性 artifact 执行器。"""

    works = [
        _work(
            "W001",
            "生成 Mock 与 OpenAPI 数据源",
            "调用 factory generate 生成数据层产物",
        ),
    ]

    normalized, report = review_worklist(works)

    assert normalized[0].execution_type == "artifact"
    assert any("→ artifact" in note for note in report.adjustments)


def test_validation_only_work_reclassified() -> None:
    """纯验证类 Work 应改走确定性验证执行器。"""

    works = [
        _work("W001", "质量验证", "运行测试并输出结果"),
    ]

    normalized, _report = review_worklist(works)

    assert normalized[0].execution_type == "validation"


def test_edit_intent_work_stays_coding() -> None:
    """含修复意图的 Work 不得被误判为纯验证。"""

    works = [
        _work("W001", "修复测试", "修复测试失败并运行测试"),
    ]

    normalized, _report = review_worklist(works)

    assert normalized[0].execution_type == "coding"


def test_oversized_work_split_is_reported() -> None:
    """超过 15 个文件的 Work 应被拆分并在报告中说明。"""

    works = [
        _work(
            "W001",
            "全站样式统一",
            "统一风格",
            target_files=[f"src/pages/page_{index}.tsx" for index in range(35)],
        ),
    ]

    normalized, report = review_worklist(works)

    assert len(normalized) == 3
    assert any("已拆分" in note for note in report.adjustments)


def test_duplicate_target_files_are_deduped() -> None:
    """同一 Work 内重复的目标文件应去重。"""

    works = [
        _work("W001", "A", "x", target_files=["a.ts", "a.ts", "b.ts"]),
    ]

    normalized, report = review_worklist(works)

    assert normalized[0].target_files == ["a.ts", "b.ts"]
    assert any("去重" in note for note in report.adjustments)


def test_clean_worklist_produces_no_adjustments() -> None:
    """规范的工作列表不应产生任何调整。"""

    works = [
        _work("W001", "修复购物车", "修复购物车状态", target_files=["src/cart.ts"]),
    ]

    normalized, report = review_worklist(works)

    assert normalized == works
    assert report.adjustments == []
