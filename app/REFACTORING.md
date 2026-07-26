# App 目录重构说明

## 重构目标

- 所有 TypeScript、TSX 与 CSS 文件均不超过 500 行。
- 使用语义化目录、文件名和方法名，减少缩写与职责混杂。
- 保留原模块公共导出，降低调用方迁移成本。
- 为关键模块补充中文职责注释和复杂逻辑说明。
- 统一使用 TypeScript 常见 ESLint 风格：双引号、分号、尾随逗号、显式返回类型与 `import type`。

## 目录调整

| 原目录 | 新目录 | 说明 |
| --- | --- | --- |
| `component` | `components` | 使用复数形式表示组件集合 |
| `const` | `constants` | 避免关键字缩写，明确常量职责 |
| `utils` | `utilities` | 使用完整语义，集中通用工具 |

## 重点拆分

- `api/chat/agent/workflow-nodes.ts`：拆分为生命周期、终端与记忆、规划解析、文件工具、工具执行、上下文节点、修改节点、合并策略、风险审批、审查、验证和报告等模块。
- `lib/commerce/providers/*-public-page.ts`：拆分为页面解析、网络请求、详情补全和 Provider 实现。
- `lib/mcp/client.ts`：拆分为配置、协议、Schema 校验和工具执行。
- `lib/media/dashscope.ts`：拆分为图片、上传和视频任务模块。
- 大型 React 组件：将配置、展示子组件和主组件分离。
- `useAgentCoordinator`：按通用任务、媒体任务和跨境研究任务拆分为独立业务动作 Hook。

## 兼容策略

大型模块的原文件保留为兼容入口，通过重新导出连接内部实现，因此外部模块无需立即修改导入路径。目录重命名涉及的项目内导入路径已统一更新。

## 语义化方法示例

- `openDB` → `openChatDatabase`
- `getAllSessions` → `listStoredSessions`
- `saveSessionToDB` → `saveChatSession`
- `getCurrentTime` → `getCurrentDateTime`
- `createSessionId` → `createChatSessionId`
- `parseSelectedFile` → `parseUserSelectedFile`

旧方法名暂时保留为兼容别名，并标记为弃用，便于渐进迁移。

## 已执行检查

- TypeScript/TSX 语法解析检查。
- 项目内相对路径与 `@/app` 路径解析检查。
- 拆分前后公共导出一致性检查。
- 单文件行数上限检查。
- 重构前后 TypeScript 非依赖类诊断对比；未新增项目内部类型错误。

完整构建与正式 ESLint 检查仍需在包含项目根目录 `package.json`、锁文件、`tsconfig.json` 和依赖的环境中执行。
