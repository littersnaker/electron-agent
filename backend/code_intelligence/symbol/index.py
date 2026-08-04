"""跨文件符号索引。"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from backend.code_intelligence.ast.analyzer import PythonAstAnalyzer
from backend.services.workspace.indexer import iter_project_files

TS_SYMBOL_PATTERN = re.compile(
    r"^\s*(?:export\s+)?(?:default\s+)?"
    r"(?:(class|function|interface|type|enum)\s+([A-Za-z_$][\w$]*)|"
    r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)",
    re.MULTILINE,
)


@dataclass(frozen=True, slots=True)
class IndexedSymbol:
    """保存跨语言符号索引中的一条记录。"""

    name: str
    kind: str
    path: str
    line: int


class SymbolIndex:
    """为 Python 与 TypeScript/JavaScript 文件建立轻量符号索引。"""

    def __init__(self) -> None:
        """创建 Python AST 分析器。"""

        self._python = PythonAstAnalyzer()

    def build(self, root: Path, *, limit_files: int = 2_000) -> list[IndexedSymbol]:
        """扫描工作区并返回受文件数量限制的符号列表。"""

        symbols: list[IndexedSymbol] = []
        processed = 0
        for relative in iter_project_files(root):
            if processed >= limit_files:
                break
            suffix = Path(relative).suffix.lower()
            if suffix not in {".py", ".ts", ".tsx", ".js", ".jsx"}:
                continue
            processed += 1
            symbols.extend(self._symbols_for_file(root, relative, suffix))
        return symbols

    def search(
        self,
        symbols: list[IndexedSymbol],
        query: str,
        *,
        limit: int = 50,
    ) -> list[IndexedSymbol]:
        """按符号名和路径进行不区分大小写的包含匹配。"""

        normalized = query.strip().lower()
        if not normalized:
            return symbols[:limit]
        matches = [
            symbol
            for symbol in symbols
            if normalized in symbol.name.lower() or normalized in symbol.path.lower()
        ]
        return matches[: max(1, limit)]

    def _symbols_for_file(
        self,
        root: Path,
        relative: str,
        suffix: str,
    ) -> list[IndexedSymbol]:
        """按文件语言选择 AST 或正则提取器。"""

        if suffix == ".py":
            analysis = self._python.analyze(root, relative)
            return [
                IndexedSymbol(item.name, item.kind, relative, item.line)
                for item in analysis.symbols
            ]

        content = (root / relative).read_text("utf-8", errors="replace")
        symbols: list[IndexedSymbol] = []
        for match in TS_SYMBOL_PATTERN.finditer(content):
            kind = match.group(1) or "variable"
            name = match.group(2) or match.group(3) or "unknown"
            line = content.count("\n", 0, match.start()) + 1
            symbols.append(IndexedSymbol(name, kind, relative, line))
        return symbols
