# AGENTS.md — Multi-agent 开发与协作规范

本文件面向：

- 在本仓库中工作的编码 Agent；
- 人类贡献者；
- 自动化代码审查工具；
- 需要新增或修改 Agent 工作流的开发者。

所有修改都应以当前源码为准。先阅读 [AGENT_SOURCE_GUIDE.md](./AGENT_SOURCE_GUIDE.md)，再开始改动。

---

# 1. 项目目标

Multi-agent 是一个本地优先的 Electron AI 工作台，包含四条主要能力链路：

1. QA Agent：通用流式问答与图片理解；
2. Code Agent：本地项目检索、规划、并行修改、合并、验证和审查；
3. Media Agent：图片/视频生成与编辑；
4. Commerce Agent：跨境市场情报研究与报告。

贡献原则：

- 保持工作流隔离；
- 保持本地文件安全；
- 保持 Agent 状态可观测；
- 保持模型 Provider 可替换；
- 保持降级路径可用；
- 不把 UI 动画当作真实后端执行状态。

---

# 2. 项目命名

对外项目名统一使用：

```text
Multi-agent
```

新增文档、页面标题、报告、打包配置时不要继续引入：

```text
Agent Workspace
MyApp
白雪条 Agent Runtime
```

当前旧名称仍存在于部分源码中，重命名时应统一检查：

```text
package.json
package lock name
package.json build.productName / appId
electron-builder.yml
Electron window/title bar text
ChatSidebar.tsx
CustomTitleBar.tsx
Commerce report footer
installer shortcut/artifact names
README and auxiliary documents
```

重命名 App ID 或数据库文件名可能影响升级兼容，不能未经说明直接改变用户数据路径。

---

# 3. 技术栈与边界

## 3.1 核心技术

- Electron 43
- Next.js 16
- React 19
- TypeScript 6
- Tailwind CSS 4
- LangGraph 1.x
- LangChain Core 1.x
- `node:sqlite`
- Sentry

## 3.2 Client / Server 边界

以下内容只能在服务端或 Electron 主进程使用：

- `fs`、`path`、`node:sqlite`；
- API Key 与 Service Credential；
- 本地项目绝对路径；
- 文件修改与终端命令；
- LangGraph Checkpointer；
- Commerce Provider Secret；
- PDF 导出底层能力。

前端组件不得直接 import 服务端模块。

## 3.3 工作流边界

- QA 不得无条件 import Code Agent Graph。
- Media 不得通过 `/api/qa` 或 `/api/chat` 伪装成文本模型调用。
- Commerce 不得把模拟数据当真实市场结论。
- Code Agent 不得在普通 QA 会话中自动读取本地项目。

---

# 4. 主要目录职责

```text
app/api/qa/                    QA API
app/api/chat/                  Code Agent API 与 LangGraph
app/api/media/                 Media API
app/api/commerce/              Commerce API
app/api/workspace/             项目和会话持久化
app/component/                 UI 组件
app/hooks/                     前端状态控制
app/lib/llm/                   LLM Provider、模型路由、Prompt
app/lib/media/                 媒体模型和策略
app/lib/commerce/              数据源、指标、报告
app/lib/server/                Workspace Store 和路径校验
electron/                      Electron 主进程与 preload
scripts/                       构建工具
```

不要把跨层逻辑塞回 `app/page.tsx`。页面入口应以组合 Hooks 和 Components 为主。

---

# 5. Code Agent 的 Agent 清单

后端真实角色：

| Role | 责任 |
|---|---|
| `router` | 请求重置、交互恢复和流程分流 |
| `search_agent` | 项目索引与代码库候选定位 |
| `memory_agent` | 长期摘要与近期对话整理 |
| `file_agent` | 指定文件/目录预读 |
| `context_merge` | 三路上下文合并 |
| `high_level_planner` | 模块级目标和依赖规划 |
| `task_planner` | 文件级叶子任务拆分 |
| `modify_worker` | 隔离执行单个任务并生成文件提案 |
| `merge_agent` | 合并、冲突检测、统一写入、回滚 |
| `verification_agent` | 真实 lint/build/test 或文档落盘验证 |
| `reviewer_agent` | PASS、RETRY、FAIL 决策 |
| `final_report_agent` | 汇总最终交付 |

控制节点包括：

```text
missing_file_guard
simple_edit_planning
context_fanout
enrich_context
planner_schema_validation
file_uniqueness_check
retry_planner
rules_repair
single_agent_degrade
structured_task_list
retry_dispatch
```

控制节点不是都需要模型。能确定性完成的逻辑优先用代码，不要增加无意义 LLM 调用。

---

# 6. Agent 流转协议

## 6.1 主流程

```text
Router
├─ direct answer → End
├─ workspace_info → Workspace Answer → End
├─ read_only → Search + Memory + File → Merge Context → Read-only Answer → End
├─ simple_edit → Missing-file Guard → Deterministic Plan → Worker
└─ code_change → Missing-file Guard → Context Agents → Hierarchical Planner → Workers

Workers → Merge → Verification → Reviewer
Reviewer PASS/FAIL → Final Report
Reviewer RETRY → Retry Dispatcher → Selected Workers → Merge → Verification → Reviewer
```

## 6.2 上下文交接

Search、Memory、File 只能写各自字段：

```text
searchContext
memoryContext
fileContext
```

Context Merge 负责生成 `mergedContext`。不要让其中一个上下文 Agent 直接覆盖其他 Agent 的结果。

## 6.3 Planner 交接

High-level Planner 输出 `HighLevelPlanPayload`。

Task Planner 输出 `PlannerPayload`。

任何新增字段都必须同步更新：

```text
types.ts
state.ts
parser/schema validation
prompt registry
structured summary
final report
frontend types（如果展示）
```

## 6.4 Worker 交接

Worker 只通过以下聚合通道返回：

```text
modifyResults
agentLifecycles
agentLifecycleEvents
tokenUsage
```

禁止向主图 `messages` 写入 Worker 的内部 AI/Tool 消息。

## 6.5 Merge 交接

Worker 的文件结果必须是完整 `WorkerFileChange`，至少包含：

```text
filePath
baseContent
baseContentHash
proposedContent
proposedContentHash
ready
sourceWorkerIds
sourceSlots
mergeStrategy
```

Merge 成功后才更新正式 `touchedFiles`。

## 6.6 Reviewer 交接

Reviewer 必须返回结构化：

```json
{
  "decision": "PASS | RETRY | FAIL",
  "feedback": "...",
  "risks": [],
  "retryTasks": []
}
```

`retryTasks` 是 0-based Worker 槽位，不是任务 ID、文件名或 Agent ID。

---

# 7. 修改文件的强制安全流程

编码 Agent 修改项目文件时必须遵守：

```text
定位文件
→ 读取完整真实内容
→ 生成完整最终内容
→ 查看差异
→ 标记提案 ready
→ Merge 统一落盘
→ 验证
→ Review
```

禁止：

- 根据文件名猜测内容；
- 只读取片段后覆盖完整文件；
- 在 `fileContent` 中写“其余不变”；
- 传入 Markdown 代码围栏作为文件内容；
- Worker 直接 `fs.writeFileSync()` 正式文件；
- 绕过 Merge 修改并发 Worker 文件；
- 未经用户确认创建一个被明确描述为“已有文件”的缺失目标；
- 使用绝对路径或 `../` 越出工作区。

新增文件工具时必须复用或等价实现 `getSafePath()` / Workspace Path 校验。

---

# 8. 并发 Worker 规范

## 8.1 任务边界

Planner 应尽量保证不同 Worker 的 `files` 不重复。

同文件多个提案只应作为异常容错，不应成为常态设计。

## 8.2 隔离

每个 Worker：

- 有独立 runtime messages；
- 有独立 proposals Map；
- 有独立 Worker Memory；
- 只读取 Shared Memory；
- 不读取其他 Worker 的内部消息；
- 不执行终端命令。

## 8.3 上下文压缩

不要移除 Worker Memory 压缩而不提供替代方案。长工具链如果一直保留完整消息，会导致：

- Token 暴涨；
- Provider 上下文限制；
- 返工难以延续；
- 多 Worker 成本失控。

压缩结果必须保留：

```text
已完成动作
待办动作
关键文件
最近观察
当前任务目标
```

## 8.4 Worker 结果

Worker 只有在以下条件之一满足时才能结束为成功：

- 至少一个文件提案已经 ready；
- Reviewer 返工中确认上一轮目标内容仍在，返回 `satisfied`。

模型只说“已完成”但没有提案，不得标记成功。

---

# 9. Merge 规范

Merge 是正式写盘的单一收口点。

任何修改 Merge 的代码都必须保留以下能力：

1. 相同文件路径归一化；
2. 完全相同提案去重；
3. 相同基线的非重叠修改合并；
4. 重叠修改冲突；
5. 基线不同冲突；
6. 正式文件执行期间变化检测；
7. Worker 失败映射到槽位；
8. 多文件写入失败回滚；
9. `alreadyAppliedFiles` 识别；
10. 完整 Merge Summary。

不要为了“提高成功率”直接采用最后写入者覆盖。那会破坏并发安全和用户信任。

新增 Merge Strategy 时同步更新：

```text
WorkerMergeStrategy
WorkerFileChange
MergeResult
Reviewer prompt/context
Final Report
AGENT_SOURCE_GUIDE.md
```

---

# 10. Verification 规范

## 10.1 文档任务

文档任务只检查落盘，不运行全项目构建。不要恢复“所有修改都 pnpm build”的粗暴策略。

## 10.2 JS/TS 任务

优先对 touched files 执行 ESLint，减少无关噪声。

## 10.3 Build/Test

只运行 `package.json` 中真实存在的脚本。

## 10.4 失败处理

Verification 失败不能被 Final Report 隐藏。Reviewer 必须看到结构化失败结果并决定 RETRY 或 FAIL。

## 10.5 命令安全

新增命令前检查：

- 是否破坏性；
- 是否可能删除用户数据；
- 是否需要网络或安装依赖；
- 是否会进入交互模式；
- 超时是否合理；
- 是否能在 Windows/macOS/Linux 工作。

---

# 11. Reviewer 规范

Reviewer 是质量闸门，不是“礼貌性总结”。

它必须基于：

- 用户请求；
- Planner 验收标准；
- Worker 结果；
- Merge 结果；
- 当前文件快照；
- Verification 结果。

Reviewer 不得：

- 在 Merge 冲突时返回虚假 PASS；
- 在没有有效槽位时无限 RETRY；
- 把 Worker 编号和 0-based slot 混淆；
- 隐藏验证失败；
- 只根据 Worker 自述判断成功。

当前最大返工次数为 2。修改该值时要考虑 LangGraph recursion limit、Token 成本和 UI 时间线长度。

---

# 12. Agent Lifecycle 规范

后端 Agent 重要阶段必须上报真实生命周期。

推荐状态顺序：

```text
CREATED
→ PLANNING / EXECUTING
→ WAITING_TOOL（需要时）
→ COMPRESSING（需要时）
→ READY_TO_MERGE（Worker）
→ COMPLETED
```

失败或暂停：

```text
BLOCKED
FAILED
```

事件必须包含清晰 `detail`，但不得包含：

- API Key；
- 完整 Secret；
- 用户私有文件全文；
- 超长模型 Prompt；
- 不必要的绝对路径。

前端展示角色只是聚合映射。不要因为 UI 只有 Coder/Reviewer 等角色，就删除后端更细的 Agent Role。

---

# 13. SSE 协议规范

Code/QA 常见事件：

```text
TEXT
STATUS
TOOL_STATUS
USAGE
INTERACTIVE_REQUEST
AGENT_LIFECYCLE
```

Commerce：

```text
COMMERCE_PROGRESS
COMMERCE_REPORT
AGENT_ERROR
```

修改 SSE 时同步检查：

```text
server types
frontend workspace types
useChatStream
useAgentCoordinator
TaskPlanningPanel
ChatList
```

不要发送循环引用、不可序列化对象或整个 LangGraph State。

---

# 14. LLM Gateway 规范

所有文本模型调用优先通过 `app/lib/llm/gateway.ts`。

新增 Provider 时：

1. 在 Provider Catalog 注册；
2. 增加 Provider 实现或使用 OpenAI-compatible 实现；
3. 注册模型能力；
4. 配置推荐任务；
5. 更新 Credential 解析和 UI Key 管理；
6. 验证流式、非流式、Vision、Tool Call；
7. 验证 fallback 行为。

模型路由必须按能力过滤，不能把：

- 无 Vision 模型分配给图片输入；
- 无 Tool Call 模型分配给 Worker；
- 非 Chat 媒体模型放入普通聊天路由。

流式 fallback 只能在尚未输出正文前切换，避免两个模型的回答拼接。

---

# 15. Prompt 规范

Prompt 统一放在 `app/lib/llm/prompts/registry.ts`，通过 `renderPrompt()` 暴露。

修改 Prompt 时：

- 保持结构化输出格式可解析；
- 不让 Prompt 声称存在未实现工具；
- 明确文件工具闭环；
- 明确 Worker 不可执行终端命令；
- 明确 Reviewer 的 slot 语义；
- 明确 Demo Commerce 不可输出真实商业结论；
- 避免把密钥或绝对路径拼进 Prompt。

如果修改 JSON 输出格式，必须先改类型和解析器，再改 Prompt。

---

# 16. Workspace 与数据库规范

## 16.1 路径

项目创建必须经过：

```text
normalizeAndValidateWorkspacePath
assertExistingWorkspaceDirectory
```

不要信任前端传入的 `workingDir`。

## 16.2 SQLite

Workspace Store 使用 WAL 和外键。数据库结构变更必须：

- 考虑旧数据迁移；
- 在事务中执行；
- 保持失败回滚；
- 不静默丢弃 sessions/messages；
- 更新类型与 map 函数。

## 16.3 索引

新增索引文件类型时考虑：

- 是否为文本；
- 是否可能超大；
- 是否包含敏感生成文件；
- 是否应加入 ignored directories；
- Symbol 提取正则是否支持。

不要把当前 `LIKE` 搜索描述成向量语义搜索。

---

# 17. QA Agent 规范

QA 是核心轻量能力。

- 不依赖 Code Agent 插件开关；
- 不读取本地项目；
- 最新用户消息的附件才作为本轮多模态输入；
- 通过统一 LLM Gateway 流式输出；
- Token 用量通过 `USAGE` 返回；
- 内部 reasoning 标记应由前端正确处理，不直接显示为普通正文。

---

# 18. Media Agent 规范

## 18.1 协议隔离

媒体模型不进入普通 LLM Chat Gateway。

## 18.2 附件校验

保持不同 mode 的 MIME 和大小限制。不要只信任文件扩展名。

## 18.3 精准改图

`precise` 模式必须强调：

- 保留未指定区域；
- 防止重复对象；
- 防止双边缘和重影；
- 防止多余文字；
- 尽量保持构图和长宽比。

## 18.4 质量检查

质量 Guard 是辅助判断，不保证像素级一致。不要在文档中承诺生成模型可以精确替换长文本或完全不重绘。

## 18.5 大文件

视频优先保存远程临时 URL，不要把巨大 Base64 无限制写入 SQLite。

---

# 19. Commerce Agent 规范

## 19.1 数据真实性

每个来源必须返回：

```text
status
provider
quality
sampleSize
coverage
summary
warnings
```

报告必须保留 source list 和 confidence score。

## 19.2 Demo 模式

Demo 数据必须：

- 明确标记；
- 不参与真实商业事实表述；
- 不生成伪造的销量/利润结论；
- 不调用策略 LLM 将模拟数据包装成真实建议。

## 19.3 Provider 失败

单个可选 Provider 失败不应阻断整个报告；所有真实来源不可用时才进入 Demo 或明确失败。

## 19.4 PDF

PDF 导出只在 Electron 主进程执行。Web 环境需要提供可解释的降级行为。

---

# 20. Electron 规范

- 主进程负责启动 Next.js 子进程；
- preload 通过 `contextBridge` 暴露最小 API；
- 不启用宽泛 Node Integration；
- IPC 参数必须验证；
- 主题同步要同时更新网页和原生标题栏；
- 用户数据写入 `app.getPath("userData")` 下；
- 关闭应用时正确终止 Next 子进程；
- 端口处理不能误杀无关用户进程。

打包配置变更时同时检查：

```text
scripts/build-electron.ts
electron-builder.yml
forge.config.ts
package.json
electron/main.ts
```

---

# 21. TypeScript 编码规范

- 开启并遵守 `strict`；
- 避免无理由 `any`；
- 外部 JSON 使用 `unknown` 后再校验；
- 状态枚举使用联合类型；
- 新增返回结构先定义 interface/type；
- 保持 Server-only 类型与前端展示类型分离；
- 对可恢复错误返回结构化状态；
- 对不可恢复边界错误抛出明确 Error；
- 不吞掉异常后伪装成功。

导入路径优先使用 `@/`，同目录紧密模块可以使用相对路径。

---

# 22. React 与 Hook 规范

- 页面组件只做组合，不堆积工作流实现；
- 一个 Hook 对应一个主要职责；
- 状态更新使用不可变方式；
- 大型插件 UI 使用动态 import，避免增加 QA 首屏负担；
- SSE 解析与 UI 渲染分离；
- 不根据文案猜测真实后端状态，优先使用生命周期事件；
- 对旧事件保持兼容时明确标注兼容层。

---

# 23. 样式与交互规范

当前 UI 采用轻量 Apple 风格玻璃卡片体系。

保持：

- 统一圆角、边框和背景变量；
- 深浅主题变量；
- Agent 状态色语义一致；
- 长内容可滚动；
- 流式期间不阻塞输入区；
- 交互式请求明确展示命令、选项和风险；
- 移动/小窗口宽度下不溢出。

不要用纯动画模拟 Agent 完成；动画必须由真实状态驱动。

---

# 24. 新增 Agent 的标准流程

假设要新增 `security_agent`：

1. 在 `AgentRole` 中增加角色；
2. 定义输入、输出和 State 字段；
3. 确定是否为模型节点或确定性节点；
4. 实现 Lifecycle Tracker；
5. 在 `graph.ts` 注册 Node 和边；
6. 明确它能读取/写入哪些 State 字段；
7. 定义上游和下游；
8. 增加失败与降级路径；
9. 映射前端 Agent 展示角色；
10. 增加 SSE 类型或复用 `AGENT_LIFECYCLE`；
11. 更新 Prompt、文档和测试；
12. 验证 checkpoint 兼容。

新增 Agent 前先判断是否真的需要独立 Agent。纯 Schema 校验、路径检查、格式化、去重等确定性逻辑通常应保持普通节点。

---

# 25. 修改代码的标准工作流

1. 明确请求属于 QA、Code、Media、Commerce、Workspace 或 Electron。
2. 阅读最小必要文件，不从文件名猜实现。
3. 搜索相关类型、调用方和 UI 消费方。
4. 设计变更边界，避免跨工作流耦合。
5. 修改类型和核心逻辑。
6. 更新调用方、事件、Prompt 和文档。
7. 运行最小相关检查。
8. 再运行项目级 lint/build（文档任务除外）。
9. 检查是否泄露 Secret、绝对路径或用户数据。
10. 在交付中说明变更文件、验证结果和已知风险。

---

# 26. 验证命令

安装：

```bash
pnpm install
```

Lint：

```bash
pnpm lint
```

Next.js Build：

```bash
pnpm build
```

Electron 编译：

```bash
pnpm electron:compile
```

Electron 开发：

```bash
pnpm electron:dev
```

Electron 打包：

```bash
pnpm electron:package
pnpm electron:make
```

测试脚本目前只有在 `package.json` 实际提供时才能运行。不要在报告中虚构 `pnpm test` 已通过。

---

# 27. 文档修改规范

README 和 Agent 文档必须：

- 项目名使用 Multi-agent；
- 英文 README 顶部链接中文 README；
- 中文 README 顶部链接英文 README；
- 截图板块可以预留，但不要引用不存在的图片；
- 只描述源码中真实实现；
- 不把 LIKE 搜索写成向量数据库；
- 不把 UI Agent 数量写成后端固定 Worker 数量；
- 不承诺模型可以像素级精准改图；
- 不把可选 Commerce Provider 写成必需；
- 不泄露真实环境变量值。

---

# 28. 禁止事项

严禁：

- 提交 `.env.local` 或真实密钥；
- 将 API Key 写入 Graph State、SQLite Message、SSE 或日志；
- Worker 绕过 Merge 写正式文件；
- 关闭路径越界检查；
- 允许未确认的破坏性终端命令；
- 在 Merge 冲突时仍返回成功；
- 在 Verification 失败时隐藏失败；
- 将 Demo Commerce 数据描述为真实市场数据；
- 将视频 Base64 无限制写入会话数据库；
- 在 QA 首屏同步 import 全部插件实现；
- 因为旧文档存在就继续复制错误架构；
- 声称运行了实际没有运行的命令或测试。

---

# 29. 完成标准

一个代码任务只有在以下条件满足时才算完成：

- 实现符合用户需求；
- 修改范围可解释；
- 类型检查与调用链一致；
- Agent 上下游交接没有断裂；
- 文件写入仍经过安全收口；
- 生命周期和 UI 状态能正确反映执行；
- 相关 lint/build/test 或专用验证已执行；
- 失败项和未验证项被明确说明；
- README/Agent 文档在架构变更后同步更新；
- 没有 Secret、绝对路径或私有数据泄露。

---

# 30. 提交前检查清单

```text
[ ] 项目名是否统一为 Multi-agent（新增内容）
[ ] 是否读过实际调用方，而不只改单个文件
[ ] 是否保持 QA / Code / Media / Commerce 隔离
[ ] 是否更新类型、State 和 Reducer
[ ] 是否保持 Worker 消息隔离
[ ] 是否保持 Worker 不直接写正式文件
[ ] 是否处理缺失文件确认
[ ] 是否处理 Merge 冲突与回滚
[ ] 是否处理 Verification 失败
[ ] 是否限制 Reviewer 返工
[ ] 是否更新 SSE 与前端消费类型
[ ] 是否没有泄露 API Key
[ ] 是否没有虚构测试结果
[ ] 是否更新相关文档
```
