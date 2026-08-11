"""无需大模型参与的确定性文件系统 Work 执行器。"""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from tempfile import mkdtemp

from backend.services.agent.shared.work_models import FileSystemOperation
from backend.utils.paths import resolve_inside
from backend.utils.sensitive_paths import is_sensitive_workspace_path


@dataclass(slots=True)
class FileSystemExecutionResult:
    """一批文件系统操作完成后的真实结果。"""

    changed_paths: list[str]
    summary: str

_DIRECT_RENAME_PATTERNS = (
    re.compile(
        r"^\s*(?:请|麻烦)?(?:把|将)\s*(?P<source>`[^`]+`|\"[^\"]+\"|'[^']+'|\S+)"
        r"\s*(?:文件|目录)?\s*(?:重命名为|改名为|移动到)\s*"
        r"(?P<target>`[^`]+`|\"[^\"]+\"|'[^']+'|\S+)\s*[。！!]*\s*$",
        re.IGNORECASE,
    ),
    re.compile(
        r"^\s*(?:please\s+)?(?:rename|move)\s+"
        r"(?P<source>`[^`]+`|\"[^\"]+\"|'[^']+'|\S+)\s+(?:to|as)\s+"
        r"(?P<target>`[^`]+`|\"[^\"]+\"|'[^']+'|\S+)\s*[.!]*\s*$",
        re.IGNORECASE,
    ),
)


def _unquote_path(value: str) -> str:
    """移除用户输入路径外层的代码引号或普通引号。"""

    cleaned = value.strip().rstrip("。！!.")
    if len(cleaned) >= 2 and cleaned[0] == cleaned[-1] and cleaned[0] in "`\"'":
        return cleaned[1:-1].strip()
    return cleaned


def parse_direct_filesystem_request(
    root: Path,
    user_request: str,
) -> list[FileSystemOperation]:
    """识别完整、明确的单文件重命名请求，命中后可完全跳过 Planner LLM。"""

    for pattern in _DIRECT_RENAME_PATTERNS:
        match = pattern.fullmatch(user_request.strip())
        if not match:
            continue
        source_path = _unquote_path(match.group("source"))
        target_path = _unquote_path(match.group("target"))
        try:
            _assert_safe_path(source_path)
            _assert_safe_path(target_path)
            source = resolve_inside(root, source_path)
            target = resolve_inside(root, target_path)
        except ValueError:
            return []
        if source.exists() and source != target and not target.exists():
            return [FileSystemOperation("rename", source_path, target_path)]
    return []


def operation_resources(operations: list[FileSystemOperation]) -> set[str]:
    """返回执行该批操作需要锁定的源路径与目标路径。"""

    resources: set[str] = set()
    for operation in operations:
        if operation.source_path:
            resources.add(operation.source_path)
        if operation.target_path:
            resources.add(operation.target_path)
    return resources


def _assert_safe_path(relative_path: str) -> None:
    """禁止确定性执行器碰触密钥文件和内部事务目录。"""

    normalized = relative_path.replace("\\", "/").strip().strip("/")
    lowered = normalized.lower()
    parts = [part for part in lowered.split("/") if part]
    if not normalized:
        raise ValueError("文件系统操作路径不能为空")
    if is_sensitive_workspace_path(normalized):
        raise ValueError(f"禁止操作敏感配置文件：{relative_path}")
    if any(part.startswith(".multi-agent-fs-") for part in parts):
        raise ValueError(f"禁止操作内部事务目录：{relative_path}")


def _validate_operations(
    root: Path,
    operations: list[FileSystemOperation],
) -> list[tuple[FileSystemOperation, Path, Path | None]]:
    """在写入前完整校验操作，避免执行到一半才发现明显错误。"""

    if not operations:
        raise ValueError("确定性 Work 没有提供 fileOperations")

    normalized: list[tuple[FileSystemOperation, Path, Path | None]] = []
    source_paths: set[Path] = set()
    target_paths: set[Path] = set()
    for operation in operations:
        _assert_safe_path(operation.source_path)
        source = resolve_inside(root, operation.source_path)
        target: Path | None = None
        if operation.type in {"rename", "move"}:
            _assert_safe_path(operation.target_path)
            target = resolve_inside(root, operation.target_path)
            if source == target:
                raise ValueError(f"源路径与目标路径相同：{operation.source_path}")
            if target in target_paths:
                raise ValueError(f"多个操作写入同一目标路径：{operation.target_path}")
            target_paths.add(target)
        if source in source_paths:
            raise ValueError(f"同一源路径被重复操作：{operation.source_path}")
        source_paths.add(source)
        normalized.append((operation, source, target))

    source_list = list(source_paths)
    for index, source in enumerate(source_list):
        for other in source_list[index + 1 :]:
            if source.is_relative_to(other) or other.is_relative_to(source):
                raise ValueError(f"批量操作包含嵌套源路径：{source} 与 {other}")

    for operation, source, target in normalized:
        if not source.exists():
            raise ValueError(f"源路径不存在：{operation.source_path}")
        if operation.type == "delete_empty_dir":
            if not source.is_dir():
                raise ValueError(f"只允许删除空目录：{operation.source_path}")
            if any(source.iterdir()):
                raise ValueError(f"目录非空，拒绝删除：{operation.source_path}")
            continue
        if target is None:
            raise ValueError(f"操作缺少目标路径：{operation.source_path}")
        try:
            target.relative_to(source)
        except ValueError:
            pass
        else:
            raise ValueError(
                f"目标路径不能位于源目录内部：{operation.source_path} -> "
                f"{operation.target_path}"
            )
        # 目标若也是本批次的源路径，说明是交换或链式重命名，暂存后可以安全执行。
        if target.exists() and target not in source_paths:
            raise ValueError(f"目标路径已存在：{operation.target_path}")
    return normalized


def execute_filesystem_operations(
    root: Path,
    operations: list[FileSystemOperation],
) -> FileSystemExecutionResult:
    """事务式执行重命名、移动和删除空目录，不调用任何大模型。"""

    root = root.resolve()
    normalized = _validate_operations(root, operations)
    transaction_root = Path(mkdtemp(prefix=".multi-agent-fs-", dir=root))
    staged: dict[Path, Path] = {}
    committed_targets: dict[Path, Path] = {}
    deleted_directories: list[Path] = []
    changed_paths: list[str] = []

    try:
        # 先把所有需要移动的源路径放进事务目录，可安全处理 A↔B 交换重命名。
        for index, (operation, source, _) in enumerate(normalized):
            if operation.type == "delete_empty_dir":
                continue
            stage = transaction_root / f"item-{index:04d}"
            shutil.move(str(source), str(stage))
            staged[source] = stage

        for operation, source, target in normalized:
            if operation.type == "delete_empty_dir":
                source.rmdir()
                deleted_directories.append(source)
                changed_paths.append(operation.source_path)
                continue
            assert target is not None
            target.parent.mkdir(parents=True, exist_ok=True)
            stage = staged[source]
            shutil.move(str(stage), str(target))
            committed_targets[target] = source
            changed_paths.extend([operation.source_path, operation.target_path])

        unique_paths = list(dict.fromkeys(changed_paths))
        rename_count = sum(
            operation.type in {"rename", "move"} for operation in operations
        )
        delete_count = sum(
            operation.type == "delete_empty_dir" for operation in operations
        )
        parts = []
        if rename_count:
            parts.append(f"重命名或移动 {rename_count} 项")
        if delete_count:
            parts.append(f"删除空目录 {delete_count} 项")
        return FileSystemExecutionResult(
            changed_paths=unique_paths,
            summary="本地快速执行器已" + "，".join(parts) + "，未调用大模型。",
        )
    except Exception:
        # 先把已经提交到目标位置的内容移回事务目录，再恢复全部源路径。
        for target, source in reversed(list(committed_targets.items())):
            if target.exists():
                stage = staged[source]
                stage.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(target), str(stage))
        for source, stage in reversed(list(staged.items())):
            if stage.exists():
                source.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(stage), str(source))
        for directory in deleted_directories:
            directory.mkdir(parents=True, exist_ok=True)
        raise
    finally:
        shutil.rmtree(transaction_root, ignore_errors=True)
