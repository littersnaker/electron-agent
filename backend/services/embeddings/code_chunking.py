"""代码文件结构化切块。

固定字符切块会把函数/方法拦腰截断，导致语义不完整。这里改为按结构切：
- Python（.py）：使用标准库 ``ast`` 解析，每个顶层函数一个块、每个类一个块
  （类超长按方法再切），这是真正的语法级切块；
- 其他代码文件（ts/tsx/js/jsx/vue/go/rs/java/c/cpp 等）：使用“声明感知”的
  行级结构切块——在函数/类声明行与空行边界断开，再配合括号深度保护，
  不引入第三方解析器、离线可用；
- Vue（.vue）：抽取 ``<script>`` 块按 TS/JS 声明切块，模板部分走字符切块；
- 不在结构化白名单内的文件（md/txt/json 等）：回退固定字符切块。

“哪些扩展名做结构化切块”由配置 ``JINA_CODE_STRUCTURAL_EXTENSIONS`` 控制
（默认覆盖主流语言，可覆盖），不写死在代码里。
"""

from __future__ import annotations

import ast
import logging
import re
from pathlib import Path

from backend.core.config import get_settings
from backend.services.embeddings.chunking import (
    MAX_PARENT_TEXT_CHARS,
    _chunk_id,
    build_chunks,
)
from backend.services.embeddings.store import ChunkRecord

LOGGER = logging.getLogger(__name__)

# 常见代码语言的顶层声明行模式：函数/类/接口/结构体/枚举/常量等。
_DECLARATION_RE = re.compile(
    r"^\s*(?:(?:export|default)\s+)?"
    r"(?:async\s+|static\s+|public\s+|private\s+|protected\s+|internal\s+|"
    r"pub\s+|final\s+|abstract\s+|override\s+|open\s+|sealed\s+|data\s+|"
    r"value\s+|inline\s+|suspend\s+|fun\s+)*\s*"
    r"(?:function|def|class|fn|func|interface|struct|enum|impl|trait|type|"
    r"const|let|var|object|module|package|namespace)\b"
)


def _position(node: ast.AST | None, start_line: int = 0, end_line: int = 0) -> str:
    """把行号转成 ``L开始-L结束`` 位置描述。"""

    if node is not None and getattr(node, "lineno", None) is not None:
        return f"L{node.lineno}-L{node.end_lineno}"
    if start_line and end_line:
        return f"L{start_line}-L{end_line}"
    return ""


def _make_chunk(
    *,
    scope: str,
    source_type: str,
    source_path: str,
    index: int,
    text: str,
    model: str,
    position: str,
    parent_text: str,
) -> ChunkRecord:
    """构造一个带位置的代码块记录。"""

    return ChunkRecord(
        chunk_id=_chunk_id(scope, source_path, index, position),
        chunk_index=index,
        chunk_text=text.strip(),
        embedding=[],
        model=model,
        parent_id=source_path,
        parent_text=parent_text,
        position=position,
    )


def _split_lines_with_limit(
    text: str,
    *,
    start_line: int,
    max_chars: int,
    overlap_lines: int = 2,
) -> list[tuple[str, int, int]]:
    """把超长代码按行切成不超过 max_chars 的片段，并返回每个片段的行号范围。"""

    lines = text.splitlines()
    pieces: list[tuple[str, int, int]] = []
    current: list[str] = []
    current_chars = 0
    current_start = start_line
    for index, line in enumerate(lines):
        line_number = start_line + index
        if current and current_chars + len(line) + 1 > max_chars:
            pieces.append(("\n".join(current), current_start, line_number - 1))
            overlap = lines[max(0, index - overlap_lines) : index]
            current = list(overlap)
            current_chars = sum(len(item) + 1 for item in current)
            current_start = line_number - len(overlap)
        current.append(line)
        current_chars += len(line) + 1
    if current:
        pieces.append(("\n".join(current), current_start, start_line + len(lines) - 1))
    return pieces


def _python_chunks(
    *,
    scope: str,
    source_type: str,
    source_path: str,
    text: str,
    model: str,
    max_chars: int,
    parent_text: str,
) -> list[ChunkRecord]:
    """用 Python ast 把函数/类切成完整语义块。"""

    try:
        tree = ast.parse(text)
    except SyntaxError as exc:
        LOGGER.warning("AST 解析失败，回退声明感知切块：%s（%s）", source_path, exc)
        return _declaration_aware_chunks(
            scope=scope,
            source_type=source_type,
            source_path=source_path,
            text=text,
            model=model,
            max_chars=max_chars,
            parent_text=parent_text,
        )

    chunks: list[ChunkRecord] = []
    index = 0
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            source = ast.get_source_segment(text, node) or ""
            if len(source) <= max_chars:
                chunks.append(
                    _make_chunk(
                        scope=scope,
                        source_type=source_type,
                        source_path=source_path,
                        index=index,
                        text=source,
                        model=model,
                        position=_position(node),
                        parent_text=parent_text,
                    )
                )
                index += 1
            else:
                for piece, start_line, end_line in _split_lines_with_limit(
                    source, start_line=node.lineno, max_chars=max_chars
                ):
                    chunks.append(
                        _make_chunk(
                            scope=scope,
                            source_type=source_type,
                            source_path=source_path,
                            index=index,
                            text=piece,
                            model=model,
                            position=_position(None, start_line, end_line),
                            parent_text=parent_text,
                        )
                    )
                    index += 1
        elif isinstance(node, ast.ClassDef):
            chunks.extend(
                _python_class_chunks(
                    scope=scope,
                    source_type=source_type,
                    source_path=source_path,
                    node=node,
                    text=text,
                    model=model,
                    max_chars=max_chars,
                    parent_text=parent_text,
                    start_index=index,
                )
            )
            index = len(chunks)

    if not chunks:
        return _declaration_aware_chunks(
            scope=scope,
            source_type=source_type,
            source_path=source_path,
            text=text,
            model=model,
            max_chars=max_chars,
            parent_text=parent_text,
        )
    return chunks


def _python_class_chunks(
    *,
    scope: str,
    source_type: str,
    source_path: str,
    node: ast.ClassDef,
    text: str,
    model: str,
    max_chars: int,
    parent_text: str,
    start_index: int,
) -> list[ChunkRecord]:
    """切分类：类体短则整块，超长则按方法逐块切。"""

    class_source = ast.get_source_segment(text, node) or ""
    if len(class_source) <= max_chars:
        return [
            _make_chunk(
                scope=scope,
                source_type=source_type,
                source_path=source_path,
                index=start_index,
                text=class_source,
                model=model,
                position=_position(node),
                parent_text=parent_text,
            )
        ]

    chunks: list[ChunkRecord] = []
    index = start_index
    for child in node.body:
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            method_source = ast.get_source_segment(text, child) or ""
            if not method_source:
                continue
            if len(method_source) <= max_chars:
                chunks.append(
                    _make_chunk(
                        scope=scope,
                        source_type=source_type,
                        source_path=source_path,
                        index=index,
                        text=method_source,
                        model=model,
                        position=_position(child),
                        parent_text=parent_text,
                    )
                )
                index += 1
            else:
                for piece, start_line, end_line in _split_lines_with_limit(
                    method_source, start_line=child.lineno, max_chars=max_chars
                ):
                    chunks.append(
                        _make_chunk(
                            scope=scope,
                            source_type=source_type,
                            source_path=source_path,
                            index=index,
                            text=piece,
                            model=model,
                            position=_position(None, start_line, end_line),
                            parent_text=parent_text,
                        )
                    )
                    index += 1
    if not chunks:
        for piece, start_line, end_line in _split_lines_with_limit(
            class_source, start_line=node.lineno, max_chars=max_chars
        ):
            chunks.append(
                _make_chunk(
                    scope=scope,
                    source_type=source_type,
                    source_path=source_path,
                    index=index,
                    text=piece,
                    model=model,
                    position=_position(None, start_line, end_line),
                    parent_text=parent_text,
                )
            )
            index += 1
    return chunks


def _vue_script_text(text: str) -> tuple[str, int]:
    """抽取 Vue 文件的 ``<script>`` 内容，并返回其在文件中的起始行偏移。"""

    match = re.search(r"<script[^>]*>([\s\S]*?)</script>", text)
    if not match:
        return "", 0
    line_offset = text.count("\n", 0, match.start())
    return match.group(1), line_offset


def _declaration_aware_chunks(
    *,
    scope: str,
    source_type: str,
    source_path: str,
    text: str,
    model: str,
    max_chars: int,
    parent_text: str,
    line_offset: int = 0,
) -> list[ChunkRecord]:
    """声明感知切块：在函数/类声明行与空行边界断开，超长块再按行切。"""

    lines = text.splitlines()
    blocks: list[tuple[str, int, int]] = []
    current: list[str] = []
    current_start = line_offset + 1
    for index, line in enumerate(lines):
        line_number = line_offset + index + 1
        stripped = line.strip()
        if not stripped:
            if current:
                blocks.append(("\n".join(current), current_start, line_number - 1))
                current = []
            # 跳过空行：下一块内容从下一行开始计数。
            current_start = line_number + 1
            continue
        if current and _DECLARATION_RE.match(line) is not None:
            blocks.append(("\n".join(current), current_start, line_number - 1))
            current = []
            current_start = line_number
        current.append(line)
    if current:
        blocks.append(("\n".join(current), current_start, line_offset + len(lines)))

    chunks: list[ChunkRecord] = []
    index = 0
    buffer: list[str] = []
    buffer_chars = 0
    buffer_start = 1
    for block_text, start_line, _end_line in blocks:
        if buffer and buffer_chars + len(block_text) + 1 > max_chars:
            chunks.append(
                _make_chunk(
                    scope=scope,
                    source_type=source_type,
                    source_path=source_path,
                    index=index,
                    text="\n".join(buffer),
                    model=model,
                    position=_position(None, buffer_start, start_line - 1),
                    parent_text=parent_text,
                )
            )
            index += 1
            buffer = []
            buffer_chars = 0
            buffer_start = start_line
        if len(block_text) > max_chars:
            for piece, piece_start, piece_end in _split_lines_with_limit(
                block_text, start_line=start_line, max_chars=max_chars
            ):
                chunks.append(
                    _make_chunk(
                        scope=scope,
                        source_type=source_type,
                        source_path=source_path,
                        index=index,
                        text=piece,
                        model=model,
                        position=_position(None, piece_start, piece_end),
                        parent_text=parent_text,
                    )
                )
                index += 1
            continue
        if not buffer:
            buffer_start = start_line
        buffer.append(block_text)
        buffer_chars += len(block_text) + 1
    if buffer:
        chunks.append(
            _make_chunk(
                scope=scope,
                source_type=source_type,
                source_path=source_path,
                index=index,
                text="\n".join(buffer),
                model=model,
                position=_position(None, buffer_start, line_offset + len(lines)),
                parent_text=parent_text,
            )
        )
    return chunks


def build_code_chunks(
    *,
    scope: str,
    source_type: str,
    source_path: str,
    text: str,
    model: str = "",
    max_chars: int = 2000,
    overlap: int = 200,
) -> list[ChunkRecord]:
    """按配置驱动的方式切代码块；非结构化扩展名回退字符切块。"""

    suffix = Path(source_path).suffix.lower()
    settings = get_settings()
    parent_text = text.strip()[:MAX_PARENT_TEXT_CHARS]
    if suffix not in settings.code_structural_extensions:
        return build_chunks(
            scope=scope,
            source_type=source_type,
            source_path=source_path,
            text=text,
            model=model,
            max_chars=max_chars,
            overlap=overlap,
        )

    common = {
        "scope": scope,
        "source_type": source_type,
        "source_path": source_path,
        "model": model,
        "max_chars": max_chars,
        "parent_text": parent_text,
    }
    if suffix == ".py":
        return _python_chunks(text=text, **common)
    if suffix == ".vue":
        script, line_offset = _vue_script_text(text)
        if not script.strip():
            return build_chunks(
                scope=scope,
                source_type=source_type,
                source_path=source_path,
                text=text,
                model=model,
                max_chars=max_chars,
                overlap=overlap,
            )
        return _declaration_aware_chunks(
            text=script,
            line_offset=line_offset,
            **common,
        )
    return _declaration_aware_chunks(text=text, **common)


__all__ = ["build_code_chunks"]
