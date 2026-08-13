"""run_code 的 SDK 文本：注入 system prompt，教模型写批量工具程序。"""

from __future__ import annotations

SDK_BLOCK = """## run_code SDK（CODE_AGENT_CODE_MODE 已开启）

你可以写一段 Python 程序，用 await tools.xxx() 批量调用工具，一次完成多个文件操作：
- `await tools.read(path)` → 返回文件内容字符串（大文件返回 spill 定位符）
- `await tools.read_many(paths)` → 返回 {path: content} 字典
- `await tools.search(query)` → 返回搜索结果字符串
- `await tools.inspect(paths, query)` → 返回代码结构分析
- `await tools.edit(operations)` → operations: [{type:"write"|"replace"|"delete", path, content?, oldText?, newText?}]
- `await tools.run(command)` → 返回命令输出（受限白名单）

规则：
1. 只有 print() 或 return 的内容会回到上下文，工具的完整输出不会自动注入；
2. read_many 一次读多个文件（最多 4 个，顺序执行）；工具调用是串行一问一答，不要自己开 asyncio.gather 并发调工具；
3. 工具调用失败会抛异常，可以用 try/except 捕获并 print 错误；
4. 程序必须是自包含的，不要 import 任何第三方库；
5. 优先用 read_many 一次读多个文件，减少往返。

示例：
```python
import asyncio
from tools_sdk import tools  # 框架注入，不要自己定义

async def main():
    files = await tools.read_many(["src/app.ts", "src/api.ts"])
    await tools.edit([
        {"type": "replace", "path": "src/app.ts", "oldText": "旧代码", "newText": "新代码"},
    ])
    out = await tools.run("pnpm typecheck")
    print(files["src/app.ts"][:200])
    print(out)

asyncio.run(main())
```
"""

__all__ = ["SDK_BLOCK"]
