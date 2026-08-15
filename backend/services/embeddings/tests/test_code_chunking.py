"""代码结构化切块测试：函数/类不被拦腰切断，位置行号正确。"""

from __future__ import annotations

from backend.services.embeddings.code_chunking import build_code_chunks


def _chunks(source_path: str, text: str, max_chars: int = 2000):
    """便捷构造代码块。"""

    return build_code_chunks(
        scope="project",
        source_type="file",
        source_path=source_path,
        text=text,
        max_chars=max_chars,
    )


def test_python_functions_are_not_split() -> None:
    """Python 顶层函数应各自成块，且位置带行号范围。"""

    text = "def alpha():\n    return 1\n\n\ndef beta():\n    return 2\n"
    chunks = _chunks("sample.py", text)
    assert len(chunks) == 2
    assert "def alpha" in chunks[0].chunk_text
    assert "def beta" in chunks[1].chunk_text
    assert chunks[0].position == "L1-L2"
    assert chunks[1].position == "L5-L6"


def test_python_long_function_split_keeps_unique_positions() -> None:
    """超长函数按行切分，位置行号不重复且首块保留签名。"""

    text = "def long_fn():\n" + "".join(f"    x{i} = {i}\n" for i in range(300))
    chunks = _chunks("long.py", text, max_chars=500)
    assert len(chunks) > 1
    assert chunks[0].chunk_text.startswith("def long_fn")
    positions = [chunk.position for chunk in chunks]
    assert len(positions) == len(set(positions))


def test_python_class_splits_by_methods_when_large() -> None:
    """超长类应按方法切块，且每个方法完整。"""

    text = (
        "class Big:\n"
        "    def __init__(self):\n"
        "        self.x = 1\n"
        "\n"
        '    def run(self):\n        return "x" * 3000\n'
    )
    chunks = _chunks("big.py", text, max_chars=400)
    assert any("def __init__" in chunk.chunk_text for chunk in chunks)
    assert any("def run" in chunk.chunk_text for chunk in chunks)


def test_typescript_blocks_keep_functions_whole() -> None:
    """TS 按空行分段，函数不被截断。"""

    text = (
        "export function a() {\n"
        "  return 1;\n"
        "}\n"
        "\n"
        "export function b() {\n"
        "  return 2;\n"
        "}\n"
    )
    chunks = _chunks("sample.ts", text, max_chars=60)
    assert len(chunks) == 2
    assert "function a" in chunks[0].chunk_text
    assert "function b" in chunks[1].chunk_text
    assert chunks[0].position == "L1-L4"
    assert chunks[1].position == "L5-L7"


def test_vue_script_functions_are_chunked_with_offset() -> None:
    """Vue 的 script 块应按函数切块，且行号带文件偏移。"""

    text = (
        "<template>\n"
        "  <div>{{ msg }}</div>\n"
        "</template>\n"
        "\n"
        '<script setup lang="ts">\n'
        "export function a() {\n"
        "  return 1;\n"
        "}\n"
        "\n"
        "export function b() {\n"
        "  return 2;\n"
        "}\n"
        "</script>\n"
    )
    chunks = _chunks("app.vue", text, max_chars=60)
    assert any("function a" in chunk.chunk_text for chunk in chunks)
    assert any("function b" in chunk.chunk_text for chunk in chunks)
    assert any(chunk.position.startswith("L6") for chunk in chunks)
    assert any(chunk.position.startswith("L10") for chunk in chunks)


def test_go_functions_are_chunked_by_declarations() -> None:
    """Go 函数按 func 声明切块，不被截断。"""

    text = (
        "package main\n"
        "\n"
        "func Add(a, b int) int {\n"
        "    return a + b\n"
        "}\n"
        "\n"
        "func Sub(a, b int) int {\n"
        "    return a - b\n"
        "}\n"
    )
    chunks = _chunks("math.go", text, max_chars=80)
    assert any("func Add" in chunk.chunk_text for chunk in chunks)
    assert any("func Sub" in chunk.chunk_text for chunk in chunks)


def test_non_code_file_falls_back_to_char_chunking() -> None:
    """非代码文件仍使用固定字符切块。"""

    text = "word " * 500
    chunks = _chunks("notes.txt", text, max_chars=500)
    assert len(chunks) > 1
    assert all(not chunk.position for chunk in chunks)
