"""run_code 并发规则与子进程 SDK 脚本生成。"""

from __future__ import annotations

import sys
from pathlib import Path

MAX_PARALLEL_READS = 4
_MAX_REQUEST_CHARS = 500_000

# 子进程内嵌的 tools_sdk 脚本：工具调用经 stdin/stdout JSON 回传父进程执行。
# 只依赖标准库，随 python-runtime 分发，不 import 后端任何模块。
_TOOLS_SDK = '''\
"""run_code 专用工具 SDK：await tools.read(...) 等批量调用工具。"""
import json, sys, os

class _Tools:
    async def _call(self, tool, arguments):
        sys.stdout.write(json.dumps({"tool": tool, "arguments": arguments}) + "\\n")
        sys.stdout.flush()
        line = sys.stdin.readline()
        if not line:
            raise RuntimeError("工具桥接已关闭")
        result = json.loads(line)
        if not result.get("ok"):
            raise RuntimeError(str(result.get("error") or "工具调用失败"))
        return result.get("content")

    async def read(self, path):
        return await self._call("read", {"paths": [path]})

    async def read_many(self, paths):
        result = await self._call("read_many", {"paths": list(paths)})
        return result.get("results", {}) if isinstance(result, dict) else {}

    async def search(self, query):
        return await self._call("search", {"query": query})

    async def inspect(self, paths, query=""):
        return await self._call("inspect", {"paths": list(paths), "query": query})

    async def edit(self, operations):
        return await self._call("edit", {"operations": list(operations)})

    async def run(self, command):
        return await self._call("run", {"command": command})

tools = _Tools()
'''


def write_tools_sdk(target_dir: Path) -> Path:
    """把 tools_sdk.py 写入临时目录，供子进程 import。"""

    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / "tools_sdk.py"
    path.write_text(_TOOLS_SDK, encoding="utf-8")
    return path


def sdk_module_path() -> Path:
    """返回子进程可 import 的 tools_sdk 所在目录（开发/打包通用）。"""

    return Path(sys.executable).resolve().parent


__all__ = [
    "MAX_PARALLEL_READS",
    "sdk_module_path",
    "write_tools_sdk",
]
