"""基于导入关系的轻量影响分析。"""

from __future__ import annotations

from pathlib import Path

from backend.services.code_intelligence.ast.analyzer import PythonAstAnalyzer
from backend.services.workspace.indexer import iter_project_files


class ImpactAnalyzer:
    """查找可能导入已修改 Python 模块的其他文件。"""

    def __init__(self) -> None:
        """创建 Python AST 分析器。"""

        self._analyzer = PythonAstAnalyzer()

    def impacted_files(
        self,
        root: Path,
        changed_paths: list[str],
        *,
        limit: int = 100,
    ) -> list[str]:
        """根据模块名匹配导入关系，返回潜在受影响文件。"""

        module_names = {
            self._module_name(path)
            for path in changed_paths
            if Path(path).suffix.lower() == ".py"
        }
        module_names.discard("")
        impacted: list[str] = []
        for relative in iter_project_files(root):
            if len(impacted) >= limit:
                break
            if Path(relative).suffix.lower() != ".py":
                continue
            if relative in changed_paths:
                continue
            analysis = self._analyzer.analyze(root, relative)
            if any(
                imported == module or imported.startswith(f"{module}.")
                for imported in analysis.imports
                for module in module_names
            ):
                impacted.append(relative)
        return impacted

    def _module_name(self, relative_path: str) -> str:
        """把 Python 相对路径转换成点分模块名。"""

        path = Path(relative_path)
        if path.suffix.lower() != ".py":
            return ""
        parts = list(path.with_suffix("").parts)
        if parts and parts[-1] == "__init__":
            parts.pop()
        return ".".join(parts)
