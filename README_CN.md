# Multi-agent：Electron + React + FastAPI 迁移版

这是从原 **Electron + Next.js** 项目迁移出的桌面 AI Agent 工程：

- 桌面容器：Electron
- 界面：React + Vite + TypeScript
- 业务服务：Python + FastAPI
- 本地数据库：SQLite
- Python 发布：PyInstaller onedir 后端目录（避免每次启动解压）
- 桌面安装包：electron-builder

你在开发阶段需要安装 Python；最终打出的安装包会自带 Python 后端可执行文件，普通用户不需要安装 Python。

## 一、最快启动

完整步骤见 [INSTALL_PYTHON_CN.md](./INSTALL_PYTHON_CN.md)。也可以先运行半自动安装脚本：

```powershell
# Windows
.\setup-windows.ps1
```

```bash
# macOS / Linux
./setup-macos-linux.sh
```

已经装好 Node、pnpm 和 Python 后，在项目根目录执行：

```powershell
# Windows PowerShell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements-dev.txt
pnpm install
Copy-Item env.example .env.local   # 已有 .env.local 时不要覆盖
pnpm dev
```

macOS / Linux：

```bash
python3.13 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-dev.txt
pnpm install
cp env.example .env.local          # 已有 .env.local 时不要覆盖
pnpm dev
```

`pnpm dev` 会先清除旧 `dist`、Electron 编译产物和开发缓存，然后同时启动：

1. Vite React 热更新服务；
2. Uvicorn Python 源码热更新服务；
3. `config/chat-models.json` 模型同步 watcher；
4. Electron 主进程编译与自动重启 watcher。

开发端口被旧进程占用时会直接停止并提示 PID 排查方法，不会静默连接修改前的后端。

## 二、项目结构

```text
.
├─ app/                         React 页面、组件、Hooks、前端类型
├─ backend/                     Python FastAPI 业务服务
│  ├─ api/                      HTTP/SSE 接口层
│  ├─ core/                     配置、日志、请求审计、后台任务生命周期
│  ├─ schemas/                  Pydantic 请求/响应模型
│  ├─ services/
│  │  ├─ agent/                 统一 Agent Runtime（planner/worker/loop/shared/reflection）
│  │  ├─ commerce/              市场研究、评论分析、Listing 草稿
│  │  ├─ llm/                   多模型网关（OpenAI 兼容 / Gemini 协议）
│  │  ├─ mcp/                   MCP 服务发现
│  │  ├─ media/                 图片/视频生成
│  │  ├─ skills/                外部 Skill 安装与启用
│  │  ├─ tools/                 Tool Gateway（search/read/inspect/edit/run/filesystem）
│  │  └─ workspace/             项目、索引、SQLite、已完成工作注册表
│  ├─ tests/                    Python 冒烟测试
│  └─ main.py                   FastAPI 入口
├─ electron/                    Electron 主进程、preload、IPC
├─ scripts/                     构建脚本
├─ public/                      图标等静态资源
├─ main.tsx                     Vite React 入口
├─ package.json                 Node 依赖与命令
├─ requirements.txt             Python 运行依赖
├─ requirements-dev.txt         Python 开发/打包依赖
└─ electron-builder.yml         桌面安装包配置
```

## 三、开发命令

```bash
# 推荐：同时运行 React、Electron、FastAPI
pnpm dev

# 只运行 Python 后端
python -m backend.main

# 只运行 React（需要另开终端运行后端）
pnpm frontend:dev

# Python 语法检查
pnpm backend:check

# Python 冒烟测试
pnpm backend:test

# 前端类型检查
pnpm typecheck

# Electron 类型检查
pnpm electron:typecheck

# Vite 生产构建
pnpm build
```

FastAPI 单独启动后：

- 轻量存活检查：`http://127.0.0.1:8765/api/health/live`
- 详细健康检查：`http://127.0.0.1:8765/api/health`
- 接口文档：`http://127.0.0.1:8765/api/docs`

## 四、打包桌面安装程序

首次打包前，确保已经安装 `requirements-dev.txt`，因为其中包含 PyInstaller。

```bash
# 先执行完整检查
pnpm verify

# 当前操作系统安装包
pnpm electron:make

# Windows x64
pnpm electron:make:win

# macOS
pnpm electron:make:mac

# Linux
pnpm electron:make:linux
```

打包过程依次生成：

1. `.electron/`：Electron 主进程 JavaScript；
2. `dist/`：Vite React 静态页面；
3. `python-dist/multi-agent-backend/`：Python 后端可执行文件及 `_internal` 运行依赖；
4. `release/`：最终安装包。

生产安装包不会直接复制 `.env.local` 文件。构建 Python 后端时，脚本只提取百炼的 `DASHSCOPE_API_KEY` 和可选 `DASHSCOPE_BASE_URL`，生成内置凭证模块并打入 PyInstaller 可执行文件。用户未配置个人百炼 Key 时会自动使用该兜底；填写个人 Key 后则优先使用用户 Key。详细说明见 [BUILTIN_BAILIAN_FALLBACK_CN.md](./BUILTIN_BAILIAN_FALLBACK_CN.md)。

## 五、Python 后端模块怎么理解

### `backend/main.py`

相当于 Node 服务里的 `server.ts`：创建 FastAPI、注册中间件、初始化 SQLite、加载路由，并在生产环境托管 React 静态页面。

### `backend/api/`

相当于原来的 Next API Routes。该目录只做：

- 接收请求；
- 校验参数；
- 调用 service；
- 转换异常；
- 返回 JSON 或 SSE。

复杂业务不要直接堆在 API 文件中。

### `backend/services/`

真正的业务层。按 Agent、LLM、工作区、媒体、Commerce、MCP 分开，避免单文件过长。

### `backend/schemas/`

相当于 TypeScript 的 interface/type，但会在运行时验证前端传来的 JSON。

## 六、当前保留的能力

- 多模型配置和模型列表，auto 自动路由与供应商级熔断；
- 流式聊天/SSE；
- 原生 Function Calling：工具 Schema 透传、流式 tool_calls 累加（兼容 DeepSeek 无 id 分片）；
- 项目创建、读取和 SQLite 持久化（版本化迁移 + WAL）；
- 项目文件索引与上下文搜索；
- Code Agent 完整链路：意图分类 → Planner WorkList → 并行调度（同文件冲突串行）→ 事务式编辑 → 失败只重排失败项 → Checkpoint 断点恢复 → 终审；
- 已完成工作注册表：同标题且产物健在的 Work 确定性跳过，防重复执行；
- 执行守卫：重复动作拦截、只读停滞警告、迭代预算与 token 硬止损；
- 后台任务句柄化：复盘/记忆评估/索引统一登记，关闭时排空，杜绝 Event loop is closed；
- Agent Trace/可观测性与请求审计日志；
- 记忆系统：episodic/semantic/task 三类记忆，执行后异步复盘沉淀知识；
- 电商市场研究：TalorData SERP + Amazon（SP-API 优先、公开爬虫兜底）+ TikTok Shop/1688 官方 API；
- Amazon 评论分析：对评论量最高的商品采集公开评论，评分分布 + 情感主题（LLM 增强第一个商品），降级为明确标注的演示样本；
- 未配置数据源时的明确 demo 模式；
- Listing 文案草稿演示（pending/confirmed/rejected 状态机，不发布）；
- MCP Server/工具目录发现；
- 外部 Skill 发现、GitHub 批量安装与启用配置；
- Electron 目录选择、窗口控制和 PDF 导出；
- SQLite 与全盘扫描移出事件循环：`asyncio.to_thread` 承载 DB 操作与文件树遍历，SSE 期间不再被阻塞。

## 七、需要你知道的迁移边界

1. MCP 当前只负责发现和显示工具，Code Agent 尚未自动执行远程 MCP 工具。
2. Listing 功能只生成文案，不会向真实电商平台发布商品。
3. TikTok Shop、1688 已接入官方 API（配置凭据后采集真实商品样本）；Temu、Keepa 仅显示凭据状态占位，尚无真实 API 客户端。
4. 没有 TalorData 或 Amazon 可用数据源时，市场研究会返回带 `runMode: demo` 标识的数据，评论分析失败时同样降级为明确标注的演示样本，不会伪装成真实调研结果。
5. 模型供应商可能调整模型 ID；如果供应商返回“模型不存在”，请在 `config/chat-models.json` 中更新映射（供应商配置在 `config/providers.json`）。

## 八、代码规范

- Python 业务文件全部控制在 500 行以内；
- 每个 Python 函数和方法都有中文 docstring；
- 新增 Electron/Vite 工具函数都有中文 JSDoc；
- API、业务、数据访问分层；
- 用户密钥从请求头、环境变量或本地设置读取；百炼还可使用构建时嵌入 Python 的共享兜底；
- 文件写入必须经过提案和人工批准；
- 媒体下载会阻止 localhost、私有网段和危险重定向。

## 九、常见问题

### `python` 找不到

Windows 优先尝试：

```powershell
py -3.13 --version
```

macOS/Linux 优先尝试：

```bash
python3.13 --version
```

### PowerShell 不允许激活虚拟环境

仅对当前终端临时放开：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

也可以完全不激活，直接执行：

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
```

### FastAPI 启动后 Electron 白屏

依次检查：

```bash
python -m backend.main
pnpm frontend:dev
pnpm electron:compile
```

再访问 `/api/health`，查看终端中 `[FastAPI]` 开头的日志。

### 端口被占用

Electron 会自动选择其他端口。只有你单独执行 `python -m backend.main` 时，才需要修改 `.env.local` 中的 `BACKEND_PORT`。

### 安装包启动时报“未找到 Python 后端”

说明打包前没有生成完整的 `python-dist/multi-agent-backend/` onedir 后端。先执行：

```bash
python scripts/build-python-backend.py
pnpm electron:make
```

更多迁移说明见 [MIGRATION_GUIDE_CN.md](./MIGRATION_GUIDE_CN.md)，本次已执行的检查见 [VALIDATION_REPORT_CN.md](./VALIDATION_REPORT_CN.md)。

安装包后端冷启动和健康检查说明见 [PACKAGED_BACKEND_STARTUP_FIX_CN.md](./PACKAGED_BACKEND_STARTUP_FIX_CN.md)。

## 本地热更新与模型修改

本地开发统一使用 `pnpm dev`。React、Python、模型 JSON 和 Electron 主进程均支持热更新。聊天模型只需修改 `config/chat-models.json`。详细说明见 [HOT_RELOAD_MODEL_GUIDE_CN.md](./HOT_RELOAD_MODEL_GUIDE_CN.md)。
