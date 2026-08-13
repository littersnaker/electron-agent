"""精简 worklist 解析测试：最小 schema 补全、acceptance 派生、重规划兼容。"""

from __future__ import annotations

from backend.services.agent.planner.task_planner import (
    _derive_acceptance,
    _parse_work_items,
)


def test_parse_minimal_schema_backfills_fields() -> None:
    """模型只输出最小字段时，应补全 executionType/priority/acceptance/validation。"""

    works = _parse_work_items(
        [
            {
                "id": "W001",
                "title": "实现 Hero 动画",
                "objective": "实现 Hero 滚动动画，要求滚动时标题淡入并固定在顶部。",
                "targetFiles": ["src/components/HeroSection.tsx"],
            },
            {
                "id": "W002",
                "title": "实现 Product 区块",
                "objective": "实现 Product 区块；",
                "targetFiles": ["src/components/ProductSection.tsx"],
                "dependencies": ["W001"],
            },
        ]
    )

    assert len(works) == 2
    w1 = works[0]
    # 默认字段补全。
    assert w1.execution_type == "agent"
    assert w1.priority == 100
    assert w1.serial_group == ""
    assert w1.validation_commands == []
    # acceptance 从 objective 派生非空。
    assert w1.acceptance_criteria, "acceptance 不应为空"
    assert any("滚动" in item or "Hero" in item for item in w1.acceptance_criteria)
    # 依赖保留。
    assert works[1].dependencies == ["W001"]


def test_derive_acceptance_splits_sentences() -> None:
    """acceptance 派生应按句子拆分并限 3 条。"""

    derived = _derive_acceptance("实现首页。要求深色模式。支持移动端适配。额外的。")
    assert len(derived) <= 3
    assert derived[0] == "实现首页"


def test_derive_acceptance_empty_objective() -> None:
    """objective 为空时派生返回空。"""

    assert _derive_acceptance("") == []


def test_parse_acceptance_preserved_when_provided() -> None:
    """模型提供了 acceptance 时应原样保留，不覆盖。"""

    works = _parse_work_items(
        [
            {
                "id": "W001",
                "title": "t",
                "objective": "实现功能。",
                "acceptanceCriteria": ["自定义验收 A", "自定义验收 B"],
                "targetFiles": ["a.ts"],
            }
        ]
    )
    assert works[0].acceptance_criteria == ["自定义验收 A", "自定义验收 B"]


def test_parse_worklist_still_supports_full_schema() -> None:
    """旧版全字段输出仍兼容（向后兼容）。"""

    works = _parse_work_items(
        [
            {
                "id": "W001",
                "title": "t",
                "objective": "o",
                "acceptanceCriteria": ["a"],
                "dependencies": [],
                "priority": 5,
                "targetFiles": ["x.ts"],
                "serialGroup": "g1",
                "executionType": "validation",
                "validationCommands": ["pnpm lint"],
            }
        ]
    )
    w = works[0]
    assert w.priority == 5
    assert w.serial_group == "g1"
    assert w.execution_type == "validation"
    assert w.validation_commands == ["pnpm lint"]
