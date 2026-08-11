"""检查 Software Factory 数据层是否真正接入现有业务页面。"""

from __future__ import annotations

import re
from pathlib import Path

from backend.services.software_factory.contracts import FactoryValidation
from backend.utils.paths import resolve_inside

SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx"}
IGNORED_DIRECTORIES = {
    ".git",
    ".next",
    ".nuxt",
    ".output",
    ".turbo",
    "build",
    "coverage",
    "dist",
    "node_modules",
}
MAXIMUM_INSPECT_BYTES = 1_000_000

# 同时要求导入和调用，避免 README、注释或仅声明类型导致误判。
DATA_SOURCE_IMPORT_PATTERN = re.compile(
    r"(?:import[\s\S]{0,240}createCommerceDataSource[\s\S]{0,240}from|"
    r"require\([^\n]{0,240}data-source[^\n]{0,40}\))"
)
DATA_SOURCE_CALL_PATTERN = re.compile(r"\bcreateCommerceDataSource\s*\(")
STATE_PATTERNS = {
    "loading": re.compile(r"\b(?:loading|isLoading|pending|isPending)\b", re.I),
    "error": re.compile(r"\b(?:error|hasError|isError|catch)\b", re.I),
    "empty": re.compile(
        r"\b(?:empty|isEmpty|noData|noResults)\b|\.length\s*(?:===|==|<=)\s*0",
        re.I,
    ),
}


def validate_workspace_integration(
    *,
    root: Path,
    source_root: str,
    output_root: str,
) -> FactoryValidation:
    """检查生成目录之外是否存在真实页面对统一数据源的调用。"""

    errors: list[str] = []
    warnings: list[str] = []
    checks: list[str] = []
    try:
        source_directory = resolve_inside(root, source_root or ".")
        generated_directory = resolve_inside(root, output_root)
    except ValueError as exc:
        return FactoryValidation(False, errors=(str(exc),))

    if not source_directory.is_dir():
        return FactoryValidation(
            False,
            errors=(f"前端源码目录不存在：{source_root or '.'}",),
        )

    integration_files = _find_integration_files(
        root=root.resolve(),
        source_directory=source_directory,
        generated_directory=generated_directory,
    )
    if not integration_files:
        errors.append(
            "Software Factory 数据层尚未接入真实页面：请在生成目录之外的业务页面中"
            "导入并调用 createCommerceDataSource"
        )
        checks.append("真实业务页面统一 Data Source 接入检查")
        return FactoryValidation(
            False,
            errors=tuple(errors),
            warnings=tuple(warnings),
            checks=tuple(checks),
        )

    # 页面已经调用数据源后，再检查常见异步状态；状态缺失暂记为警告，避免误伤不同框架写法。
    state_coverage = {name: False for name in STATE_PATTERNS}
    relative_files: list[str] = []
    for path, content in integration_files:
        relative_files.append(path.relative_to(root.resolve()).as_posix())
        for state_name, pattern in STATE_PATTERNS.items():
            if pattern.search(content):
                state_coverage[state_name] = True

    missing_states = [name for name, covered in state_coverage.items() if not covered]
    if missing_states:
        warnings.append(
            "已接入统一 Data Source，但未在接入文件中识别到以下页面状态："
            + ", ".join(missing_states)
        )
    checks.append(
        "真实业务页面已调用统一 Data Source：" + ", ".join(relative_files[:10])
    )
    return FactoryValidation(
        True,
        warnings=tuple(warnings),
        checks=tuple(checks),
    )


def _find_integration_files(
    *,
    root: Path,
    source_directory: Path,
    generated_directory: Path,
) -> list[tuple[Path, str]]:
    """扫描前端源码并返回真正导入且调用数据源的文件。"""

    matches: list[tuple[Path, str]] = []
    for path in source_directory.rglob("*"):
        if not _is_candidate(path, generated_directory):
            continue
        try:
            # 限制单文件读取大小，防止压缩产物或意外大文件拖慢 Agent 验收。
            if path.stat().st_size > MAXIMUM_INSPECT_BYTES:
                continue
            content = path.read_text("utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if DATA_SOURCE_IMPORT_PATTERN.search(content) and DATA_SOURCE_CALL_PATTERN.search(
            content
        ):
            matches.append((path, content))

    # 使用稳定路径顺序，确保测试和工具观察在不同系统中保持一致。
    return sorted(matches, key=lambda item: item[0].relative_to(root).as_posix())


def _is_candidate(path: Path, generated_directory: Path) -> bool:
    """判断文件是否属于生成目录之外、可检查的前端源码。"""

    if not path.is_file() or path.suffix.lower() not in SOURCE_SUFFIXES:
        return False
    if generated_directory == path or generated_directory in path.parents:
        return False
    return not any(part in IGNORED_DIRECTORIES for part in path.parts)
