"""run_code 批量执行通道（对标 DeepSeek Harness 的 Code Mode）。

模型写一段 Python 程序，程序内用 await tools.xxx() 批量调用 read/edit/run/search，
只有 print/return 的内容回上下文——把"一个文件一个往返"变成"一个程序批量干完"。
"""

from backend.services.agent.code_mode.bridge import CodeModeEnvironment, ToolsBridge
from backend.services.agent.code_mode.policy import MAX_PARALLEL_READS, write_tools_sdk
from backend.services.agent.code_mode.runner import (
    CODE_MODE_MAX_OUTPUT_CHARS,
    CODE_MODE_TIMEOUT_SECONDS,
    resolve_python_interpreter,
    run_code_program,
)
from backend.services.agent.code_mode.sdk import SDK_BLOCK

__all__ = [
    "CODE_MODE_MAX_OUTPUT_CHARS",
    "CODE_MODE_TIMEOUT_SECONDS",
    "CodeModeEnvironment",
    "MAX_PARALLEL_READS",
    "SDK_BLOCK",
    "ToolsBridge",
    "resolve_python_interpreter",
    "run_code_program",
    "write_tools_sdk",
]
