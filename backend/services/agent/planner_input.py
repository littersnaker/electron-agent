"""Planner 输入裁剪器。

Planner 不应该收到全仓库内容、全历史日志和所有 artifact。
只发送：User Goal + Project Metadata + Relevant Files + Existing Artifact Summary。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.services.agent.target_preflight import extract_tree_paths


# 默认过滤的无关目录和大文件阈值
IGNORED_DIRS = {
    "node_modules",
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    "dist",
    "build",
    ".next",
    ".electron",
    "release",
    ".uploads",
    ".trae",
    ".agents",
    ".agent-data",
}

MAX_FILE_SIZE_BYTES = 500_000  # ~500KB
MAX_FILES_IN_CONTEXT = 20
MAX_FILE_CONTENT_CHARS = 4_000
MAX_INVENTORY_PATHS = 200


@dataclass(slots=True)
class PlannerInput:
    """裁剪后的 Planner 输入。"""

    user_goal: str = ""
    project_metadata: dict[str, Any] = field(default_factory=dict)
    relevant_files: list[dict[str, Any]] = field(default_factory=list)
    artifact_summary: list[dict[str, Any]] = field(default_factory=list)
    existing_work_summary: list[dict[str, Any]] = field(default_factory=list)
    file_inventory: list[str] = field(default_factory=list)
    memory_notes: list[str] = field(default_factory=list)
    skill_directives: list[str] = field(default_factory=list)

    def to_prompt(self) -> str:
        """生成 Planner 可用的完整提示文本。"""

        lines = ["## User Goal", self.user_goal]

        if self.project_metadata:
            lines.extend(["\n## Project Metadata", self._format_metadata()])

        if self.relevant_files:
            lines.extend(["\n## Relevant Files", self._format_files()])

        if self.file_inventory:
            lines.extend(["\n## Project File Inventory", self._format_inventory()])

        if self.artifact_summary:
            lines.extend(["\n## Existing Artifacts", self._format_artifacts()])

        if self.existing_work_summary:
            lines.extend(["\n## Work Progress", self._format_works()])

        if self.memory_notes:
            lines.extend(["\n## Related Memory", "\n".join(self.memory_notes[:8])])

        if self.skill_directives:
            lines.extend(["\n## Selected Skills", "\n".join(self.skill_directives[:4])])

        return "\n".join(lines)

    def _format_metadata(self) -> str:
        """格式化项目元数据。"""

        meta = self.project_metadata
        parts = []
        if "language" in meta:
            parts.append(f"Language: {meta['language']}")
        if "framework" in meta:
            parts.append(f"Framework: {meta['framework']}")
        if "entry_files" in meta:
            parts.append(f"Entry: {', '.join(meta['entry_files'])}")
        if "total_files" in meta:
            parts.append(f"Total Files: {meta['total_files']}")
        return "\n".join(parts)

    def _format_files(self) -> str:
        """格式化相关文件。"""

        parts = []
        for file_info in self.relevant_files[:12]:
            path = file_info.get("path", "")
            content = str(file_info.get("content", ""))[:800]
            parts.append(f"### {path}\n{content}")
        return "\n\n".join(parts)

    def _format_inventory(self) -> str:
        """格式化项目文件清单（只列路径，不携带内容）。"""

        return "\n".join(f"- {path}" for path in self.file_inventory)

    def _format_artifacts(self) -> str:
        """格式化已有 artifact 摘要。"""

        parts = []
        for artifact in self.artifact_summary[:20]:
            name = artifact.get("name", "")
            type_ = artifact.get("type", "")
            parts.append(f"- {name} ({type_})")
        return "\n".join(parts)

    def _format_works(self) -> str:
        """格式化已有 Work 进度摘要。"""

        parts = []
        for work in self.existing_work_summary[:20]:
            wid = work.get("id", "")
            status = work.get("status", "")
            parts.append(f"- {wid}: {status}")
        return "\n".join(parts)


class PlannerInputBuilder:
    """构建裁剪后的 Planner 输入，过滤无关内容。"""

    def __init__(
        self,
        *,
        root: Path | None = None,
        ignored_dirs: set[str] | None = None,
        max_file_size: int = MAX_FILE_SIZE_BYTES,
        max_files: int = MAX_FILES_IN_CONTEXT,
        max_file_chars: int = MAX_FILE_CONTENT_CHARS,
    ) -> None:
        """初始化 Builder。"""

        self._root = root
        self._ignored_dirs = ignored_dirs or IGNORED_DIRS
        self._max_file_size = max_file_size
        self._max_files = max_files
        self._max_file_chars = max_file_chars

    def build(
        self,
        *,
        user_goal: str,
        project_tree: str = "",
        relevant_file_paths: list[str] | None = None,
        file_contents: dict[str, str] | None = None,
        artifact_summary: list[dict[str, Any]] | None = None,
        existing_works: list[dict[str, Any]] | None = None,
        memory_notes: list[str] | None = None,
        skill_directives: list[str] | None = None,
    ) -> PlannerInput:
        """构建裁剪后的 Planner 输入。"""

        # 1. 项目元数据（只保留统计信息，不保留完整树）
        metadata = self._extract_metadata(project_tree)

        # 2. 相关文件（过滤大文件、无关目录、已完成 Work 相关文件）
        files = self._build_relevant_files(
            paths=relevant_file_paths or [],
            contents=file_contents or {},
        )

        # 3. Artifact 摘要（只保留名称和类型，不保留完整内容）
        inventory = extract_tree_paths(project_tree)[:MAX_INVENTORY_PATHS]

        artifacts = self._filter_artifacts(artifact_summary or [])

        # 4. 已有 Work 摘要（只保留未完成 Work 的摘要）
        works = self._filter_existing_works(existing_works or [])

        return PlannerInput(
            user_goal=user_goal.strip()[:8_000],
            project_metadata=metadata,
            relevant_files=files,
            artifact_summary=artifacts,
            existing_work_summary=works,
            file_inventory=inventory,
            memory_notes=[str(item)[:1_200] for item in (memory_notes or [])[:8]],
            skill_directives=[str(item)[:1_000] for item in (skill_directives or [])[:4]],
        )

    def _extract_metadata(self, project_tree: str) -> dict[str, Any]:
        """从项目树提取元数据，不保留完整树。"""

        if not project_tree:
            return {}

        lines = project_tree.strip().splitlines()
        total_files = sum(1 for line in lines if not line.endswith("/"))
        total_dirs = sum(1 for line in lines if line.endswith("/"))

        # 检测语言和框架
        languages = set()
        frameworks = set()
        for line in lines:
            lowered = line.lower()
            if ".py" in lowered:
                languages.add("Python")
            if ".ts" in lowered or ".tsx" in lowered:
                languages.add("TypeScript")
            if ".js" in lowered or ".jsx" in lowered:
                languages.add("JavaScript")
            if "package.json" in lowered:
                frameworks.add("Node.js")
            if "requirements.txt" in lowered:
                frameworks.add("Python")
            if "cargo.toml" in lowered:
                frameworks.add("Rust")

        return {
            "total_files": total_files,
            "total_dirs": total_dirs,
            "language": ", ".join(sorted(languages)) if languages else "Unknown",
            "framework": ", ".join(sorted(frameworks)) if frameworks else "Unknown",
            "tree_depth": self._estimate_tree_depth(lines),
        }

    def _estimate_tree_depth(self, lines: list[str]) -> int:
        """估算项目树深度。"""

        max_depth = 0
        for line in lines:
            # 计算缩进层级
            stripped = line.lstrip()
            indent = len(line) - len(stripped)
            depth = indent // 2  # 假设每级2空格
            max_depth = max(max_depth, depth)
        return max_depth

    def _build_relevant_files(
        self,
        *,
        paths: list[str],
        contents: dict[str, str],
    ) -> list[dict[str, Any]]:
        """构建相关文件列表，过滤无关内容。"""

        result: list[dict[str, Any]] = []

        for path in paths[: self._max_files]:
            # 跳过无关目录
            if any(part in self._ignored_dirs for part in Path(path).parts):
                continue

            content = contents.get(path, "")
            result.append({"path": path, "content": content})

        return result

    def _filter_artifacts(
        self, artifacts: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """过滤 Artifact 摘要，只保留关键信息。"""

        result = []
        for artifact in artifacts:
            summary = {
                "name": str(artifact.get("name", "")),
                "type": str(artifact.get("type", "")),
                "sourceWork": str(artifact.get("source_work", "")),
            }
            result.append(summary)
        return result

    def _filter_existing_works(
        self, works: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """过滤已有 Work，只保留未完成项的摘要。"""

        result = []
        for work in works:
            status = str(work.get("status", ""))
            # 过滤已完成的 Work
            if status in {"succeeded", "skipped"}:
                continue
            result.append(
                {
                    "id": str(work.get("id", "")),
                    "status": status,
                    "title": str(work.get("title", ""))[:200],
                }
            )
        return result


__all__ = [
    "PlannerInput",
    "PlannerInputBuilder",
    "IGNORED_DIRS",
    "MAX_FILE_SIZE_BYTES",
    "MAX_FILES_IN_CONTEXT",
]
