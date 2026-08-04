# Electron + Next.js 到 Electron + React + FastAPI 迁移说明

## 一、最终数据流

开发环境：

```text
React(Vite:5173)
    │ fetch/SSE
    ▼
FastAPI(随机本地端口)
    │
    ├─ SQLite
    ├─ LLM API
    ├─ 项目文件
    └─ Commerce / Media / MCP

Electron 主进程负责同时管理 React 窗口和 FastAPI 子进程。
```

生产环境：

```text
Electron
    └─ 启动 resources/backend/multi-agent-backend
           ├─ 提供 /api/*
           └─ 托管 resources/frontend/index.html
```

## 二、新旧职责映射

| 原职责 | 迁移后位置 |
|---|---|
| Next 页面运行时 | Vite + `main.tsx` |
| Next API Routes | `backend/api/` |
| TypeScript Agent 服务 | `backend/services/agent/` |
| TypeScript LLM 客户端 | `backend/services/llm/` |
| 工作区数据库 | `backend/services/workspace/` |
| Commerce 服务 | `backend/services/commerce/` |
| 媒体接口 | `backend/services/media/` + `backend/api/media.py` |
| Electron 巨型 main 文件 | `electron/main.ts`、`window.ts`、`ipc.ts`、`backend-process.ts` |
| Next 静态输出 | Vite `dist/` |
| Node 服务端生产包 | PyInstaller `python-dist/` |

## 三、前端请求迁移

前端不再直接依赖固定端口。所有请求通过：

```text
app/lib/api-client.ts
```

开发模式由 Electron preload 注入 `backendBaseUrl`；生产模式 React 与 FastAPI 同源，直接使用 `/api/...`。

因此不要在组件中写死：

```ts
fetch("http://127.0.0.1:8765/api/...")
```

应使用：

```ts
apiFetch("/api/...")
```

## 四、Electron 启动 Python 的方式

`electron/backend-process.ts` 会：

1. 查找 `PYTHON_EXECUTABLE`；
2. 查找项目 `.venv`；
3. 回退到系统 `python/python3`；
4. 寻找空闲端口；
5. 使用 `python -m backend.main` 启动；
6. 轮询 `/api/health`；
7. 向 preload 传递后端地址；
8. Electron 退出时终止 Python。

生产环境不调用系统 Python，而是调用 PyInstaller 可执行文件。

## 五、Agent 写文件安全流程

```text
用户提出修改
  → 分类为 code_change
  → 检索上下文
  → LLM 生成结构化 proposal
  → 前端显示待批准内容
  → 用户批准
  → 校验项目内路径
  → 写入文件
  → 更新索引
  → 记录 Trace
  → 失败时回滚
```

未经批准不会自动写项目文件。

## 六、兼容性说明

为了让原 UI 尽量不改，FastAPI 保留了原前端需要的：

- API 路径；
- JSON 字段命名；
- SSE `data:` 数据包格式；
- Commerce progress/report/listing/usage 事件；
- 模型和配置状态响应；
- Electron 窗口与 PDF 导出 API。

## 七、为什么删除旧文件

交付包删除了不再参与构建的 Next 配置、旧 Node 服务端代码、旧爬虫测试、Docker 文件和过期设计文档。保留它们会导致初学者误运行旧命令，或者把已迁移的业务改回两套实现。

## 八、继续开发的规则

1. API 文件只负责请求/响应，不写大段业务；
2. 业务放 `backend/services/<domain>/`；
3. 请求模型放 `backend/schemas/`；
4. 每个 Python 函数写中文 docstring；
5. 单文件接近 450 行就提前拆分；
6. React 请求统一走 `apiFetch`；
7. 任何真实外部写操作都必须人工确认；
8. 密钥永远不打印、不放前端 bundle、不提交 Git。
