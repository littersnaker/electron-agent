# 自定义模型、SQLite 与 Base URL 使用说明

## 1. 本次界面变化

普通问答的模型选择器不再展示项目内置模型，只固定显示：

- `Auto Orchestration`
- 用户在“＋ 添加模型”弹窗中创建的模型

这里的“清除现有模型”只针对选择器展示层。`config/chat-models.json` 中已有模型的
`model` 值、逻辑 ID 和 Auto 路由配置没有被修改；它们仍可作为 Auto 的内部候选，
从而保留原有百炼兜底和向下兼容能力。

## 2. 添加模型

在普通问答模式中打开模型选择器，单击“＋ 添加模型”。

弹窗字段说明：

- **显示名称**：仅用于界面显示。
- **供应商 / Key 来源**：决定读取哪一组 API Key。
- **模型 model 值**：原样写入 SQLite，调用时原样发送，不做别名替换。
- **Base URL**：只覆盖当前自定义聊天模型。
- **允许 Auto 自动尝试**：开启后，该模型进入 Auto 候选链。
- **Auto 优先级**：数字越小越早尝试。
- **支持图片理解 Vision**：只有模型真实支持图片输入时才开启。

新增、修改、删除均立即同步到 Python 内存缓存，不需要重启。重启后，Python 会从
SQLite 重新加载全部记录。

## 3. SQLite 保存位置

表名：

```sql
custom_models
```

开发桌面模式默认数据库路径：

```text
Windows: %APPDATA%\Multi-agent\python-data\workspace.db
macOS:   ~/Library/Application Support/Multi-agent/python-data/workspace.db
Linux:   ~/.config/Multi-agent/python-data/workspace.db
```

单独启动 Python、且未设置 `MULTI_AGENT_DESKTOP_DEV=1` 时：

```text
<项目根目录>/.local-data/workspace.db
```

可通过环境变量强制指定：

```env
AGENT_DATA_DIR=D:/Multi-agent-data
```

此时数据库为：

```text
D:/Multi-agent-data/workspace.db
```

## 4. 本项目自己的后端 API

### 自定义模型

```text
GET    /api/models/custom
POST   /api/models/custom
PUT    /api/models/custom/{model_id}
DELETE /api/models/custom/{model_id}
```

### 查看请求地址说明

```text
GET /api/models/endpoints
```

### 聊天与媒体

```text
POST /api/qa
POST /api/chat
POST /api/media/generate
GET  /api/media/download?url=...
```

## 5. 实际供应商请求地址

假设百炼业务空间根域名为：

```text
https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com
```

### 聊天模型

Base URL：

```text
https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
```

最终请求：

```text
POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions
```

### 图片生成与图片编辑

```text
POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
```

### 视频生成与视频编辑

提交任务：

```text
POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis
```

轮询任务：

```text
GET https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/tasks/{task_id}
```

上传视频素材：

```text
POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/uploads
```

## 6. Base URL 的真实生效优先级

### 单个自定义聊天模型

```text
自定义模型弹窗 Base URL
→ 设置页对应供应商 Base URL
→ .env.local / 系统环境变量
→ Python 构建时内置地址
→ 代码默认公共地址
```

自定义模型弹窗中的 Base URL 只作用于该聊天模型，不作用于图片和视频。

### 百炼图片和视频

```text
设置页 Qwen / DashScope Base URL
→ DASHSCOPE_MEDIA_BASE_URL
→ 旧变量 DASHSCOPE_API_BASE
→ DASHSCOPE_BASE_URL
→ Python 构建时内置地址
→ https://dashscope.aliyuncs.com
```

媒体代码允许在设置页粘贴以下任意一种形式：

```text
https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com
https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions
https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
```

Python 会先提取业务空间根域名，再拼接图片或视频的原生路径。

## 7. 为什么以前修改 Base URL 不生效

旧版媒体模块只读取 `DASHSCOPE_API_BASE`，而设置页保存的是
`DASHSCOPE_BASE_URL`，两条配置链彼此独立。因此聊天可能使用新地址，图片和视频仍然
请求旧公共域名。

现在 `/api/media/generate` 会读取设置页随请求发送的
`x-llm-base-url-qwen`，并把同一业务空间域名传给图片、视频、上传和任务轮询接口。

## 8. 推荐修改方式

### 运行软件时修改

1. 右上角进入 API 设置。
2. 找到 `Qwen / DashScope`。
3. 在 `API Base URL` 粘贴当前 Key 所属业务空间地址。
4. 单击保存。
5. 单击“验证”确认聊天端点可用。
6. 图片和视频无需再填写另一份地址。

设置页保存后立即作用于下一次请求，不需要重新打包。

### 本地开发通过 `.env.local` 修改

```env
DASHSCOPE_API_KEY=你的Key
DASHSCOPE_BASE_URL=https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
# 可选：媒体使用不同根域名时才配置
DASHSCOPE_MEDIA_BASE_URL=https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com
```

修改 `.env.local` 后应停止并重新执行：

```bash
pnpm dev
```

原因是环境变量只在 Python 进程启动时加载；React 热更新不会重新加载 Python 的环境变量。

## 9. 对应代码位置

| 需求 | 修改位置 |
|---|---|
| 选择器只显示 Auto + 用户模型 | `app/constants/modelList.ts` |
| 新增/编辑模型弹窗 | `app/components/CustomModelModal.tsx` |
| 模型选择器中的增删改入口 | `app/components/ModelSelector.tsx` |
| 前端自定义模型 API | `app/hooks/useCustomModels.ts` |
| SQLite 表 | `backend/services/workspace/database.py` |
| SQLite CRUD 与启动加载 | `backend/services/llm/custom_models.py` |
| 自定义模型 REST API | `backend/api/models.py` |
| 聊天 Base URL 与候选路由 | `backend/services/llm/gateway.py` |
| 图片/视频 Base URL 解析 | `backend/services/media/dashscope.py` |
| 设置页 Base URL 传入媒体请求 | `backend/api/media.py` |
| 原有内置模型 model 值 | `config/chat-models.json`（本次未修改） |
