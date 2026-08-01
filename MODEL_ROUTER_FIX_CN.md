# Model Router、Kimi 与本地缓存修复说明

## 1. 结论

本项目的 Model Router 确实存在问题，而且不是单一故障。主要问题包括：

1. 手动选择某个模型但该供应商没有 Key 时，旧 Router 会静默改用另一个供应商，导致界面显示的模型与实际调用模型不一致。
2. Auto 模式只判断“是否配置了 Key”，不会在真实请求失败后切换到其他可用模型。
3. 部分逻辑 ID、显示名称与厂商真实模型名不一致：
   - 旧 Kimi 逻辑 ID 为 `kimi:kimi-k2.5`，实际发送的却是 `kimi-k3`。
   - 千问预览模型真实名称错误写成 `7-max-27-max-2026-06-08`。
   - 百炼托管的 GLM、Kimi、DeepSeek 模型默认参与 Auto，但账号可能并未开通对应服务。
4. 所有 OpenAI-compatible 供应商都被统一附加 `stream_options`；该扩展参数并非所有兼容实现都稳定支持。
5. 千问只配置了一个固定区域端点。Key 与地域或工作空间不匹配时，会被误判为 Key 无效。
6. Kimi 的 Key 可能来自不同控制台域名；`platform.kimi.com` 和 `platform.kimi.ai` 的 Key 不能混用。
7. 会话、API Key、模型选择和插件开关分别保存在 SQLite、浏览器 `localStorage` 和 Electron `userData`。开发地址、安装包名称或启动方式变化后，应用可能读取另一套目录。
8. 前端保存会话时没有检查 HTTP 状态码，服务端保存失败后界面仍看起来正常，直到重启才发现数据没有写入 SQLite。

## 2. 已完成的修复

### 2.1 模型注册表

- 前后端统一使用稳定逻辑 ID，厂商真实模型名单独存放。
- 千问默认模型统一为 `qwen3.7-max`。
- 千问多模态通用模型统一为稳定别名 `qwen3.7-plus`。
- 修正千问快照为 `qwen3.7-max-2026-06-08`。
- Kimi 统一为 `kimi:kimi-k3 -> kimi-k3`。
- 保留旧 `kimi:kimi-k2.5` 迁移别名，升级后不会丢失用户原有选择。
- 新增 Kimi K2.7 Code，且只允许手动选择。
- 百炼托管第三方模型及固定快照设置为 `autoSelect=false`，避免 Auto 误调用未开通服务。
- GLM 默认升级为 `glm-5.2`，保留 `glm-4.7` 手动兼容选项。

### 2.2 Router 行为

- 手动选择模型时严格调用该模型：缺少对应 Key、能力不足或模型错误时直接报告，不再偷偷切换供应商。
- Auto 模式构建真实候选链，并在“尚未输出任何内容”的情况下自动尝试下一个候选模型。
- 一旦已经输出部分内容，禁止切换模型，避免把两个供应商的回答拼接在一起。
- 图片请求自动过滤纯文本模型，只选择带 `vision` 能力的模型。
- 对每次失败记录供应商、模型和安全错误信息，最终返回可操作的中文汇总。

### 2.3 端点与协议兼容

- OpenAI-compatible 请求只发送通用最小字段，不再强制发送 `stream_options`。
- 千问依次支持中国、新加坡、美国公共端点回退。
- 支持通过环境变量覆盖企业网关或专属工作空间 Base URL：
  - `DASHSCOPE_BASE_URL`
  - `OPENAI_BASE_URL`
  - `DEEPSEEK_BASE_URL`
  - `GLM_BASE_URL`
  - `KIMI_BASE_URL`
- Base URL 可填写到 `/v1` 或 `/compatible-mode/v1`，Router 会自动补全 `/chat/completions`。
- 保留供应商返回的错误 `code/type`，方便区分鉴权、模型不存在、额度和网络问题。

### 2.4 真实连接验证

设置弹窗中的每个模型供应商新增“验证”按钮。验证不是检查 Key 字符串格式，而是发送一次最小真实请求，并区分：

- 未配置；
- 401/403 鉴权失败；
- 404 模型未开放或模型名错误；
- 429 余额、并发或速率限制；
- 网络错误；
- 正常连接及耗时。

供应商级验证会在第一个模型返回 404 时继续测试同供应商的备用通用模型。例如 Kimi K3 未开放但 K2.6 可用时，仍可确认该 Key 和端点是有效的。

Kimi 特别提示：

- 本项目默认使用 `https://api.moonshot.cn/v1/chat/completions`，与用户提供的 `platform.kimi.com` 文档对应。
- 若返回 401/403，请确认 Key 不是从 `platform.kimi.ai` 创建；两个平台的 Key 不通用。
- 若返回 404，请在控制台确认账号等级是否开放目标模型，并使用 `/v1/models` 查看当前 Key 可见的模型 ID。

### 2.5 缓存与重启持久化

- Electron 数据目录改为固定的 `appData/Multi-agent`，不再依赖开发版或安装包的动态应用名称。
- FastAPI SQLite、媒体缓存、主题、模型选择、插件开关与凭证均使用该固定根目录。
- 首次启动自动迁移：
  - 旧 Electron `userData/python-data`；
  - 项目开发目录 `.local-data`；
  - 旧 `app-preferences.json`。
- 迁移只补缺，不覆盖已经产生的新数据。
- API Key 通过受限 IPC 保存到主进程；系统支持时使用 Electron `safeStorage` 加密。
- 凭证文件采用原子写入；POSIX 系统尽量设置为 `0600` 权限。
- 浏览器 `localStorage` 仅作为纯网页模式后备和旧数据迁移来源。
- 模型选择、媒体模型选择和插件开关会跨重启保存。
- 会话保存和删除现在检查 HTTP 状态，失败时不再伪装成成功。

## 3. 其他模型检查结果

| 供应商 | 项目当前处理 | 结论 |
|---|---|---|
| Qwen / DashScope | `qwen3.7-max`、`qwen3.7-plus`、正确快照及多区域回退 | 原项目存在错误模型名和地域单点问题，已修复 |
| Kimi / Moonshot | K3、K2.6、K2.7 Code，官方 OpenAI-compatible 端点 | 原项目逻辑 ID 与真实模型名不一致，且缺少平台 Key 提示，已修复 |
| OpenAI | 保留 `gpt-5.1` | 官方仍列为可用且支持 Chat Completions；不是当前最新系列，但不会因模型 ID 本身必然失效 |
| Gemini | `gemini-3.6-flash` | 保留独立 Gemini SSE 协议；通过真实验证按钮检查账号可用性 |
| DeepSeek | `deepseek-v4-pro`、`deepseek-v4-flash` | 使用官方 Chat Completions 兼容端点；支持 Base URL 覆盖 |
| GLM | 默认 `glm-5.2`，保留 `glm-4.7` 手动选择 | 避免旧模型成为默认；支持官方 BigModel 端点和 Base URL 覆盖 |
| 百炼托管第三方模型 | GLM、Kimi Code、DeepSeek | 不再进入 Auto，只有用户明确选择且账号已开通时才调用 |

说明：没有使用用户现有 API Key 发起外部请求，以避免泄漏凭证或产生费用。修复后的应用可在设置界面逐个执行真实验证。

## 4. 主要修改/新增文件

### 后端

- `backend/services/llm/catalog.py`
- `backend/services/llm/protocols.py`（新增）
- `backend/services/llm/gateway.py`
- `backend/api/models.py`
- `backend/tests/test_smoke.py`

### 前端

- `app/lib/llm/registry/models.ts`
- `app/lib/llm/types.ts`
- `app/lib/local-credentials.ts`（新增）
- `app/hooks/useApiKey.ts`
- `app/hooks/useModelSelection.ts`（新增）
- `app/hooks/usePluginManager.ts`
- `app/hooks/useWorkspaceController.ts`
- `app/components/api-key-modal/llm-provider-settings.tsx`（新增）
- `app/components/api-key-modal/api-key-modal.tsx`
- `app/page.tsx`
- `app/types/electron.d.ts`

### Electron

- `electron/data-paths.ts`（新增）
- `electron/secure-credentials.ts`（新增）
- `electron/app-preferences.ts`
- `electron/backend-process.ts`
- `electron/ipc.ts`
- `electron/main.ts`
- `electron/preload.ts`

## 5. 验证结果

已在当前环境执行：

- 源码规则检查：182+ 个源码文件全部不超过 500 行；Python 函数/方法均有 docstring。
- Python 编译检查：通过。
- 后端测试：9 项全部通过。
- TypeScript/TSX 语法转译检查：109 个文件通过。
- 相对导入路径检查：通过。

当前压缩包没有 `node_modules`，并且执行环境无法访问 npm/pnpm Registry，因此无法在这里完成依赖驱动的完整 `tsc`、Electron 类型检查、Vite Build 和正式 ESLint 命令。新增 TypeScript 代码已按项目现有严格 TypeScript/ESLint 风格编写，并完成无依赖语法转译和导入检查；在可联网开发机上应继续执行：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

## 6. 升级后建议的检查顺序

1. 启动应用，进入 API Key 设置。
2. 重新保存 Kimi Key，并点击 Kimi 行的“验证”。
3. 若提示 401/403，确认 Key 来自 `platform.kimi.com`。
4. 若提示 404，在 Kimi 控制台核对账号可用模型。
5. 点击 Qwen“验证”；若公共区域均失败且使用专属工作空间，在环境文件设置 `DASHSCOPE_BASE_URL`。
6. 新建一条会话并发送消息，完全退出应用后重新打开，确认会话、模型选择和 Key 仍存在。
7. 若旧缓存未迁移，检查固定数据目录及控制台中的“已迁移旧版应用数据”日志。

## 7. 安全说明

交付压缩包不会包含 `.env.local` 明文文件。第二次修订版会包含由构建脚本生成的 Python 内置百炼兜底模块，其内容经过压缩和混淆，但桌面客户端中的共享 Key 仍可能被高级逆向提取。大规模公网分发时建议改为自有服务端代理。


## 8. Python 内置百炼兜底（第二次修订）

- 构建脚本会从 `.env.local` 白名单读取 `DASHSCOPE_API_KEY` 与可选 `DASHSCOPE_BASE_URL`。
- 配置被编码为 `backend/core/_builtin_credentials_generated.py`，并由 PyInstaller 打进后端可执行文件。
- 最终安装包不需要携带 `.env.local`，普通用户不配置也能调用百炼文本、图片和视频模型。
- 优先级固定为：用户设置 Key > 后端环境变量 > Python 内置百炼兜底。
- 用户填写无效 Key 时不会静默使用共享 Key，便于发现配置错误并避免不透明的额度消耗。
- 该方案无法阻止高级逆向提取共享 Key；公网大规模分发时仍建议改为自有服务端代理。

详细构建和轮换方法见 `BUILTIN_BAILIAN_FALLBACK_CN.md`。
