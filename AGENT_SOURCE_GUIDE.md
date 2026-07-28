# Multi-agent 多 Agent 源码导读

本文档是一份基于当前源码整理的中文实现指南，重点解释：

1. 项目里到底有哪些 Agent；
2. 一次请求会经过哪些节点；
3. Agent 之间通过什么状态交接；
4. 并行 Worker 如何避免互相污染；
5. 文件为什么不会被 Worker 直接覆盖；
6. Merge、Verification、Reviewer 如何形成质量闭环；
7. QA、Media、Commerce 与 Code Agent 为什么要分开。

建议先阅读本文，再结合 [AGENTS.md](./AGENTS.md) 修改代码。

---

## 1. 先建立全局认知

Multi-agent 不是“一张大图处理全部能力”，而是四条相互隔离的主工作流：

```text
QA            → /api/qa                 → LLM Gateway
Code Agent    → /api/chat               → LangGraph
Media Agent   → /api/media/generate     → DashScope Media
Commerce      → /api/commerce/research  → Data-source Orchestrator + LLM
```

这种拆分解决了三个问题：

- 文本流式协议、视频异步轮询和多 Agent checkpoint 不互相污染；
- 普通 QA 首屏不需要同步加载 Code/Commerce 的重型逻辑；
- 每个工作流可以使用不同的模型能力、错误处理和持久化结构。

---

## 2. 推荐阅读顺序

### 第一组：Code Agent 主干

1. `app/api/chat/route.ts`
2. `app/api/chat/server/run-agent-graph.ts`
3. `app/api/chat/agent/graph.ts`
4. `app/api/chat/agent/types.ts`
5. `app/api/chat/agent/state.ts`
6. `app/api/chat/agent/request-classifier.ts`
7. `app/api/chat/agent/request-routing-nodes.ts`
8. `app/api/chat/agent/workflow-nodes.ts`
9. `app/api/chat/tools.ts`
10. `app/api/chat/agent/checkpointer.ts`

### 第二组：前端状态与交互

1. `app/hooks/useChatStream.ts`
2. `app/hooks/useAgentCoordinator.ts`
3. `app/component/TaskPlanningPanel.tsx`
4. `app/component/AgentPanel.tsx`
5. `app/component/InteractiveRequestPanel.tsx`
6. `app/api/chat/server/graph-status.ts`

### 第三组：模型层

1. `app/lib/llm/gateway.ts`
2. `app/lib/llm/router/model-router.ts`
3. `app/lib/llm/registry/providers.ts`
4. `app/lib/llm/registry/models.ts`
5. `app/lib/llm/normalizers.ts`
6. `app/lib/llm/prompts/registry.ts`

### 第四组：其他工作流

- QA：`app/api/qa/route.ts`
- Media：`app/api/media/generate/route.ts`、`app/lib/media/`
- Commerce：`app/api/commerce/research/route.ts`、`app/lib/commerce/`
- Workspace：`app/lib/server/workspace-store.ts`
- Electron：`electron/main.ts`、`electron/preload.ts`

---

## 3. Code Agent 的 API 入口

### `app/api/chat/route.ts`

这个文件负责 HTTP 边界，不负责实现具体 Agent 节点。

主要步骤：

1. 从请求头解析 LLM 凭证与首选模型；
2. 解析前端消息和图片附件；
3. 将消息转换为 LangChain `HumanMessage`、`AIMessage`、`SystemMessage`；
4. 通过 `resolveChatWorkspace()` 校验项目 ID 和工作目录；
5. 创建 SSE Stream；
6. 调用 `runAgentGraph()`；
7. 根据最终状态处理三种结果：
   - 存在 `interactiveRequest`：暂停并发回交前端；
   - 存在 `directAnswer`：直接输出；
   - 完整图结束：调用 `streamFinalAnswer()` 整理最终回答。

Route 的重要边界：

- 不在这里写 Planner 逻辑；
- 不在这里直接改文件；
- 不把凭证放进 Graph State；
- 不允许工作区无效时静默降级到任意目录。

---

## 4. Graph 是如何被运行的

### `app/api/chat/server/run-agent-graph.ts`

这个文件负责把 LangGraph 与 SSE 连接起来。

关键行为：

- 使用 `sessionId` 作为 LangGraph `thread_id`；
- 先读取旧 checkpoint；
- 旧线程只补最近两条输入消息，避免每轮重复写入完整历史；
- `streamMode` 同时开启：
  - `updates`：节点状态更新；
  - `custom`：自定义 Agent 生命周期事件；
- `recursionLimit` 为 80，用于允许 Planner 重试和 Reviewer 返工回环；
- 完成后再次读取最终 checkpoint，作为 Route 的最终状态。

凭证通过 `runWithLlmCredentials()` 放入 AsyncLocalStorage。这样：

```text
请求凭证
  └─ 当前异步请求上下文
      ├─ Planner 调用
      ├─ Worker 调用
      ├─ Reviewer 调用
      └─ Final Report 调用
```

但凭证不会进入：

```text
AgentState
LangGraph checkpoint
SSE payload
数据库会话内容
```

---

## 5. 请求分类：先决定要不要启动重型工作流

### `app/api/chat/agent/request-classifier.ts`

系统使用确定性规则将请求分成四类。

### 5.1 `workspace_info`

只询问当前项目、根目录、文件夹名称或绑定信息，并且不询问项目内容。

示例：

```text
当前绑定的是哪个项目？
项目根目录是什么？
```

结果：本地直接回答，不调用模型和 Planner。

### 5.2 `read_only`

需要分析项目内容，但没有修改意图。

示例：

```text
解释这套 Agent 的流转方式。
搜索项目里和 interactiveRequest 有关的实现。
```

结果：Search、Memory、File 并行收集上下文，再由只读模型回答。

### 5.3 `simple_edit`

请求包含修改意图，并且只点名一个文档文件：

```text
.md .mdx .txt .rst .adoc
```

示例：

```text
重写 README.md，加入架构说明。
```

结果：跳过三路上下文 Agent 和两层 Planner，直接生成一个确定性任务。

### 5.4 `code_change`

其他需要修改的复杂任务。

示例：

```text
重构 Code Agent 的合并策略并补充测试。
```

结果：进入完整多 Agent 工作流。

---

## 6. Request Router 不只是分类器

### `requestRouterNode()`

Router 是每轮图执行的重置入口。

它会清空：

- 上一轮的 Planner 输出；
- Worker 结果；
- Merge 结果；
- Review 状态；
- Verification；
- Agent 生命周期；
- 临时文件创建授权。

它还负责恢复缺失文件确认回复。

前端提交确认时，会发送类似：

```text
[INTERACTIVE_REPLY] id=... mode=user answer=create
```

Router 不会把这段内部协议当成新的用户开发需求，而是：

1. 找回原始用户请求；
2. 判断用户是否允许创建文件；
3. 将文件加入 `approvedMissingFiles`；
4. 用原始请求重新开始本轮图。

如果用户取消，则生成 `directAnswer` 并结束，不修改项目。

---

## 7. Missing-file Guard

### `missingFileGuardNode()`

Guard 只检查“用户明确认为应当存在”的修改目标文件。

它不会把所有提到的文件都当成修改目标。例如：

```text
参考 package.json 修改 README.md
```

应当只检查 `README.md`，而不是要求确认创建 `package.json`。

Guard 的处理：

```text
文件存在           → 继续
用户已批准创建     → 继续
文件缺失且未批准   → 生成 file_create_confirmation，暂停图
非法/越界路径      → 不在 Guard 中写入，后续工具仍会做安全校验
```

授权只保存当前任务，防止用户在任务 A 允许创建文件后，任务 B 自动继承授权。

---

## 8. Read-only 的三路上下文 Agent

复杂修改和只读分析都会经过上下文收集。`context_fanout` 本身不做业务，只作为稳定的并行分发点。

### 8.1 Search Agent

实现：`searchAgentNode()`

职责：广度定位。

同时使用：

- `searchProjectIndex(projectId, query)`：查询 SQLite 内容索引；
- `searchCodebase()`：扫描磁盘代码库中的关键字。

输出写入 `searchContext`。

注意：索引结果只是候选，真正修改前仍必须读取磁盘文件，因为索引可能过期。

### 8.2 Memory Agent

实现：`memoryAgentNode()`

职责：整理：

- `state.summary` 中的长期摘要；
- 最近 8 条会话消息。

输出写入 `memoryContext`。

### 8.3 File Agent

实现：`fileAgentNode()`

职责：

- 从用户请求提取最多 5 个候选路径；
- 目录返回直接子项；
- 文件返回前 120 行预览；
- 没有明确路径时返回项目根目录概览。

输出写入 `fileContext`。

### 8.4 Context Merge

实现：`mergeContextNode()`

将三路结果组合为：

```text
用户请求
SearchAgent 结果
MemoryAgent 结果
FileAgent 结果
```

随后 `enrichContextNode()` 再加入当前项目 ID、文件夹名、根路径和路径有效性。

---

## 9. Hierarchical Planner：为什么要两层

复杂代码任务先做模块级规划，再做文件级任务拆分。

### 9.1 High-level Planner

实现：`highLevelPlanningAgentNode()`

输出结构 `HighLevelPlanItem[]`：

```ts
interface HighLevelPlanItem {
  id: string;
  objective: string;
  scope: string[];
  rationale: string;
  dependencies: string[];
  priority: "high" | "medium" | "low";
}
```

它只回答：

- 有哪些模块级目标；
- 每个目标覆盖什么范围；
- 目标之间有什么依赖；
- 为什么这样拆。

如果解析失败，会生成一个保守 fallback 工作项，保证第二层仍有输入。

### 9.2 Task Planner

实现：`planningAgentNode()`

输出结构 `PlanTask[]`：

```ts
interface PlanTask {
  id: string;
  parentId: string;
  task: string;
  files: string[];
  reason: string;
  acceptanceCriteria: string[];
  priority: "high" | "medium" | "low";
}
```

第二层的目标是得到可以安全并发的叶子任务。

---

## 10. Planner 的校验、重试、修复和降级

### 10.1 Schema Validation

`plannerSchemaValidationNode()` 会：

- 从模型文本中提取 JSON 数组；
- 验证每个字段；
- 验证任务是否引用合法 High-level Plan；
- 生成规范化 `plannerOutput`；
- 设置 `requiresChanges`。

失败状态为 `schema_invalid`。

### 10.2 File Uniqueness Check

`fileUniquenessCheckNode()` 阻止两个并行任务声明同一个文件。

原因是：并行任务如果一开始就共享目标文件，通常说明任务拆分边界不清晰。

### 10.3 Retry Planner

如果 Schema 或文件唯一性失败，最多先让 Planner 重新生成。

`retryPlannerNode()` 只更新：

- `plannerRetryCount`；
- `plannerRetryReason`。

真正重新生成仍由 `planningAgentNode()` 完成。

### 10.4 Rules Repair

模型多次失败后，`rulesRepairNode()` 在程序层做任务规范化和去重。

### 10.5 Single-agent Degrade

规则修复仍不稳定时，`singleAgentDegradeNode()` 将任务合并为单 Worker 串行执行。

降级的目标不是保持最大并发，而是保证安全和可继续执行。

---

## 11. Structured Task List

`structuredTaskListNode()` 不创建新任务，它把结构化计划整理成一份可读摘要，包括：

- Planner 状态；
- 校验说明；
- 重试次数；
- High-level Plan JSON；
- 叶子任务 JSON；
- 人类可读任务列表。

这份内容会进入 Shared Worker Memory 和 Final Report。

---

## 12. Dynamic Send Worker

### 12.1 如何创建 Worker

`graph.ts` 中的 `dispatchInitialWorkers()` 会遍历 `plannerOutput`：

```ts
state.plannerOutput.map((task, slot) =>
  new Send("modify_worker", buildWorkerInput(state, task, slot)),
)
```

因此 Worker 数量由 Planner 任务数量动态决定，不是固定 A/B/C 三个 Worker。

### 12.2 Worker 输入

`ModifyWorkerInput` 主要字段：

```text
workerId
slot
task
sharedMemory
previousMemory
previousResult
requestMode
approvedMissingFiles
model
workingDir
projectId
reviewFeedback
reviewIteration
interactiveRequest
```

### 12.3 Shared Memory 与 Worker Memory

`SharedWorkerMemory` 是所有 Worker 可读但不可修改的主图信息：

- 最新用户请求；
- 长期摘要；
- 合并上下文；
- Structured Task List 摘要；
- High-level Plan 摘要。

`WorkerMemory` 只属于一个 Worker 槽位：

- `summary`；
- `completedActions`；
- `pendingActions`；
- `keyFiles`；
- `recentObservations`；
- 压缩次数与最后压缩轮次。

当工具轮次达到 3 的倍数，或 Worker 上下文超过约 14,000 字符时，会尝试压缩 Worker Memory。压缩后只保留续跑所需信息，不影响其他 Worker。

### 12.4 最大工具轮次

- `simple_edit`：最多 5 轮；
- 普通 Worker：最多 10 轮。

达到上限仍无法稳定完成时，Worker 返回 `failed`。

---

## 13. Worker 可以调用哪些工具

工具定义位于 `app/api/chat/tools.ts`。

### `search_project_index`

查询已经建立的 SQLite 项目索引。只能用于定位候选文件，不能替代真实磁盘读取。

### `list_directory`

列出指定目录的直接子项，最多 40 个，不递归。

### `search_codebase`

递归搜索指定关键字，扫描有限文本后缀，跳过 `.git`、`node_modules`、`.next`、`dist`、`build`、`out`，最多返回 20 个文件路径。

### `read_file_from_disk`

完整读取一个 UTF-8 文本文件。修改现有文件前必须调用。

### `propose_file_change`

提交一个文件的完整最终内容。

并发 Worker 模式下，它写入 Worker 的内存提案 Map，而不是正式文件。

### `get_diff`

查看正式文件与提案之间的简化逐行差异。

### `apply_file_change`

并发模式下只把提案标记为 `ready`，等待 Merge。

### `run_terminal_command`

普通串行工具支持命令执行和持久 PTY 交互。但在并发 Modify Worker 阶段被禁用，避免多个 Worker 同时改变工程环境。统一验证在 Merge 后执行。

### `get_local_time`

返回按 `Asia/Shanghai` 格式化的服务端当前时间，不代表用户设备时区。

---

## 14. Worker 的结果状态

`ModifyTaskResult.status` 可能是：

| 状态 | 含义 |
|---|---|
| `pending` | 尚未完成 |
| `done` | 已生成完整、ready 的文件提案 |
| `satisfied` | 返工时确认上一轮目标已经满足，无需重复修改 |
| `skipped` | 当前任务被跳过 |
| `blocked` | 等待交互式终端输入 |
| `failed` | 没有安全可合并的结果 |

没有提案且不是 `satisfied` 时，Worker 不会被当作成功。

---

## 15. Merge Agent 的真实行为

### `mergePatchNode()`

Merge Agent 是唯一统一写入正式工作区的节点。

处理过程：

```text
收集全部 ready 文件提案
  ↓
按文件路径分组
  ↓
处理相同文件的多个提案
  ↓
检查正式文件是否在 Worker 执行期间变化
  ↓
检测 Worker 失败与冲突
  ↓
统一写入
  ↓
写入失败则回滚
```

### 15.1 相同提案去重

多个 Worker 对同一文件给出相同 `proposedContentHash` 时，只保留一份，并标记：

```text
mergeStrategy = identical_deduplicated
```

### 15.2 三方合并

如果多个提案：

- 基于相同 `baseContentHash`；
- 修改的是不重叠的连续行区间；

系统会尝试生成一个合并后的完整内容，并标记：

```text
mergeStrategy = three_way_disjoint
```

### 15.3 Workspace Changed

Merge 会重新读取正式文件并计算 Hash。

```text
当前 Hash == 提案目标 Hash  → alreadyApplied
当前 Hash == Worker 基线 Hash → 可以写入
其他情况                     → workspace_changed 冲突
```

这样可以避免覆盖 Worker 执行期间由用户或其他进程产生的新修改。

### 15.4 写入回滚

写入前会记录：

- 文件是否原本存在；
- 原始内容；
- 安全绝对路径。

如果中途写入失败，会反向恢复已写文件；新建文件则尝试删除。

### 15.5 Merge 状态

```text
pending
success
conflict
blocked
failed
```

`conflict` 或 `failed` 时 Verification 不会在不确定工作区上继续运行。

---

## 16. Verification Agent

### `lintBuildTestNode()`

Verification 是真实命令校验，不是模型主观判断。

### 16.1 Document Profile

如果 touched files 全是：

```text
.md .mdx .txt .rst .adoc
```

只检查文件是否存在，不运行 lint/build/test。

这避免项目原有构建错误让 README 修改被误判失败。

### 16.2 Targeted Profile

如果 touched files 全是：

```text
.ts .tsx .js .jsx
```

会对变更文件运行 ESLint，并运行 `package.json` 中存在的 build/test 脚本。

### 16.3 Full Profile

混合文件或其他类型使用 full profile，运行可用工程脚本。

### 16.4 包管理器识别

优先级：

```text
pnpm-lock.yaml → pnpm
bun.lock/bun.lockb → bun
yarn.lock → yarn
其他 → npm
```

---

## 17. Reviewer Agent 与定向返工

### `reviewerAgentNode()`

Reviewer 输入包括：

- 用户请求；
- High-level Plan；
- Planner 任务；
- Worker 结果；
- Merge Summary；
- Verification Result；
- 当前 Review 轮次；
- 当前文件快照。

输出：

```ts
interface ReviewPayload {
  decision: "PASS" | "RETRY" | "FAIL";
  feedback: string;
  risks: string[];
  retryTasks: number[];
}
```

### PASS

进入 Final Report。

### FAIL

不再自动修改，进入 Final Report，明确报告失败和风险。

### RETRY

`retryTasks` 是 Worker 槽位编号。`retryDispatchNode()` 将槽位写入 `retryTaskSlots`，`dispatchRetryWorkers()` 只为这些槽位创建新的 `Send`。

返工 Worker 会继承：

- 上一轮 Worker Memory；
- 上一轮同槽位结果；
- Reviewer feedback；
- 当前 review iteration。

当前最多两轮返工。超过后自动流程不会继续无限循环。

---

## 18. Final Report Agent

### `finalReportNode()`

Final Report 会汇总：

- 原始用户请求；
- High-level Plan；
- Planner 任务；
- Structured Task List；
- Worker 结果；
- Merge 结果；
- Reviewer 结果；
- Agent 生命周期；
- 挂起交互；
- Verification；
- 校验输出。

生成 `finalReportSummary`，并通过 `appendSummary()` 写回长期摘要。

随后 Route 的 `streamFinalAnswer()` 会将最终结果继续组织成用户可读回答。

---

## 19. Agent Lifecycle

后端生命周期角色：

```text
router
search_agent
memory_agent
file_agent
context_merge
high_level_planner
task_planner
modify_worker
merge_agent
reviewer_agent
verification_agent
final_report_agent
```

状态：

```text
CREATED
PLANNING
EXECUTING
WAITING_TOOL
COMPRESSING
READY_TO_MERGE
MERGING
REVIEWING
VERIFYING
BLOCKED
COMPLETED
FAILED
```

每个事件包含：

- `agentId`；
- `role`；
- `status`；
- `previousStatus`；
- `slot`；
- `iteration`；
- `sequence`；
- `detail`；
- `toolName`；
- `createdAt`。

`AgentState` 同时保存：

- `agentLifecycles`：最新快照，适合 UI 快速展示；
- `agentLifecycleEvents`：完整时间线，适合审计。

`run-agent-graph.ts` 将 custom stream 中的生命周期事件转换成 `AGENT_LIFECYCLE` 和可读 `STATUS` SSE。

---

## 20. State 设计

### 主图 State

`AgentState` 保存：

- 主线程消息；
- 当前请求与请求模式；
- 三路上下文与 merged context；
- 两层 Planner；
- Worker 聚合结果；
- Merge、Verification、Review、Final Report；
- 交互请求与文件创建授权；
- Agent 生命周期；
- 工作区、项目 ID 和 Token 用量。

### Reducer 设计

并行字段不能简单覆盖：

- `modifyResults` 按 `slot` 合并；
- `agentLifecycles` 按更新时间选择较新快照；
- `agentLifecycleEvents` 按事件 ID 去重并按时间排序；
- `tokenUsage` 累加。

### Worker State

`ModifyWorkerState` 没有主线程 `messages`，只包含该 Worker 的隔离输入与输出通道。

这是避免跨 Worker ToolMessage 污染的关键。

---

## 21. Checkpointer 与持久化

### LangGraph Checkpoint

`app/api/chat/agent/checkpointer.ts` 使用自定义 `NodeSqliteSaver`，数据库：

```text
AGENT_DATA_DIR/langgraph-checkpoints.sqlite
```

保存：

- checkpoint；
- metadata；
- parent checkpoint；
- pending writes；
- pending sends。

### Workspace 数据库

`app/lib/server/workspace-store.ts` 使用：

```text
AGENT_DATA_DIR/agent-workspace.sqlite
```

主要表：

```text
projects
sessions
project_memory
file_index
symbol_index
code_content
```

开启：

```text
PRAGMA journal_mode = WAL
PRAGMA foreign_keys = ON
```

### 项目索引

索引规则：

- 跳过 `.git`、`.next`、`node_modules`、`dist`、`build`、`out`、`coverage` 等；
- 最多 6,000 个文件；
- 单文件最大 512 KiB；
- 支持常见 JS/TS、JSON、CSS、HTML、Markdown、YAML、SQL、Python、Go、Java、Rust、Vue 等；
- 提取简单的 function/class/interface/type/enum/const 符号。

当前内容搜索使用可移植的 `LIKE` 查询，而不是依赖 FTS5。

---

## 22. QA Agent 源码流转

### `app/api/qa/route.ts`

流程：

```text
前端消息 + 最新用户图片附件
  ↓
构造 Provider 无关 LlmMessage
  ↓
streamWithLlm(task = chat)
  ↓
模型路由与 Provider fallback
  ↓
TEXT / USAGE SSE
```

QA 不使用 Code Graph，也不读取本地项目。

---

## 23. Media Agent 源码流转

### 入口

`app/api/media/generate/route.ts`

负责：

- 校验 mode、modelId、prompt；
- 归一化附件；
- 校验图片/视频 MIME；
- 校验大小：
  - 图片编辑 10 MiB；
  - 图生视频/参考图生视频 20 MiB；
  - 视频编辑 100 MiB；
- 读取 Qwen 凭证；
- 调用 `generateMedia()`。

### 模型注册表

`app/lib/media/catalog.ts` 将 UI Model ID 映射为：

- Provider；
- 真实模型 ID；
- 支持 modes；
- 输出类型；
- 协议。

图片同步协议和视频异步协议分开处理。

### 图片编辑保护

`app/lib/media/edit-policy.ts` 会根据用户 Prompt 推断：

- 文字修改；
- 局部编辑；
- 背景编辑；
- 风格迁移；
- 结构化图片。

再根据 fidelity 和 typography policy 生成保留规则、负向要求和文字约束。

`app/lib/media/edit-quality.ts` 可以使用视觉模型判断结果是否：

- 保留主体；
- 出现重复或重影；
- 误改未要求区域；
- 文字严重异常；
- 值得自动重试。

---

## 24. Commerce Agent 源码流转

### `app/api/commerce/research/route.ts`

大致阶段：

```text
intent/category
  ↓
collect
  ↓
normalize
  ↓
analyze
  ↓
strategy
  ↓
report
```

### 数据源编排

`collectMultiSourceMarketData()`：

- 并行尝试可用 Provider；
- 为每个来源生成状态、质量、样本量、覆盖范围和警告；
- 合并商品信号；
- 合并观察结果；
- 根据真实来源可用程度决定运行模式。

### Demo 防误用

Demo 模式：

- 使用明确标记的模拟样本；
- 不运行月销量等启发式真实估算；
- 不调用 LLM 生成真实商业策略；
- 报告明确声明不能作为商业决策事实。

### 报告

最终发送：

- `COMMERCE_REPORT`：结构化对象；
- `TEXT`：人类可读报告；
- `COMMERCE_PROGRESS`：阶段进度；
- `USAGE`：LLM Token。

Electron preload 暴露 `exportCommerceReportPdf()`，主进程将 HTML 打印为 PDF。

---

## 25. 前端如何展示多个 Agent

### `useAgentCoordinator.ts`

它接收：

- LangGraph `AGENT_LIFECYCLE`；
- 工具状态；
- Commerce progress；
- Media workflow state；
- 旧版 `AGENT_*` 事件。

后端角色会映射为前端角色，例如：

```text
search_agent / memory_agent / file_agent → researcher
high_level_planner / task_planner         → planner
modify_worker                             → coder
merge_agent / final_report_agent          → orchestrator
reviewer_agent                            → reviewer
verification_agent                        → terminal
```

前端面板是聚合视图，不代表后端只存在这些固定 Agent。

### `TaskPlanningPanel.tsx`

根据 workflow mode 展示：

- Code 规划阶段；
- QA 流式阶段；
- Commerce 阶段；
- Agent 状态；
- 工具活动；
- 生命周期事件；
- 交互请求。

---

## 26. 插件系统

内置插件注册表：`app/lib/plugins/registry.ts`

当前插件：

```text
code-agent
commerce-research
```

QA 是核心能力，不进入插件系统。

插件注册表只保存轻量元数据，不 import Agent 实现，避免核心首屏同步打包重型代码。

---

## 27. 修改不同功能时应从哪里下手

### 修改请求分类

```text
app/api/chat/agent/request-classifier.ts
app/api/chat/agent/request-routing-nodes.ts
app/api/chat/agent/graph.ts
```

### 修改 Planner 输出格式

```text
app/api/chat/agent/types.ts
app/api/chat/agent/workflow-nodes.ts
app/lib/llm/prompts/registry.ts
app/api/chat/agent/state.ts
```

### 修改 Worker 工具

```text
app/api/chat/tools.ts
app/api/chat/agent/workflow-nodes.ts
```

同时检查：

- 工具定义与执行器是否一致；
- 路径安全；
- 并行模式是否允许；
- Tool Status 是否能在 UI 展示。

### 修改 Merge 算法

```text
resolveSameFileGroups()
tryThreeWayMergeChanges()
detectWorkspaceConflicts()
applyMergedChanges()
mergeParallelWorkerResults()
```

都在 `workflow-nodes.ts`。

### 修改 Reviewer 返工

```text
reviewerAgentNode()
retryDispatchNode()
dispatchRetryWorkers()
MAX_REVIEW_RETRIES
```

### 修改验证策略

```text
resolveVerificationProfile()
detectProjectPackageManager()
lintBuildTestNode()
```

### 修改生命周期展示

后端：

```text
workflow-nodes.ts
run-agent-graph.ts
graph-status.ts
```

前端：

```text
useAgentCoordinator.ts
useChatStream.ts
AgentPanel.tsx
TaskPlanningPanel.tsx
```

### 修改 LLM Provider

```text
app/lib/llm/registry/providers.ts
app/lib/llm/registry/models.ts
app/lib/llm/provider-factory.ts
app/lib/llm/providers/
app/lib/llm/router/
```

### 修改 Media

```text
app/lib/media/catalog.ts
app/lib/media/dashscope.ts
app/lib/media/edit-policy.ts
app/lib/media/edit-quality.ts
app/api/media/generate/route.ts
```

### 修改 Commerce

```text
app/api/commerce/research/route.ts
app/lib/commerce/orchestrator/
app/lib/commerce/providers/
app/lib/commerce/analytics.ts
app/lib/commerce/types.ts
```

---

## 28. 当前源码中需要特别注意的事实

1. `workflow-nodes.ts` 仍保留一个旧 `routerNode()` 导出，但当前 `graph.ts` 实际使用的是 `request-routing-nodes.ts` 中的 `requestRouterNode()`。
2. `app/api/agent/route.ts` 是一个独立的简单 Gemini 示例接口，不是主 Code Agent 入口。
3. 对外项目名、npm 包名、安装包和快捷方式已统一为 **Multi-agent**；数据库文件名、Local Storage Key 与 Electron `appId` 等兼容标识按升级策略保留。
4. Electron 生产产物统一写入 `release/`，并采用 `Multi-agent-<version>-<platform>-<arch>` 命名；`appId` 保持 `com.agent.workspace` 以兼容已有用户数据。
5. 打包脚本不会复制 `.env.local` 或 Sentry 构建密钥；生产凭证必须通过运行时环境变量或应用内凭证设置提供。
6. 当前项目索引是文本 LIKE 搜索，不是向量语义索引；README 中不要误写成已经实现了向量数据库。
7. `searchCodebase()` 返回候选文件路径，不返回完整命中行；Worker 仍需 `read_file_from_disk`。
8. 并发 Worker 阶段禁止终端命令，工程验证统一在 Merge 后执行。

---

## 29. 最后用一段话理解这套架构

Multi-agent 的 Code Agent 不是让多个模型同时随意修改同一个目录，而是：

```text
Router 先缩小流程
→ 三个上下文 Agent 并行建立事实基础
→ 两层 Planner 拆出边界清晰的叶子任务
→ Dynamic Send 为每个任务创建隔离 Worker
→ Worker 只提交完整文件提案
→ Merge 统一解决相同文件、过期基线和写入一致性
→ Verification 用真实命令检查
→ Reviewer 只返工有问题的槽位
→ Final Report 汇总交付
```

真正的核心不是“Agent 数量多”，而是 **状态隔离、文件写入收口、可验证的交接协议和有限返工循环**。
