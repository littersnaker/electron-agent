"""run_code 并发规则与子进程 SDK 脚本生成。"""

from __future__ import annotations

import sys
from pathlib import Path

MAX_PARALLEL_READS = 4
_MAX_REQUEST_CHARS = 500_000

# 子进程内嵌的 tools_sdk 脚本：工具调用经 stdin/stdout JSON 回传父进程执行。
# 只依赖标准库，随 python-runtime 分发，不 import 后端任何模块。
_TOOLS_SDK = '''\
"""run_code 专用工具 SDK：await tools.read(...) 等批量调用工具。

协议：请求以 [REQ] 前缀写到 stdout，父进程读该行并分发到 TOOL_GATEWAY；
响应以 [RES] 前缀写到子进程 stdin，按请求 id 匹配（支持并发）。程序的
print() 输出不带前缀，父进程会原样收集，不参与工具分发。
"""
import asyncio, json, sys

class _Tools:
    def __init__(self):
        self._seq = 0

    async def _call(self, tool, arguments):
        self._seq += 1
        request_id = str(self._seq)
        line = json.dumps(
            {"id": request_id, "tool": tool, "arguments": arguments},
            ensure_ascii=False,
        )
        sys.stdout.write("[REQ] " + line + "\\n")
        sys.stdout.flush()
        while True:
            response_line = sys.stdin.readline()
            if not response_line:
                raise RuntimeError("工具桥接已关闭")
            if not response_line.startswith("[RES] "):
                continue
            result = json.loads(response_line[6:].strip())
            if str(result.get("id") or "") != request_id:
                continue
            if not result.get("ok"):
                raise RuntimeError(str(result.get("error") or "工具调用失败"))
            return result.get("content")

    async def read(self, path):
        return await self._call("read", {"paths": [path]})

    async def read_many(self, paths):
        # 单管道一问一答，并发 readline 会互相抢走对方响应导致死锁；
        # 这里顺序批量读（一次一个），保证不串线、不丢响应。
        limited = list(paths)[:4]
        merged = {}
        for path in limited:
            try:
                merged[str(path)] = await self._call(
                    "read", {"paths": [str(path)]}
                )
            except Exception as exc:  # noqa: BLE001
                merged[str(path)] = f"[读取失败] {exc}"
        return merged

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
