"""run_code 执行器：定位 Python 解释器并在子进程中运行模型程序。

子进程只接收一段 Python 代码 + 一个工具桥接脚本路径。子进程的工具请求以
[REQ] 前缀写到 stdout，本模块并发读取、交给 TOOL_GATEWAY 执行，再把
[RES] 响应写回子进程 stdin；程序自身的 print() 输出原样收集。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from backend.services.agent.code_mode.bridge import (
    CodeModeEnvironment,
    ToolsBridge,
)

CODE_MODE_TIMEOUT_SECONDS = 120
CODE_MODE_MAX_OUTPUT_CHARS = 64 * 1024

_REQ_PREFIX = "[REQ] "


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


async def _serve_child_requests(
    *,
    process: asyncio.subprocess.Process,
    bridge: ToolsBridge,
    output_parts: list[str],
) -> None:
    """并发读子进程 stdout：分发 [REQ] 协议行，其余收集为程序输出。"""

    while True:
        line = await process.stdout.readline()
        if not line:
            break
        text = line.decode("utf-8", errors="replace")
        if not text.startswith(_REQ_PREFIX):
            output_parts.append(text)
            continue
        try:
            request = json.loads(text[len(_REQ_PREFIX) :].strip())
        except json.JSONDecodeError:
            output_parts.append(text)
            continue
        response = await bridge.dispatch(request)
        # 把请求 id 回带进响应，子进程 _call 靠它匹配（否则永远 continue 死循环）。
        response = {"id": request.get("id") or "", **response}
        try:
            process.stdin.write(
                ("[RES] " + json.dumps(response, ensure_ascii=False) + "\n").encode(
                    "utf-8"
                )
            )
            await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            break


async def run_code_program(
    *,
    code: str,
    work_dir: Path,
    bridge_script: Path,
) -> dict[str, Any]:
    """在子进程运行模型程序，工具请求经桥接执行，返回输出与状态。"""

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
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except OSError as exc:
        return {"ok": False, "error": f"run_code 启动失败：{exc}"}

    bridge = ToolsBridge(CodeModeEnvironment(root=work_dir, work_id="run_code"))
    output_parts: list[str] = []
    reader = asyncio.create_task(
        _serve_child_requests(
            process=process,
            bridge=bridge,
            output_parts=output_parts,
        )
    )

    try:
        exit_code = await asyncio.wait_for(
            process.wait(), timeout=CODE_MODE_TIMEOUT_SECONDS
        )
    except TimeoutError:
        process.kill()
        await process.wait()
        reader.cancel()
        return {
            "ok": False,
            "error": f"run_code 超时（>{CODE_MODE_TIMEOUT_SECONDS}s）",
        }

    await reader  # 等剩余输出读完（进程退出后 stdout 关闭，循环自然结束）。
    output = "".join(output_parts)
    if len(output) > CODE_MODE_MAX_OUTPUT_CHARS:
        output = f"{output[:CODE_MODE_MAX_OUTPUT_CHARS]}\n（输出已截断）"
    return {
        "ok": exit_code == 0,
        "exitCode": exit_code,
        "output": output,
    }


def _sandboxed_environment() -> dict[str, str]:
    """run_code 子进程的最小环境：只继承白名单变量，不携带任何 API Key。"""

    from backend.services.agent.shared.command_runner import _sandboxed_environment

    return _sandboxed_environment()


# 子进程内的执行包装：从环境变量取桥接脚本与源码执行；tools_sdk 自身处理
# [REQ]/[RES] 协议，程序 print() 直接写 stdout（父进程收集，不参与工具分发）。
_RUNNER_WRAPPER = r"""
import os, sys
sys.path.insert(0, os.environ["CODE_MODE_BRIDGE"])
try:
    from tools_sdk import tools
    source = os.environ.get("CODE_MODE_SOURCE") or ""
    exec(compile(source, "<run_code>", "exec"), {"tools": tools, "asyncio": __import__("asyncio")})
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
