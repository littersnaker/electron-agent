"""Python AST 文件分析器。"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True, slots=True)
class SymbolInfo:
    """保存一个类、函数或方法的定义位置。"""

    name: str
    kind: str
    line: int
    end_line: int
    parent: str = ""


@dataclass(frozen=True, slots=True)
class PythonFileAnalysis:
    """保存单个 Python 文件的 AST 分析结果。"""

    path: str
    imports: tuple[str, ...]
    symbols: tuple[SymbolInfo, ...]
    calls: dict[str, tuple[str, ...]] = field(default_factory=dict)
    syntax_error: str = ""


class PythonAstAnalyzer:
    """使用标准库 ``ast`` 提取 Python 符号、导入和调用关系。"""

    def analyze(self, root: Path, relative_path: str) -> PythonFileAnalysis:
        """读取工作区内 Python 文件并返回结构化分析。"""

        target = (root / relative_path).resolve()
        if root.resolve() not in target.parents:
            raise ValueError(f"AST 分析路径越出工作区：{relative_path}")
        if target.suffix.lower() != ".py" or not target.is_file():
            raise ValueError(f"AST 分析只支持已存在的 Python 文件：{relative_path}")

        source = target.read_text("utf-8", errors="replace")
        try:
            tree = ast.parse(source, filename=relative_path)
        except SyntaxError as exc:
            return PythonFileAnalysis(
                path=relative_path,
                imports=(),
                symbols=(),
                syntax_error=f"第 {exc.lineno or 0} 行：{exc.msg}",
            )

        imports = self._collect_imports(tree)
        symbols, calls = self._collect_symbols_and_calls(tree)
        return PythonFileAnalysis(
            path=relative_path,
            imports=tuple(imports),
            symbols=tuple(symbols),
            calls={name: tuple(values) for name, values in calls.items()},
        )

    def _collect_imports(self, tree: ast.AST) -> list[str]:
        """提取 ``import`` 与 ``from ... import`` 的模块名称。"""

        imports: list[str] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.extend(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                # ``from pkg import core`` 同时表示依赖 ``pkg`` 与
                # ``pkg.core``。两种形式都保存，影响分析才能定位到被导入的
                # 具体模块；星号导入只保留父模块，避免生成无意义名称。
                prefix = "." * node.level
                module = node.module or ""
                base_module = f"{prefix}{module}"
                if base_module:
                    imports.append(base_module)
                for alias in node.names:
                    if alias.name == "*":
                        continue
                    qualified = f"{module}.{alias.name}" if module else alias.name
                    imports.append(f"{prefix}{qualified}")
        return list(dict.fromkeys(imports))

    def _collect_symbols_and_calls(
        self,
        tree: ast.AST,
    ) -> tuple[list[SymbolInfo], dict[str, list[str]]]:
        """遍历 AST，提取类、函数、方法及其直接调用名称。"""

        symbols: list[SymbolInfo] = []
        calls: dict[str, list[str]] = {}
        for node in tree.body if isinstance(tree, ast.Module) else []:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                symbols.append(self._symbol(node, kind="function"))
                calls[node.name] = self._calls_in(node)
            elif isinstance(node, ast.ClassDef):
                symbols.append(self._symbol(node, kind="class"))
                for child in node.body:
                    if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        qualified = f"{node.name}.{child.name}"
                        symbols.append(self._symbol(child, kind="method", parent=node.name))
                        calls[qualified] = self._calls_in(child)
        return symbols, calls

    def _symbol(
        self,
        node: ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef,
        *,
        kind: str,
        parent: str = "",
    ) -> SymbolInfo:
        """把 AST 定义节点转换成稳定 SymbolInfo。"""

        return SymbolInfo(
            name=node.name,
            kind=kind,
            line=int(node.lineno),
            end_line=int(getattr(node, "end_lineno", node.lineno) or node.lineno),
            parent=parent,
        )

    def _calls_in(self, node: ast.AST) -> list[str]:
        """提取函数体内的调用目标名称，并保持首次出现顺序。"""

        names: list[str] = []
        for child in ast.walk(node):
            if not isinstance(child, ast.Call):
                continue
            name = self._call_name(child.func)
            if name:
                names.append(name)
        return list(dict.fromkeys(names))

    def _call_name(self, node: ast.AST) -> str:
        """把 ``foo()`` 或 ``obj.foo()`` 转换成可读调用名称。"""

        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            prefix = self._call_name(node.value)
            return f"{prefix}.{node.attr}" if prefix else node.attr
        return ""
