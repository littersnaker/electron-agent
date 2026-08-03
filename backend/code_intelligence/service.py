"""Code Intelligence 统一服务。"""

from __future__ import annotations

from pathlib import Path

from backend.code_intelligence.ast.analyzer import PythonAstAnalyzer
from backend.code_intelligence.graph.call_graph import CallGraphBuilder
from backend.code_intelligence.patch.impact import ImpactAnalyzer
from backend.code_intelligence.symbol.index import SymbolIndex


class CodeIntelligenceService:
    """组合 AST、符号索引、调用图和影响分析能力。"""

    def __init__(self) -> None:
        """创建各个无状态分析器。"""

        self._ast = PythonAstAnalyzer()
        self._symbols = SymbolIndex()
        self._calls = CallGraphBuilder()
        self._impact = ImpactAnalyzer()

    def inspect(
        self,
        root: Path,
        *,
        paths: list[str] | None = None,
        query: str = "",
    ) -> str:
        """返回适合放入 Agent 上下文的结构化代码分析文本。"""

        selected_paths = list(dict.fromkeys(paths or []))[:100]
        sections: list[str] = []

        for relative in selected_paths:
            if Path(relative).suffix.lower() != ".py":
                continue
            analysis = self._ast.analyze(root, relative)
            sections.append(self._render_python_analysis(analysis))

        # 有查询词时建立跨语言符号索引，帮助模型定位定义而不是只做全文搜索。
        if query.strip():
            all_symbols = self._symbols.build(root)
            matches = self._symbols.search(all_symbols, query)
            symbol_lines = [
                f"- {item.kind} {item.name} · {item.path}:{item.line}"
                for item in matches
            ]
            sections.append("## Symbol Matches\n" + ("\n".join(symbol_lines) or "未找到匹配符号"))

        if selected_paths:
            edges = self._calls.build_for_files(root, selected_paths)
            edge_lines = [f"- {item.caller} -> {item.callee} · {item.path}" for item in edges[:200]]
            sections.append("## Call Graph\n" + ("\n".join(edge_lines) or "未提取到调用边"))
            impacted = self._impact.impacted_files(root, selected_paths)
            sections.append(
                "## Potential Impact\n"
                + ("\n".join(f"- {path}" for path in impacted) or "未找到直接导入方")
            )

        return "\n\n".join(sections) or "没有可分析的路径或符号查询。"

    def _render_python_analysis(self, analysis: object) -> str:
        """把 PythonFileAnalysis 转换成稳定文本，避免暴露内部 dataclass 表示。"""

        from backend.code_intelligence.ast.analyzer import PythonFileAnalysis

        if not isinstance(analysis, PythonFileAnalysis):
            return "## Python AST\n分析结果类型无效"
        if analysis.syntax_error:
            return f"## Python AST · {analysis.path}\n语法错误：{analysis.syntax_error}"
        symbols = [
            f"- {item.kind} {item.parent + '.' if item.parent else ''}{item.name} "
            f"· L{item.line}-L{item.end_line}"
            for item in analysis.symbols
        ]
        imports = ", ".join(analysis.imports) or "无"
        return (
            f"## Python AST · {analysis.path}\n"
            f"Imports: {imports}\n"
            f"Symbols:\n" + ("\n".join(symbols) or "- 无顶层类或函数")
        )
