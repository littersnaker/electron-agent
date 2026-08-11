"""WorkList 确定性拆分器测试（纯文件数量，不认业务域）。"""

from __future__ import annotations

from backend.services.agent.shared.work_models import WorkItem
from backend.services.agent.worker.worklist_normalizer import (
    MAX_WORK_TARGET_FILES,
    split_oversized_works,
    split_works_by_size,
)


def test_oversized_work_is_split_by_file_count() -> None:
    """35 个文件的 Work 应切成 3 批，每批不超过上限。"""

    work = WorkItem(
        id="W001",
        title="全站样式统一",
        objective="统一全站风格",
        target_files=[f"src/pages/page_{index}.tsx" for index in range(35)],
        execution_type="coding",
    )

    result = split_oversized_works([work])

    assert len(result) == 3
    assert all(len(item.target_files) <= MAX_WORK_TARGET_FILES for item in result)
    assert all(item.id != "W001" for item in result)
    assert len({item.id for item in result}) == 3


def test_dependents_remap_to_all_chunks() -> None:
    """依赖被拆分 Work 的其他 Work，应改为依赖全部子 Work。"""

    big = WorkItem(
        id="W001",
        title="大任务",
        objective="x",
        target_files=[f"file_{index}.ts" for index in range(30)],
        execution_type="coding",
    )
    dependent = WorkItem(
        id="W002",
        title="验证",
        objective="y",
        dependencies=["W001"],
        execution_type="validation",
    )

    result = split_oversized_works([big, dependent])

    chunks = [item for item in result if item.id != "W002"]
    dependent_after = next(item for item in result if item.id == "W002")
    assert set(dependent_after.dependencies) == {item.id for item in chunks}


def test_small_work_untouched() -> None:
    """不超过上限的 Work 保持原样。"""

    work = WorkItem(
        id="W001",
        title="小任务",
        objective="x",
        target_files=["a.ts", "b.ts"],
        execution_type="coding",
    )

    assert split_oversized_works([work]) == [work]


def test_work_is_split_by_content_size(tmp_path) -> None:
    """目标文件内容总和超限时，应按体积拆成多个可批量直写的子 Work。"""

    (tmp_path / "src").mkdir()
    paths = [f"src/page_{index}.tsx" for index in range(4)]
    for path in paths:
        (tmp_path / path).write_text("x" * 20_000, "utf-8")
    work = WorkItem(
        id="W001",
        title="商品列表与详情",
        objective="x",
        target_files=paths,
        execution_type="coding",
    )

    works = [work]
    notes = split_works_by_size(works, tmp_path, max_chars=50_000, max_files=12)

    assert len(works) == 2
    assert all(item.id != "W001" for item in works)
    assert len(notes) == 1
    assert "W001" in notes[0]


def test_size_split_keeps_each_chunk_within_limits(tmp_path) -> None:
    """每个子 Work 的文件总数与总字节估计都不超过上限。"""

    (tmp_path / "src").mkdir()
    paths = [f"src/page_{index}.tsx" for index in range(8)]
    for path in paths:
        (tmp_path / path).write_text("y" * 18_000, "utf-8")
    work = WorkItem(
        id="W005",
        title="购物车页面",
        objective="x",
        target_files=paths,
        execution_type="coding",
    )

    works = [work]
    split_works_by_size(works, tmp_path, max_chars=40_000, max_files=12)
    assert len(works) == 4
    for item in works:
        total = sum(
            (tmp_path / path).stat().st_size for path in item.target_files
        )
        assert total <= 40_000


def test_size_split_skips_non_coding_works(tmp_path) -> None:
    """validation/artifact 等非批量直写 Work 不参与体积拆分。"""

    (tmp_path / "a.ts").write_text("x" * 100_000, "utf-8")
    validation = WorkItem(
        id="W002",
        title="验证",
        objective="x",
        target_files=["a.ts"],
        execution_type="validation",
        validation_commands=["pytest"],
    )

    split_works_by_size([validation], tmp_path, max_chars=10_000, max_files=1)
    assert validation.id == "W002"
    assert validation.target_files == ["a.ts"]


def test_size_split_remaps_dependencies(tmp_path) -> None:
    """依赖被拆分 Work 的其他 Work，应改为依赖全部子 Work。"""

    (tmp_path / "src").mkdir()
    paths = [f"src/page_{index}.tsx" for index in range(4)]
    for path in paths:
        (tmp_path / path).write_text("z" * 20_000, "utf-8")
    big = WorkItem(
        id="W001",
        title="大任务",
        objective="x",
        target_files=paths,
        execution_type="coding",
    )
    dependent = WorkItem(
        id="W002",
        title="验证",
        objective="y",
        dependencies=["W001"],
        execution_type="validation",
    )

    split_works_by_size([big, dependent], tmp_path, max_chars=50_000, max_files=12)
    dependents = [item for item in [big, dependent] if item.id == "W002"]
    assert dependents[0].dependencies
    assert "W001" not in dependents[0].dependencies
