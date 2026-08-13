"""run_code 执行器：定位 Python 解释器并在子进程中运行模型程序。

子进程只接收一段 Python 代码 + 一个工具桥接脚本路径，通过 stdin/stdout JSON
协议把工具调用回传给 FastAPI 后端（父进程）执行 TOOL_GATEWAY。
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any

CODE_MODE_TIMEOUT_SECONDS = 120
CODE_MODE_MAX_OUTPUT_CHARS = 64 * 1024


def resolve_python_interpreter() -> str:
    """定位 run_code 用的 Python 解释器。

    优先级：CODE_AGENT_PYTHON 环境变量（打包分发）→ frozen 时随包 python-runtime →
    开发模式 sys.executable。找不到时返回空串，由调用方给出明确提示。
    """

    explicit = os.getenv("CODE_AGENT_PYTHON", "").strip()
    if explicit:
        return explicit

    if getattr(sys, "frozen", False):
        # 打包 onedir：<resources>/backend/ 与 <resources>/python-runtime/ 平级。
        packaged = (
            Path(sys.executable).resolve().parent.parent / "python-runtime" / "python.exe"
        )
        if packaged.is_file():
            return str(packaged)

    candidate = Path(sys.executable).resolve()
    return str(candidate) if candidate.is_file() else ""


async def run_code_program(
    *,
    code: str,
    work_dir: Path,
    bridge_script: Path,
) -> dict[str, Any]:
    """在子进程运行模型程序，返回输出与状态。"""

    interpreter = resolve_python_interpreter()
    if not interpreter:
        return {
            "ok": False,
            "error": (
                "未找到 Python 解释器：请设置 CODE_AGENT_PYTHON 环境变量，"
                "或在开发环境使用系统 Python。"
            ),
        }

    environment = _sandboxed_environment()
    environment["CODE_MODE_BRIDGE"] = str(bridge_script)
    environment["CODE_MODE_SOURCE"] = code
    try:
        process = await asyncio.create_subprocess_exec(
            interpreter,
            "-c",
            _RUNNER_WRAPPER,
            cwd=str(work_dir),
            env=environment,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except OSError as exc:
        return {"ok": False, "error": f"run_code 启动失败：{exc}"}

    try:
        output_bytes, _ = await asyncio.wait_for(
            process.communicate(), timeout=CODE_MODE_TIMEOUT_SECONDS
        )
    except TimeoutError:
        process.kill()
        await process.communicate()
        return {"ok": False, "error": f"run_code 超时（>{CODE_MODE_TIMEOUT_SECONDS}s）"}

    output = output_bytes.decode("utf-8", errors="replace")
    if len(output) > CODE_MODE_MAX_OUTPUT_CHARS:
        output = f"{output[:CODE_MODE_MAX_OUTPUT_CHARS]}\n（输出已截断）"
    return {
        "ok": process.returncode == 0,
        "exitCode": process.returncode,
        "output": output,
    }


def _sandboxed_environment() -> dict[str, str]:
    """run_code 子进程的最小环境：只继承白名单变量，不携带任何 API Key。"""

    from backend.services.agent.shared.command_runner import _sandboxed_environment

    return _sandboxed_environment()


# 子进程内的执行包装：从环境变量取桥接脚本与源码，通过 stdin/stdout JSON 回传。
_RUNNER_WRAPPER = r"""
import os, sys, json, asyncio
sys.path.insert(0, os.environ["CODE_MODE_BRIDGE"])
try:
    from tools_sdk import tools
    source = os.environ.get("CODE_MODE_SOURCE") or ""
    exec(compile(source, "<run_code>", "exec"), {"tools": tools, "asyncio": asyncio})
    sys.exit(0)
except SystemExit:
    raise
except Exception as exc:
    print(f"[run_code 程序异常] {type(exc).__name__}: {exc}", file=sys.stderr)
    sys.exit(1)
"""

__all__ = [
    "CODE_MODE_MAX_OUTPUT_CHARS",
    "CODE_MODE_TIMEOUT_SECONDS",
    "resolve_python_interpreter",
    "run_code_program",
]
