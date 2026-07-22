# AGENTS.md
本文件是本仓库内所有 AI 编程 Agent 的统一工作说明，目标是让新来的 Agent 能在尽量少的上下文里理解：项目是什么、关键数据流在哪、该改哪里、哪些地方不能乱动。

> 安全提示：仓库根目录存在 `.env.local` 且包含真实密钥。本文档只描述“变量名与用途”，不记录任何真实值；如需分享仓库或开源，请先移除/轮换这些密钥并确认 `.gitignore` 策略。

---

# 项目概述
- 项目形态：同一套代码同时支持 **Next.js Web 应用** 与 **Electron 桌面应用**。
- 核心问题：提供一个“带工作区与项目索引”的 AI 对话/代码修改工作台。
  - `qa` 模式：更像普通聊天，直接走 `/api/qa`。
  - `code` 模式：走 `/api/chat`，后端用 LangGraph 编排多角色工作流，能读文件、检索索引、提出修改并应用补丁，还能执行终端命令（含交互式命令的持续会话）。
- Web / Electron / Agent / 索引关系：
  - Web（Next.js）负责 UI、对话记录、工作区管理、API 路由与 SSE 流式渲染。
  - Electron 主进程负责：启动/托管 Next.js 服务、窗口与原生能力（主题同步、文件夹选择）、以及将 `.env.local` 中的关键变量注入给 Next.js 子进程。
  - Code Agent 工作在 `/api/chat` 的 LangGraph 工作流中；它读取“真实磁盘源码”，索引仅用于加速候选定位。
  - 本地索引与会话数据使用 SQLite（Node 内置 `node:sqlite`）落盘。

---

# 技术栈
来自 [package.json](file:///d:/next-agent/my-app/package.json) / [tsconfig.json](file:///d:/next-agent/my-app/tsconfig.json) / [next.config.ts](file:///d:/next-agent/my-app/next.config.ts) / [electron-builder.yml](file:///d:/next-agent/my-app/electron-builder.yml)。

- 框架：Next.js 16（App Router，`output: "standalone"`）
- UI：React 19
- 语言：TypeScript 6（`strict: true`，`noEmit: true`）
- 样式：Tailwind CSS 4 + PostCSS
- 桌面端：Electron 43（主进程 TS -> esbuild 输出到 `.electron/`），打包用 electron-builder
- 多 Agent/LLM 编排：`@langchain/langgraph` + `@langchain/core`
- 模型/SDK：
  - DashScope（千问）：后端直接以 HTTP 调用（Key 通过 header 或 env 注入）
  - Gemini：`@google/genai` + 自建 SSE 桥接
- 数据存储：SQLite（Node 内置 `node:sqlite`，非 `better-sqlite3`）
- 观测：Sentry for Next.js（含 `tunnelRoute: "/monitoring"`）

---

# 项目目录
核心目录树（省略 `node_modules/`、`.next/`、`out/`、`out-server/`、`.electron/` 等生成目录）：

```text
.
├─ app/
│  ├─ api/                          # Next.js Route Handlers（服务端）
│  │  ├─ chat/                      # code 模式：LangGraph 多 Agent + SSE
│  │  │  └─ agent/                  # 工作流核心（state/graph/nodes/checkpointer）
│  │  ├─ qa/                        # qa 模式：直接流式转发千问
│  │  ├─ workspace/                 # Projects/Sessions CRUD（SQLite）
│  │  ├─ projects/[projectId]/index/# 构建项目索引（SQLite）
│  │  ├─ geminiChat/                # Gemini SSE 桥接
│  │  ├─ config/                    # 返回 hasDefaultKey
│  │  └─ agent/                     # Gemini 单次示例 API（非 LangGraph）
│  ├─ component/                    # UI 组件（Client Components）
│  ├─ hooks/                        # 前端状态与 SSE 消费
│  ├─ lib/server/                   # 仅服务端：workspace-store（SQLite + fs）
│  ├─ const/                        # 主题与模型列表等常量
│  ├─ utils/                        # 工具函数（日期、文件解析、Agent 运行态映射）
│  └─ types/                        # 前端共享类型（SSE packet 等）
├─ electron/                        # Electron 主进程 & preload（TypeScript 源码）
├─ scripts/                         # Electron 打包流水线（tsx 执行）
├─ public/                          # 静态资源（含 icon.png / icon.ico）
├─ electron-builder.yml             # electron-builder 打包配置
├─ next.config.ts                   # Next.js 配置（standalone + sentry）
├─ eslint.config.mjs                # ESLint Flat Config
├─ tailwind.config.ts               # Tailwind 配置
└─ AGENT_SOURCE_GUIDE.md            # 现有源码导读（更偏“学习/复习”）
```

---

# 核心架构

## Electron：主进程与 preload
- 主进程：[electron/main.ts](file:///d:/next-agent/my-app/electron/main.ts)
  - 启动 Next.js 子进程（开发态 `next dev`，生产态运行 `resources/standalone/server.js`）。
  - 读取并加载 `.env.local`（多路径兜底），把 `DASHSCOPE_API_KEY` 等关键变量注入给 Next 子进程。
  - 负责窗口创建与 Apple 风格标题栏（`frame:false` + `titleBarOverlay`），并把主题色同步到原生标题栏覆盖层。
  - IPC：支持 `dialog:openDirectory`（选择文件夹）与 `window:setTheme`（同步主题）。
- Preload：[electron/preload.ts](file:///d:/next-agent/my-app/electron/preload.ts)
  - 在 `contextIsolation: true` 下通过 `contextBridge` 仅暴露有限 API（`selectFolder`、`setTheme`、平台信息等）。

## Next.js：前端与 API 路由
- 前端入口：[app/page.tsx](file:///d:/next-agent/my-app/app/page.tsx)
  - 通过 `useChatStream` 连接 `/api/chat` 或 `/api/qa`，消费 SSE 并更新消息列表、工具活动、交互请求面板等。
  - 通过 `useWorkspaceController` 管理 Projects/Sessions（调用 `/api/workspace` 等）。
  - 通过 `useThemeMode` + `getThemeVariables()`（[theme.ts](file:///d:/next-agent/my-app/app/const/theme.ts)）实现深浅色主题并同步到 Electron。
- API 路由集中在 [app/api](file:///d:/next-agent/my-app/app/api)：
  - `/api/chat`：LangGraph 多 Agent 编排 + SSE（见 [app/api/chat/route.ts](file:///d:/next-agent/my-app/app/api/chat/route.ts)）
  - `/api/qa`：直接 SSE 转发千问（见 [app/api/qa/route.ts](file:///d:/next-agent/my-app/app/api/qa/route.ts)）
  - `/api/workspace`：项目/会话 CRUD（SQLite）（见 [app/api/workspace/route.ts](file:///d:/next-agent/my-app/app/api/workspace/route.ts)）
  - `/api/projects/[projectId]/index`：构建项目索引（见 [app/api/projects/[projectId]/index/route.ts](file:///d:/next-agent/my-app/app/api/projects/%5BprojectId%5D/index/route.ts)）

## 会话与工作区数据如何保存（SQLite）
- Workspace DB：[workspace-store.ts](file:///d:/next-agent/my-app/app/lib/server/workspace-store.ts)
  - 默认路径：`process.cwd()/.agent-data/agent-workspace.sqlite`
  - 可被环境变量覆盖：`AGENT_DATA_DIR`
  - 保存内容：
    - `projects`：项目根目录与索引状态
    - `sessions`：对话会话（`messages_json`）
    - `file_index/symbol_index/code_content`：项目索引（文件元信息、符号、全文）
- LangGraph Checkpoints：[checkpointer.ts](file:///d:/next-agent/my-app/app/api/chat/agent/checkpointer.ts)
  - 独立 SQLite：`process.cwd()/.agent-data/langgraph-checkpoints.sqlite`
  - 保存 LangGraph thread 的 checkpoint/writes，用于多轮对话恢复图状态

## Code Agent 如何读取项目
- 工具定义：[app/api/chat/tools.ts](file:///d:/next-agent/my-app/app/api/chat/tools.ts)
  - 典型闭环：`read_file` → `propose_changes` → `diff` → `apply_patch`
  - 检索：`search_project_index`（SQLite 索引）与 `search_codebase`（直接扫磁盘源码）
  - 终端：`run_terminal_command` 支持普通命令与“持久交互会话”命令
- 工作流节点实现：[workflow-nodes.ts](file:///d:/next-agent/my-app/app/api/chat/agent/workflow-nodes.ts)
  - Search/Memory/File/Planner/Modify/Reviewer/LintBuildTest/FinalReport 等节点都在这里实现

## 本地索引如何创建和使用
- 创建：前端触发 reindex -> 调用 `/api/projects/[projectId]/index` -> `indexProject(...)` 写入 SQLite
- 使用：SearchAgent 在工作流里调用 `search_project_index`，作为“候选文件定位加速器”
- 重要边界：索引不是“真实源码来源”，修改时仍必须 `read_file` 读取磁盘真实文件

## SSE 流式响应如何传递
- 后端（/api/chat）向前端输出 `text/event-stream`，每个事件形如：
  - `data: {"type":"STATUS","content":"..."}\n\n`
- 前端消费位置：
  - [useChatStream.ts](file:///d:/next-agent/my-app/app/hooks/useChatStream.ts) 会逐行解析 `data:` 并按 `type` 分发
  - UI 展示：`ChatList`（消息）、`InteractiveRequestPanel`（终端交互）、`AgentPanel`（角色面板）

## 多 Agent 状态和工具活动如何展示（注意“真实 vs UI”）
- 工具活动：后端确实会发送 `TOOL_STATUS`，前端将其渲染为 ToolActivity 列表（见 [useChatStream.ts](file:///d:/next-agent/my-app/app/hooks/useChatStream.ts)）。
- 角色面板：当前主要是“前端推断/模拟状态”：
  - 前端根据 `STATUS` / `TOOL_STATUS` 文案推断当前角色（见 [agentRuntime.ts](file:///d:/next-agent/my-app/app/utils/agentRuntime.ts) + [useAgentCoordinator.ts](file:///d:/next-agent/my-app/app/hooks/useAgentCoordinator.ts)）
  - 前端类型里预留了 `AGENT_*` 事件（[workspace.ts](file:///d:/next-agent/my-app/app/types/workspace.ts)），但后端 `/api/chat` 目前未发送这些事件（需按需求补齐）

## 前后端主要数据流（概览）

```mermaid
flowchart LR
  UI[Next.js Client UI\napp/page.tsx] -->|POST /api/workspace| WS[workspace route]
  UI -->|POST /api/projects/:id/index| IDX[reindex route]
  UI -->|POST /api/chat (SSE)| CHAT[LangGraph Orchestrator]
  UI -->|POST /api/qa (SSE)| QA[Qwen proxy]

  WS --> DB1[(SQLite\nagent-workspace.sqlite)]
  IDX --> DB1
  CHAT --> DB2[(SQLite\nlanggraph-checkpoints.sqlite)]
  CHAT --> DB1
  CHAT -->|SSE: STATUS/TOOL_STATUS/USAGE/TEXT| UI
  CHAT -->|SSE: INTERACTIVE_REQUEST| UI
  UI -->|下一轮提交 [INTERACTIVE_REPLY]...| CHAT

  E[Electron main] -->|spawn Next server| CHAT
  E -->|IPC: selectFolder/setTheme| UI
  E -->|inject env + set AGENT_DATA_DIR| CHAT
```

---

# 关键文件
以下文件属于“改动影响面最大”的入口点或协议点：

- [package.json](file:///d:/next-agent/my-app/package.json)：脚本/依赖；改 scripts 会影响开发、构建与打包命令
- [next.config.ts](file:///d:/next-agent/my-app/next.config.ts)：standalone 与 Sentry；改错会影响 Electron 生产态启动
- [electron/main.ts](file:///d:/next-agent/my-app/electron/main.ts)：Electron 启动、env 注入、Next 子进程；影响桌面端启动稳定性与密钥注入
- [electron/preload.ts](file:///d:/next-agent/my-app/electron/preload.ts)：安全边界（contextIsolation）；改动会影响 IPC 安全模型
- [electron-builder.yml](file:///d:/next-agent/my-app/electron-builder.yml)：打包内容/额外资源/点文件白名单；改错会导致生产包缺资源或缺 env
- [app/api/chat/route.ts](file:///d:/next-agent/my-app/app/api/chat/route.ts)：code 模式入口 + SSE 协议；改动影响全链路
- [app/api/chat/agent/state.ts](file:///d:/next-agent/my-app/app/api/chat/agent/state.ts)：LangGraph 状态结构；改动影响所有节点与持久化
- [app/api/chat/agent/graph.ts](file:///d:/next-agent/my-app/app/api/chat/agent/graph.ts)：工作流拓扑；改动影响执行顺序与并发结构
- [app/api/chat/agent/workflow-nodes.ts](file:///d:/next-agent/my-app/app/api/chat/agent/workflow-nodes.ts)：节点实现与工具执行；改动影响“会不会真的改文件/跑命令”
- [app/api/chat/agent/checkpointer.ts](file:///d:/next-agent/my-app/app/api/chat/agent/checkpointer.ts)：LangGraph SQLite checkpoint；影响多轮恢复与打包原生依赖风险
- [app/lib/server/workspace-store.ts](file:///d:/next-agent/my-app/app/lib/server/workspace-store.ts)：工作区/索引 SQLite；改动可能影响用户数据与索引一致性
- [app/hooks/useChatStream.ts](file:///d:/next-agent/my-app/app/hooks/useChatStream.ts)：前端 SSE 消费与状态机；改动影响 UI 展示与交互体验
- [app/const/theme.ts](file:///d:/next-agent/my-app/app/const/theme.ts)：主题变量与 Electron 同步；改动影响深浅色与标题栏一致性

---

# 本地开发
以下命令均来自 [package.json scripts](file:///d:/next-agent/my-app/package.json#L12-L23)；未出现的命令不会在此凭空补充。

- 安装依赖：`pnpm install`
  - 依据：项目脚本与锁文件为 pnpm（`pnpm-lock.yaml`，scripts 里大量 `pnpm ...`）
- Web 开发启动：`pnpm dev`
- Web 构建：`pnpm build`
- Web 生产启动（仅 Next）：`pnpm start`
- ESLint：`pnpm lint`
- Electron 开发启动：`pnpm electron:dev`
- Electron 编译主进程：`pnpm electron:compile`
- Electron 一键构建绿色版（脚本流水线）：`pnpm electron:build`
- Electron 打包（目录产物）：`pnpm electron:package`
- Electron 打包（NSIS 安装包）：`pnpm electron:make`

待确认：
- TypeScript 独立类型检查命令：`package.json` 未提供 `typecheck`/`tsc` script（但 `tsconfig.json` 已启用 `noEmit: true`）
- 测试命令：`package.json` 未提供 `test` script，仓库未见 Jest/Vitest/Playwright 配置文件

---

# 环境变量
只记录“变量名/用途/必填/读取位置”，不记录真实值。

## 必填（运行 code/qa 模式时）
- `DASHSCOPE_API_KEY`
  - 用途：调用千问（DashScope）模型
  - 读取位置：`/api/chat` 与 `/api/qa` 优先读请求头 `x-dashscope-api-key`，否则读 `process.env.DASHSCOPE_API_KEY`
  - Electron：主进程会从 `.env.local` 加载后注入 Next 子进程 env

## 选填（按功能启用）
- `GEMINI_API_KEY`
  - 用途：Gemini API（服务端调用）
  - 读取位置：`/api/agent`、`/api/geminiChat`（具体以对应 route 实现为准）
- `NEXT_PUBLIC_GEMINI_API_KEY`
  - 用途：Gemini Key 的前端侧配置（是否在前端实际使用，需以代码引用为准）
- `NEXT_PUBLIC_SENTRY_DSN`
  - 用途：Sentry 客户端 DSN
  - 读取位置：Next.js + Sentry 配置链路
- `HTTP_PROXY` / `HTTPS_PROXY`
  - 用途：为 Gemini SSE 桥接等请求提供代理
  - 读取位置：`/api/geminiChat` 使用 `https-proxy-agent`

## 数据目录与端口（Electron 特别关注）
- `AGENT_DATA_DIR`
  - 用途：SQLite 数据目录根路径
  - 默认：`process.cwd()/.agent-data`
  - Electron：主进程会覆盖注入到 `app.getPath("userData")/workspace-data`，避免写到安装目录
- `PORT` / `HOSTNAME`
  - 用途：Next.js 服务监听地址
  - Electron：主进程启动 Next 子进程时注入（当前固定 `PORT=3000`，`HOSTNAME=localhost`）
- `NEXT_PUBLIC_IS_ELECTRON`
  - 用途：前端判定是否处于 Electron 环境（由主进程注入为 `"1"`）

## 仅构建/上传相关（不要提交）
- `SENTRY_AUTH_TOKEN`
  - 位置：`.env.sentry-build-plugin`
  - 用途：Sentry build plugin 上传 sourcemap（如启用）

---

# 编码规范
基于现有代码的“实际写法”总结（不是抽象规范）。

## TypeScript
- 总体：严格模式（`strict: true`），并用 `noEmit: true` 把 tsc 用作类型检查器
- 类型文件组织：
  - 后端 Agent 协议/状态：集中在 `app/api/chat/agent/{types,state}.ts`
  - 前端 SSE packet：`app/types/workspace.ts`
- 校验：Planner 的结构化输出使用 `zod` 做 schema 校验

## React / Next.js 组件
- `app/page.tsx` 与大部分 UI 组件是 Client Component（显式 `"use client"`）
- Route Handlers 位于 `app/api/**/route.ts`，属于服务端执行环境，可使用 Node API（fs、sqlite 等）

## Client 与 Server 边界
- 仅服务端可用：`app/lib/server/**`（使用 `node:sqlite`、`fs`、`path`）
- 前端禁止直接 import 这些 server-only 文件；需要通过 API routes 间接访问

## Hook 命名与职责
- 约定：`useXxx` 负责单一领域状态（聊天流、主题、工作区、Agent UI 协调等）
- 聊天流（SSE 消费）集中在 [useChatStream.ts](file:///d:/next-agent/my-app/app/hooks/useChatStream.ts)

## import 路径习惯
- 已配置别名：`@/* -> ./*`（见 tsconfig.json）
- 项目内实际使用了 `@/` 别名（主要在 server routes 与 agent 节点里）

## 错误处理方式
- 后端：Route Handler 对缺失 key 等情况返回 `Response.json({error}, {status})`
- 前端：SSE 解析对不完整帧容错（try/catch 忽略），请求失败时写入兜底提示文本

## 样式与主题变量
- 主题变量集中在 [app/const/theme.ts](file:///d:/next-agent/my-app/app/const/theme.ts)，通过 `data-theme` + inline `style={{ ...getThemeVariables(theme) }}` 注入 CSS Variables
- 组件中大量使用 `var(--...)` 读取颜色/阴影/玻璃质感，避免写死深色专用颜色

---

# UI 规范（Apple 风格约束）
这些约束来自现有 UI 的真实实现方式（主题变量 + 毛玻璃容器 + 克制动画）。

- 必须同时支持深色与浅色主题（见 `ThemeMode: "dark" | "light"` 与 `getThemeVariables()`）
- 颜色优先使用 CSS 主题变量（`var(--app-bg)`, `var(--text-primary)`, `var(--border)` 等）
- 不在组件里硬编码“只适用于深色模式”的颜色；如确需强调色，优先复用 `--accent-*`
- 毛玻璃与阴影：
  - 背景常用 `linear-gradient(... var(--glass-strong) ...)` + `backdrop-filter: blur(...)`
  - 阴影优先用 `--shadow-*` 变量
- 动画：短促、平滑，不影响操作（现有 `--ease-apple`，以及 260–300ms 的过渡为主）
- Electron 标题栏颜色必须与页面主题同步：
  - 前端 `persistTheme()` 会调用 `window.electronAPI.setTheme(theme)`（存在时）
  - 主进程接收后更新 `nativeTheme.themeSource` 与 `titleBarOverlay` 颜色
- 新组件必须同时人工检查深色与浅色模式（至少确保边框/文字/hover 状态可读）

---

# Agent 协作规范
本节必须明确区分：前端展示的“角色面板”与后端实际执行的“LangGraph 编排”。

## 已实现：后端真实编排（LangGraph）
- Orchestrator（统一入口）：`/api/chat` 驱动 LangGraph
- Router：清理上一轮中间态并路由本轮任务
- Search / Memory / File：并发收集上下文（图结构同时从 Router 出发）
- Planner：生成结构化任务列表（JSON），并经过 schema 校验与文件唯一性检查
- Modify A/B/C：三路并发修改槽位（避免同文件并发写）
- Reviewer：审查并可触发“定向返工”（只重跑失败槽位）
- Terminal：通过工具执行终端命令；交互式命令支持“持久会话”暂停/恢复

## 已实现：前端状态展示（以文案推断为主）
- 前端固定展示 6 个角色：Orchestrator/Planner/Researcher/Coder/Reviewer/Terminal（见 [AgentPanel.tsx](file:///d:/next-agent/my-app/app/component/AgentPanel.tsx)）
- 状态来源：
  - `STATUS` 文案：推断当前角色（`inferAgentKind(...)`）
  - `TOOL_STATUS`：认为正在执行“工具调用”，同时激活对应角色

## 未实现 / 待确认（不要误报）
- 后端并未发送 `AGENT_START/AGENT_STATUS/AGENT_PROGRESS/AGENT_FINISH/AGENT_ERROR` 事件；前端虽已定义类型与处理分支，但当前不会触发
- 终端交互的“低 token 直连恢复接口”目前不存在：前端仍通过再次调用 `/api/chat` 并提交 `[INTERACTIVE_REPLY] ...` 来恢复会话（这会重新走一轮工作流恢复逻辑）

---

# SSE 协议
协议结构参考 [app/types/workspace.ts](file:///d:/next-agent/my-app/app/types/workspace.ts) 与前端消费实现 [useChatStream.ts](file:///d:/next-agent/my-app/app/hooks/useChatStream.ts)。

## 事件格式
- 传输：`Content-Type: text/event-stream`
- 单条消息：以 `data:` 开头，后跟 JSON 字符串，最后以空行结束

## 已支持事件（/api/chat 与 /api/qa）

### TEXT
- 数据结构：`{ "type": "TEXT", "content": string }`
- 用途：流式增量文本，前端追加到 assistant 消息
- 处理位置：`useChatStream.ts` 中 `packet.type === "TEXT"`

### STATUS
- 数据结构：`{ "type": "STATUS", "content": string }`
- 用途：阶段性状态文案（例如 Planner / Reviewer / Lint 等）
- 处理位置：`useChatStream.ts` 中 `packet.type === "STATUS"`

### TOOL_STATUS
- 数据结构：`{ "type": "TOOL_STATUS", "content": string }`
- 用途：工具调用阶段的状态标签（前端显示“正在执行工具调用…”与最近工具列表）
- 处理位置：`useChatStream.ts` 中 `packet.type === "TOOL_STATUS"`

### USAGE
- 数据结构：`{ "type": "USAGE", "content": { prompt:number, completion:number, total:number } }`
- 用途：token 使用量统计
- 处理位置：`useChatStream.ts` 中 `packet.type === "USAGE"`

### INTERACTIVE_REQUEST
- 数据结构：`{ "type": "INTERACTIVE_REQUEST", "payload": InteractiveRequest }`
- InteractiveRequest 结构（前端）：见 [workspace.ts](file:///d:/next-agent/my-app/app/types/workspace.ts#L9-L18)
  - `id`：持久终端会话 ID（也是本次交互请求 ID）
  - `command`：触发交互的命令
  - `prompt`：提示语
  - `options`：候选按钮
  - `promptRound`：第几轮交互
  - `recentOutput`：最近一段终端输出（增量）
- 用途：让 UI 暂停在“终端交互面板”，等待用户选择/输入
- 处理位置：`useChatStream.ts` 中 `packet.type === "INTERACTIVE_REQUEST"`

## 预留但目前未生效事件（仅类型层存在）
- `AGENT_START` / `AGENT_STATUS` / `AGENT_PROGRESS` / `AGENT_FINISH` / `AGENT_ERROR`
  - 现状：前端定义了类型与处理分支，但后端未发送
  - 如需真实多 Agent 可视化，建议后端补齐发送点并统一 payload 结构

---

# 修改代码的标准流程
任何 Agent 在本仓库内修改代码时，必须遵循以下流程（目的是“最小改动 + 可验证 + 可回滚”）：

1. 先搜索相关文件与引用（例如：从 route 找到调用链，再下钻到 agent 节点/工具实现）。
2. 阅读完整上下文（至少覆盖：imports、相关类型、调用者与被调用者）。
3. 说明修改计划与影响范围（哪些文件、哪些行为会改变，是否影响 Electron/Web）。
4. 优先做最小且完整的修改（能闭环、能跑通；不做“顺手大重构”）。
5. 不修改无关文件（避免为了“顺手整理”而引入无关 diff）。
6. 修改后至少执行一种校验：
   - `pnpm lint`（eslint）
   - 或 `pnpm build`（Next 构建）
   - Electron 相关修改则优先再跑：`pnpm electron:dev`（人工验证启动）
7. 汇报：
   - 修改了哪些文件
   - 做了哪些验证（命令与结果）
   - 遗留风险/待确认点（明确写出来，不要隐藏）

# 禁止事项
至少包含以下硬约束（违反会导致安全/数据/打包风险）：

- 不提交真实密钥（API Key、Token、DSN、代理账号等）；文档与日志中也不要打印明文
- 不随意删除用户数据（`.agent-data/`、Electron `userData` 下的数据库与缓存）
- 不绕过 `contextIsolation`；不把 `nodeIntegration` 改成 `true`
- 不在不理解风险时开启 `sandbox`/关闭 `sandbox` 的大改（当前为 `sandbox:false`，需评估后再调整）
- 不未经确认修改数据库 schema（`workspace-store.ts` 与 `checkpointer.ts` 的建表/字段）
- 不通过 `any` 大量绕过类型检查；必须解释为何需要以及如何收敛
- 不伪造“测试/构建通过”；无法验证就明确写“未验证/待确认”
- 不把纯前端动画/推断状态描述成“后端真实并发执行证据”
- 不在不知道影响范围时大规模重构（尤其是 `workflow-nodes.ts`、`workspace-store.ts`、`electron/main.ts`）

# 完成标准
一个任务在本项目中可视为“完成”，需满足：

- 需求实现完整，且与既有工作流/协议兼容
- TypeScript 无新增错误（至少保持 `pnpm build` 可过）
- 深色与浅色主题均可用（文字/边框/hover 可读）
- Electron 与 Web 环境均未被破坏（涉及 Electron 的改动必须人工验证启动）
- 相关检查已运行（至少 lint 或 build；有测试时再补测试）
- 变更范围与风险已经说明（含待确认项与后续建议）

