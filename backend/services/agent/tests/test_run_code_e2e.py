"""run_code 端到端测试：真实子进程调用 tools.read 打通网关 + env 大小写。"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from backend.services.agent.code_mode import run_code_program, write_tools_sdk
from backend.services.agent.code_mode.runner import resolve_python_interpreter


@pytest.mark.asyncio
async def test_run_code_reads_file_end_to_end() -> None:
    """真实子进程里 tools.read 应打通网关并拿到文件内容。"""

    interpreter = resolve_python_interpreter()
    if not interpreter:
        pytest.skip("无可用 Python 解释器")
    root = Path(tempfile.mkdtemp())
    (root / "hello.txt").write_text("hello from run_code", encoding="utf-8")
    sdk_dir = Path(tempfile.mkdtemp(prefix="sdk-"))
    write_tools_sdk(sdk_dir)
    code = (
        "import asyncio\n"
        "from tools_sdk import tools\n"
        "async def main():\n"
        "    c = await tools.read('hello.txt')\n"
        "    print('GOT:', c, flush=True)\n"
        "asyncio.run(main())\n"
    )
    result = await run_code_program(code=code, work_dir=root, bridge_script=sdk_dir)

    assert result.get("ok") is True, result
    assert "GOT:" in (result.get("output") or "")
    assert "hello from run_code" in (result.get("output") or "")


@pytest.mark.asyncio
async def test_run_code_read_many_end_to_end() -> None:
    """read_many 顺序读多个文件应全部返回。"""

    interpreter = resolve_python_interpreter()
    if not interpreter:
        pytest.skip("无可用 Python 解释器")
    root = Path(tempfile.mkdtemp())
    for index in range(3):
        (root / f"f{index}.txt").write_text(f"content-{index}", encoding="utf-8")
    sdk_dir = Path(tempfile.mkdtemp(prefix="sdk-"))
    write_tools_sdk(sdk_dir)
    code = (
        "import asyncio\n"
        "from tools_sdk import tools\n"
        "async def main():\n"
        "    files = await tools.read_many(['f0.txt','f1.txt','f2.txt'])\n"
        "    for name, content in files.items():\n"
        "        print(name, content, flush=True)\n"
        "asyncio.run(main())\n"
    )
    result = await run_code_program(code=code, work_dir=root, bridge_script=sdk_dir)

    assert result.get("ok") is True, result
    output = result.get("output") or ""
    assert "f0.txt" in output and "content-0" in output
    assert "f2.txt" in output and "content-2" in output


def test_sandboxed_environment_case_insensitive(monkeypatch) -> None:
    """Windows 环境变量大小写不敏感：只有 SYSTEMROOT 时也能带进 SystemRoot。"""

    from backend.services.agent.shared.command_runner import _sandboxed_environment

    monkeypatch.delenv("SystemRoot", raising=False)
    monkeypatch.setenv("SYSTEMROOT", r"C:\WINDOWS")

    env = _sandboxed_environment()

    assert env.get("SystemRoot") == r"C:\WINDOWS"
