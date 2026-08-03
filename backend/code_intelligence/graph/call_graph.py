"""Python 调用图构建器。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from backend.code_intelligence.ast.analyzer import PythonAstAnalyzer


@dataclass(frozen=True, slots=True)
class CallEdge:
    """表示一个调用方到被调用名称的有向边。"""

    caller: str
    callee: str
    path: str


class CallGraphBuilder:
    """根据 Python AST 分析结果构建文件级调用边。"""

    def __init__(self) -> None:
        """创建底层 Python AST 分析器。"""

        self._analyzer = PythonAstAnalyzer()

    def build_for_files(self, root: Path, paths: list[str]) -> list[CallEdge]:
        """为指定 Python 文件生成调用边，并跳过非 Python 路径。"""

        edges: list[CallEdge] = []
        for relative in paths:
            if Path(relative).suffix.lower() != ".py":
                continue
            analysis = self._analyzer.analyze(root, relative)
            for caller, callees in analysis.calls.items():
                edges.extend(CallEdge(caller, callee, relative) for callee in callees)
        return edges
