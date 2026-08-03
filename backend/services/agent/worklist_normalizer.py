"""WorkList 确定性归一化：不依赖业务域，只按文件体积拆分超大 Work。

Planner 可能把几十个页面塞进一个 Work，导致批量直写失效、退回多轮循环。
这里在规划后按“每个 Work 目标文件数量”纯代码拆分，任何项目类型都适用。
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from backend.services.agent.work_models import WorkItem

MAX_WORK_TARGET_FILES = 15
MAX_SPLIT_CHARS = 40_000
MAX_SPLIT_FILES = 12


def split_oversized_works(works: list[WorkItem]) -> list[WorkItem]:
    """把 targetFiles 超过上限的 Work 按文件数量切成多批。

    - 只按文件数量切，不识别业务域或目录语义；
    - 拆分后的子 Work 保留原依赖/优先级/串行组，只替换 id、标题和目标文件；
    - 依赖原 Work 的其他 Work 会改为依赖全部子 Work。
    """

    result: list[WorkItem] = []
    used_ids = {item.id for item in works}
    replacement_map: dict[str, list[str]] = {}

    for work in works:
        targets = list(
            dict.fromkeys(path for path in work.target_files if path.strip())
        )
        if len(targets) <= MAX_WORK_TARGET_FILES:
            result.append(work)
            continue
        chunks = [
            targets[index : index + MAX_WORK_TARGET_FILES]
            for index in range(0, len(targets), MAX_WORK_TARGET_FILES)
        ]
        sub_ids: list[str] = []
        for index, chunk in enumerate(chunks, start=1):
            sub_id = _sub_work_id(work.id, index, used_ids)
            used_ids.add(sub_id)
            sub_ids.append(sub_id)
            result.append(
                replace(
                    work,
                    id=sub_id,
                    title=f"{work.title}（{index}/{len(chunks)}）",
                    target_files=chunk,
                    status="pending",
                    attempts=0,
                    summary="",
                    error="",
                    changed_files=[],
                    commands=[],
                )
            )
        replacement_map[work.id] = sub_ids

    if replacement_map:
        for item in result:
            dependencies: list[str] = []
            for dependency in item.dependencies:
                if dependency in replacement_map:
                    dependencies.extend(replacement_map[dependency])
                else:
                    dependencies.append(dependency)
            item.dependencies = list(
                dict.fromkeys(
                    value for value in dependencies if value != item.id
                )
            )
    return result


def _sub_work_id(base_id: str, index: int, used_ids: set[str]) -> str:
    """生成稳定且不冲突的子 Work ID。"""

    stem = base_id[:34]
    for suffix in (f"S{index}", f"{index}", f"P{index}"):
        candidate = f"{stem}{suffix}"[:40]
        if candidate not in used_ids:
            return candidate
    raise ValueError(f"无法为 {base_id} 生成拆分 Work ID")


def split_works_by_size(
    works: list[WorkItem],
    root: Path,
    *,
    max_chars: int = MAX_SPLIT_CHARS,
    max_files: int = MAX_SPLIT_FILES,
) -> list[str]:
    """按目标文件的内容体积确定性拆分超大 Work。

    批量直写上限是读取总量 48K 字符（超出会带截断标记被跳过）、单文件 12K、
    最多 16 个文件。Planner 只按文件数量拆分，无法发现"8 个文件但每个 8KB"
    这类体积超限。这里在派发前用文件大小（st_size 作为字符数上限估计）把
    targetFiles 切成多个 ≤max_chars/≤max_files 的独立子 Work，互不重叠，
    每个子 Work 都能走单次批量直写，而不是退回多轮循环烧 Token。
    """

    notes: list[str] = []
    result: list[WorkItem] = []
    used_ids = {item.id for item in works}
    replacement_map: dict[str, list[str]] = {}

    for work in works:
        if (
            work.execution_type not in {"coding", "agent"}
            or work.file_operations
            or not work.target_files
        ):
            result.append(work)
            continue
        targets = list(dict.fromkeys(path for path in work.target_files if path.strip()))
        chunks = _chunk_targets(targets, root, max_chars=max_chars, max_files=max_files)
        if len(chunks) <= 1:
            result.append(work)
            continue
        sub_ids: list[str] = []
        for index, chunk in enumerate(chunks, start=1):
            sub_id = _sub_work_id(work.id, index, used_ids)
            used_ids.add(sub_id)
            sub_ids.append(sub_id)
            result.append(
                replace(
                    work,
                    id=sub_id,
                    title=f"{work.title} [part {index}/{len(chunks)}]",
                    target_files=chunk,
                    status="pending",
                    attempts=0,
                    summary="",
                    error="",
                    changed_files=[],
                    commands=[],
                )
            )
        replacement_map[work.id] = sub_ids
        notes.append(
            f"{work.id} 按文件体积拆分为 {len(chunks)} 个独立 Work"
        )

    if replacement_map:
        for item in result:
            dependencies: list[str] = []
            for dependency in item.dependencies:
                if dependency in replacement_map:
                    dependencies.extend(replacement_map[dependency])
                else:
                    dependencies.append(dependency)
            item.dependencies = list(
                dict.fromkeys(value for value in dependencies if value != item.id)
            )
    works[:] = result
    return notes


def _chunk_targets(
    targets: list[str],
    root: Path,
    *,
    max_chars: int,
    max_files: int,
) -> list[list[str]]:
    """贪心切分：每个 chunk 的文件数与总字节估计都不超限。"""

    chunks: list[list[str]] = []
    current: list[str] = []
    current_size = 0
    for path in targets:
        size = _estimated_chars(root, path)
        if (
            current
            and (
                len(current) + 1 > max_files
                or current_size + size > max_chars
            )
        ):
            chunks.append(current)
            current = []
            current_size = 0
        current.append(path)
        current_size += size
    if current:
        chunks.append(current)
    return chunks


def _estimated_chars(root: Path, path: str) -> int:
    """用文件字节数作为字符数的保守上界（UTF-8 下字节数 ≥ 字符数）。"""

    try:
        target = root.joinpath(*path.split("/"))
        if not target.is_file():
            return 0
        return int(target.stat().st_size)
    except (OSError, ValueError):
        return 0


__all__ = [
    "MAX_WORK_TARGET_FILES",
    "split_oversized_works",
    "split_works_by_size",
]
