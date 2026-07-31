"""检查项目的 500 行限制和 Python 函数注释规则。"""

from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHECKED_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".jsx", ".md"}
IGNORED_DIRECTORIES = {
    ".git",
    ".venv",
    "venv",
    "node_modules",
    "dist",
    ".electron",
    "release",
    "python-dist",
    ".python-build",
    ".python-spec",
    "__pycache__",
}
MAXIMUM_LINES = 500


def _is_ignored(path: Path) -> bool:
    """判断文件路径是否位于依赖、缓存或构建产物目录中。"""

    return any(part in IGNORED_DIRECTORIES for part in path.parts)


def _source_files() -> list[Path]:
    """返回需要执行行数检查的源码和 Markdown 文档。"""

    return sorted(
        path
        for path in ROOT.rglob("*")
        if path.is_file()
        and path.suffix.lower() in CHECKED_SUFFIXES
        and not _is_ignored(path.relative_to(ROOT))
    )


def _check_line_limits(files: list[Path]) -> list[str]:
    """检查每个手写源码或文档是否超过 500 行。"""

    errors: list[str] = []
    for path in files:
        line_count = len(path.read_text("utf-8").splitlines())
        if line_count > MAXIMUM_LINES:
            relative = path.relative_to(ROOT)
            errors.append(f"{relative} 有 {line_count} 行，超过 {MAXIMUM_LINES} 行限制")
    return errors


def _check_python_docstrings(files: list[Path]) -> list[str]:
    """检查所有 Python 函数、异步函数和方法是否具有 docstring。"""

    errors: list[str] = []
    for path in files:
        if path.suffix != ".py":
            continue
        relative = path.relative_to(ROOT)
        try:
            tree = ast.parse(path.read_text("utf-8"), filename=str(relative))
        except SyntaxError as exc:
            errors.append(f"{relative}:{exc.lineno} Python 语法错误：{exc.msg}")
            continue
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if ast.get_docstring(node) is None:
                errors.append(f"{relative}:{node.lineno} 函数 {node.name} 缺少 docstring")
    return errors


def main() -> None:
    """执行全部源码规范检查，并用退出码告诉构建流程是否通过。"""

    files = _source_files()
    errors = [
        *_check_line_limits(files),
        *_check_python_docstrings(files),
    ]
    if errors:
        print("源码规范检查失败：")
        for error in errors:
            print(f"- {error}")
        raise SystemExit(1)
    print(f"源码规范检查通过：{len(files)} 个文件，全部不超过 500 行。")
    print("Python 函数检查通过：全部函数和方法都包含 docstring。")


if __name__ == "__main__":
    main()
