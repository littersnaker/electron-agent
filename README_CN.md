# Agent Workspace

一款基于 **Electron + Next.js** 的本地 AI Agent 工作空间，将通用问答、本地代码协作和 AI 图片/视频生成整合到同一个桌面应用中。

[English Version](./README.md) | 中文

## 项目介绍

Agent Workspace 提供三个相互独立的工作模式：

- **QA Agent**：通用问答、文档分析、图片理解和多模态对话。
- **Code Agent**：本地项目索引、代码搜索、任务规划、文件修改、终端执行、构建验证和代码审查。
- **Media Agent**：通过阿里云百炼 / DashScope 模型完成文生图、上传图片改图、文生视频、图生视频、参考图生视频和视频编辑。

媒体生成没有塞进 `/api/qa` 或 `/api/chat`，而是拥有独立的请求、异步任务轮询、进度、预览、会话保存和下载链路，避免文本 SSE 与图片/视频任务互相干扰。

## 核心能力

### QA Agent

- 通用聊天与推理
- 文档和 PDF 分析
- 视觉聊天模型图片理解
- 多模态图文问答
- SSE 流式输出
- Token 消耗显示
- 默认不读取本地项目的独立会话

### Code Agent

- 本地项目管理
- 项目索引与语义代码搜索
- RAG 上下文检索
- 多 Agent 任务编排
- 基于 Diff / Patch 的文件修改
- 终端命令执行
- Lint、Build 和 Test 验证
- SQLite 会话持久化

### Media Agent

- 文生图
- 上传图片后按自然语言指令改图
- 文生视频
- 图生视频
- 参考图生视频
- 视频编辑
- 图片和视频结果预览
- 会话中直接下载生成结果
- 图片额度 / 视频额度显示
- 独立 Media Agent 与 Reviewer 进度状态

## 精准改图与防重影

Media Agent 包含一套图片编辑保护流程，用来降低整图重绘、元素重复、重影、双层边缘和布局漂移。

提供三种编辑策略：

- **精准修改**：尽量保持原图，只改变用户指定区域。适合 UI 截图、电商图、标题、按钮、标签和产品细节修改。
- **平衡编辑**：保留主要结构，允许适度局部重绘。
- **创意重构**：允许大范围重新设计构图、材质和风格。

精准修改流程可包含：

- 原图保护提示词
- 禁止重复对象、双重曝光、重影和多余文字的负向提示词
- 关闭或限制 Prompt 自动扩写
- 尽量保持输入图宽高比
- 生成结果质量检查
- 检查不通过时自动重试一次

> 生图模型生成文字仍可能出现乱码、错字或变形。正式 UI、电商价格、品牌名称和较长中文文案，建议让模型只生成视觉底图与留白区域，最终文字使用 Canvas、SVG、HTML 或设计工具确定性渲染。

## 支持的媒体模式

媒体模型注册表位于：

```text
app/lib/media/catalog.ts
```

当前模式：

```text
text-to-image
image-edit
text-to-video
image-to-video
reference-to-video
video-edit
```

注册模型示例包括：

- Qwen-Image 图片生成与编辑模型
- Wan 文生视频模型
- Wan 图生视频模型
- Wan 参考图生视频模型
- HappyHorse 参考图生视频与视频编辑模型

实际可用模型取决于百炼账号、地域和已开通的模型权限。

## Agent 架构

```text
用户请求
    |
请求路由
    |
Orchestrator
    |
+------+----------------+----------------+
|                       |                |
QA Agent            Code Agent       Media Agent
|                       |                |
Vision / RAG         Planner          Media Provider
LLM Gateway          Researcher       异步任务轮询
                     Coding Agent     质量检查
                     Terminal         预览 / 下载
                     Reviewer
```

### Agent 职责

| Agent | 职责 |
|---|---|
| Orchestrator | 识别请求、协调执行并汇总结果 |
| Planner | 将复杂任务拆分为可执行步骤 |
| Researcher | 检索项目文件、索引、文档和上下文 |
| Coding Agent | 生成和修改代码 |
| Media Agent | 生成或编辑图片与视频 |
| Reviewer | 审查代码或媒体生成结果 |
| Terminal Agent | 执行命令并读取终端输出 |

## LLM 与媒体网关

Agent 逻辑与模型供应商解耦：

```text
Agent Runtime
      |
Gateway / Router
      |
+-----------+-----------+-----------+
|           |           |           |
Qwen      OpenAI      Gemini     DashScope Media
```

能力包括：

- Provider 抽象
- 模型注册表和模型路由
- Prompt Registry
- 文本流式生成
- 图片理解
- Token 统计
- 图片 / 视频额度统计
- 视频异步任务轮询
- 生成结果持久化、预览和下载

## 技术栈

### Desktop

- Electron 43
- Node.js

### 前端

- Next.js 16
- React 19
- TypeScript 6
- Tailwind CSS 4

### AI

- LangGraph
- LangChain Core
- 多供应商 LLM Gateway
- RAG
- 阿里云百炼 / DashScope 媒体 API

### 存储

- SQLite

## 项目结构

```text
app/
├── api/
│   ├── chat/
│   ├── qa/
│   ├── media/
│   │   └── generate/
│   └── workspace/
├── component/
│   ├── AgentPanel.tsx
│   ├── ChatComposer.tsx
│   ├── ChatList.tsx
│   ├── TaskPlanningPanel.tsx
│   └── WorkspaceHeader.tsx
├── hooks/
│   ├── useAgentCoordinator.ts
│   ├── useChatStream.ts
│   └── useWorkspaceController.ts
├── lib/
│   ├── llm/
│   ├── media/
│   │   ├── catalog.ts
│   │   ├── dashscope.ts
│   │   ├── prompt.ts
│   │   ├── edit-policy.ts
│   │   └── quality-checker.ts
│   ├── rag/
│   └── server/
└── utils/

electron/
├── main.ts
└── preload.ts
```

不同代码分支的具体文件名可能略有差异，请以你当前项目中的实际文件为准。

## 环境要求

- Node.js 20 或更高版本
- pnpm
- 用于千问聊天和媒体生成的阿里云百炼 / DashScope API Key
- 可选 OpenAI、Gemini API Key

## 安装

```bash
pnpm install
```

## Web 开发

```bash
pnpm dev
```

终端会显示本地 Next.js 地址。

## Electron 开发

```bash
pnpm electron:dev
```

## 代码检查与构建

```bash
pnpm lint
pnpm build
```

## 桌面应用打包

```bash
pnpm electron:package
pnpm electron:make
```

## 环境变量

在项目根目录创建 `.env.local`：

```env
# 阿里云百炼 / DashScope
DASHSCOPE_API_KEY=

# 可选：百炼业务空间专属 Endpoint
DASHSCOPE_API_BASE=https://dashscope.aliyuncs.com

# 可选：媒体素材临时上传接口
DASHSCOPE_UPLOAD_API_BASE=https://dashscope.aliyuncs.com

# 可选聊天模型供应商
OPENAI_API_KEY=
GEMINI_API_KEY=

# 可选本地数据目录
AGENT_DATA_DIR=
```

不要把真实 API Key 提交到版本库。

## 使用方法

### 文生图

1. 新建或打开 **Media Agent** 会话。
2. 选择“生图”。
3. 选择兼容的 Qwen-Image 模型。
4. 输入构图、风格、尺寸和主体要求。
5. 点击“开始生成”。
6. 在 Assistant 消息中预览并下载图片。

### 上传图片改图

1. 选择“改图”。
2. 上传原图。
3. UI、电商图或仅修改标题时选择“精准修改”。
4. 只描述需要变化的内容。
5. 生成后检查结果并下载。

推荐的精准修改提示词：

```text
只把顶部标题替换为“新品上市”。原图其余像素、布局、产品位置、颜色、
光线、阴影、卡片、图标和背景保持不变。禁止整图重绘，禁止增加重复元素、
重影、双层边缘或额外文字。
```

### 生视频

1. 选择需要的视频模式。
2. 根据模式上传图片或视频素材。
3. 选择兼容的 Wan 或 HappyHorse 模型。
4. 提交任务。
5. 等待异步任务轮询完成。
6. 预览或下载结果。

## 消耗与进度显示

- 文本模型显示输入 Token、输出 Token 和总 Token。
- 媒体模型在接口可获取数据时显示图片或视频额度。
- 右侧 Agent 面板显示 Orchestrator、Media Agent、Reviewer 等执行状态。
- 媒体任务完成后进度应更新到 100%，不再一直停留在 0%。

## 常见问题

### 生图中文字乱码、错字或变形

这是生图模型的能力限制，不是浏览器字体渲染问题。

建议：

- 要求模型不生成文字，只预留干净文案区域。
- 只让模型生成非常短的文字。
- 最终文字使用 Canvas、SVG、HTML 或设计工具叠加。
- 不要直接要求模型在图片中生成密集仪表盘和长中文段落。

### 改图出现重影、重复按钮或双层产品

- 使用“精准修改”。
- 一次只修改一个局部内容。
- 明确写出哪些区域必须保持不变。
- 只改小范围时，不要使用“重新设计”“重构”“更有冲击力”等创意型词语。
- 确认当前选择的是图片编辑模型，而不是只支持文生图的模型。

### Media Agent 进度一直为 0%

检查：

- 当前会话是否为 `image` / Media Agent 模式。
- `AgentPanel.tsx` 是否已经注册 `Media Agent`。
- 媒体请求前、请求中和完成后是否调用 `useAgentCoordinator` 更新状态。
- 成功分支是否将 Media Agent 和 Orchestrator 设置为 `completed` 和 `100`。

### Token 或额度不显示

检查：

- 文本 SSE 是否返回 `USAGE` 数据包。
- 媒体 API 是否返回 `usage`，或前端是否创建媒体次数兜底数据。
- `WorkspaceHeader.tsx` 是否兼容读取 `totalTokens ?? total`。

## 安全说明

发布压缩包或提交代码时不要包含：

```text
.env.local
.env.sentry-build-plugin
.agent-data/
node_modules/
.next/
```

生产环境建议把生成媒体保存到自有 OSS、S3 或 R2，而不是只依赖模型供应商的临时 URL。

## 项目截图

仓库目前包含以下示例截图：

![alt text](image.png)
![alt text](image-1.png)
![alt text](image-2.png)
![alt text](image-3.png)
## Roadmap

- UI / 电商图片确定性文字叠加
- Mask 局部编辑
- 媒体任务历史和重试管理
- 对象存储集成
- 动态 Agent Graph
- 插件系统
- 长期记忆
- 更自主的代码开发流程

## License

MIT License