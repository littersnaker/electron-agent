# 多 Agent 源码导读

这份文档是给“以后回头看源码的自己”准备的。

目标不是介绍产品功能，而是帮你快速回答下面这些问题：

- 这套多 Agent 工作流现在到底怎么跑？
- 为什么要拆成 `Router / Search / Memory / File / Planner / Modify / Reviewer / Lint-Build-Test / Final Report`？
- 为什么中间还要插入 `Schema 校验`、`文件唯一性检查`、`Retry Planner`、`规则修复`、`单 Agent 降级`？
- 为什么 Reviewer 不直接让三路 Modify 全部重跑，而是只重跑指定槽位？
- 如果我要继续改这套架构，应该先看哪些文件？

---

## 1. 先看哪些文件

如果你是第一次回来看这套流程，推荐按下面顺序读：

1. `app/api/chat/agent/types.ts`
2. `app/api/chat/agent/state.ts`
3. `app/api/chat/agent/graph.ts`
4. `app/api/chat/agent/workflow-nodes.ts`
5. `app/api/chat/route.ts`
6. `app/api/chat/agent/checkpointer.ts`

这几个文件分别负责的事情如下。

### `types.ts`

这是“数据词典”。

你可以在这里先看清楚 3 组最重要的数据结构：

- `PlanTask`
  - 表示 Planner 拆出来的单个任务
  - 结构是 `{ task, files }`
  - 一个任务对应一组最需要改的文件

- `ModifyTaskResult`
  - 表示某一个 Modify 槽位的执行结果
  - 它会记录：
    - 自己是第几个槽位
    - 负责了什么任务
    - 涉及哪些文件
    - 修改总结
    - 实际 touched 了哪些文件
    - 最终状态是 `done` 还是 `skipped`

- `ReviewPayload`
  - 表示 Reviewer 的结构化输出
  - 最重要的是：
    - `decision`
    - `feedback`
    - `risks`
    - `retryTasks`

也就是说，你可以把整个中后段工作流理解成：

- Planner 产出 `PlannerPayload`
- Modify 产出 `ModifyTaskResult[]`
- Reviewer 产出 `ReviewPayload`

---

### `state.ts`

这是整张图共享的“全局白板”。

所有节点都会从这里读状态，再把自己的结果写回这里。

为什么一定要有这层？

因为这套系统不是一个普通的“单函数串行调用”流程，而是：

- 前面 3 个上下文 Agent 并发跑
- 中间 Planner 有多级校验和分支
- 后面 3 个 Modify 并发跑
- Reviewer 可能打回指定任务
- 最后再做真实工程校验和总结

如果没有一份统一状态：

- 你就不知道每一步产出了什么
- 也不知道后一步为什么会走这个分支
- 更不可能做持久化恢复

所以 `state.ts` 本质上是在解决两件事：

1. 节点之间如何共享信息
2. 图在任意时刻如何知道“自己现在进行到哪一步了”

你最值得重点关注的字段有：

- `searchContext`
- `memoryContext`
- `fileContext`
- `mergedContext`
- `plannerRawOutput`
- `plannerOutput`
- `plannerValidationStatus`
- `plannerRetryCount`
- `modifyResults`
- `mergedPatchSummary`
- `reviewPayload`
- `retryTaskSlots`
- `lintSummary`
- `finalReportSummary`

---

### `graph.ts`

这是“总布线图”。

这里不写具体业务细节，只负责定义：

- 有哪些节点
- 节点之间怎么连
- 哪些地方是条件分支
- 哪些地方要回环重试

如果你只想知道“整体流程长什么样”，最适合先看这个文件。

当前图结构可以概括成下面这条链路：

```text
Router
  -> SearchAgent / MemoryAgent / FileAgent
  -> Merge Context
  -> Planner Agent
  -> JSON Schema 校验
  -> 文件唯一性检查
  -> Retry Planner / 规则修复 / 单 Agent 降级
  -> Structured Task List
  -> Modify A / Modify B / Modify C
  -> Merge Patch
  -> Reviewer Agent
  -> Retry Dispatcher（只返工指定槽位）
  -> Lint / Build / Test
  -> Final Report
```

其中最关键的设计点有 4 个：

1. 上下文收集和修改执行都做了并发
2. Planner 结果不能直接信，必须先校验
3. Reviewer 只打回失败任务，不让三路全部重跑
4. 图状态会被 SQLite 持久化

---

### `workflow-nodes.ts`

这是“每个节点的具体行为实现”。

如果说 `graph.ts` 是地图，那这里就是每个站点内部具体做什么。

这个文件很长，建议不要从头机械往下扫。

正确读法是按这 4 层来读：

1. 基础工具函数层
2. Planner 校验链路
3. Modify 执行链路
4. Reviewer / 校验 / Final Report 链路

后面我会按这个顺序继续展开。

---

### `route.ts`

这是“前端请求”和“LangGraph 工作流”之间的桥。

它负责的不是业务决策，而是：

- 接收前端消息
- 启动 graph
- 把 graph 每个节点的进度变成 SSE 状态推给前端
- graph 跑完之后，再组织最终模型回答

所以你在前端看到的：

- `Router 已接收任务`
- `SearchAgent 已完成代码检索`
- `Planner 已生成执行计划`
- `Reviewer 已完成审查`
- `Final Report 已生成`

这些状态文案，基本都在这里维护。

---

### `checkpointer.ts`

这是图状态持久化的入口。

这里的作用很简单但非常关键：

- 如果没有它，图状态只能放内存里
- 服务一重启，线程状态就丢了
- 有了 SQLite checkpointer，同一个 `thread_id` 的状态可以继续恢复

所以这层本质上是在解决：

- 多轮对话如何续上
- LangGraph 节点状态如何持久化

---

## 2. 一次完整请求是怎么跑的

下面按真实执行顺序，串一次完整请求。

---

### 第 1 步：`route.ts` 接收前端请求

入口是：

- `app/api/chat/route.ts`

收到请求后，它会先做几件事：

1. 取 `messages`
2. 取 `sessionId`
3. 取 `workingDir`
4. 取 `projectId`
5. 把前端消息转成 LangChain 的消息对象

接着它会调用：

- `graph.getState(...)`

这一步是为了判断：

- 当前 `sessionId` 是不是一个已经存在的会话线程

如果是老线程，就不会把所有历史消息整段重放，而是只补最近消息。

这样做是为了控制上下文体积，避免每轮调用越来越重。

---

### 第 2 步：`Router` 重置本轮状态

入口节点：

- `routerNode()`

它的职责不是理解代码，而是给本轮流程“清场”。

它会把下面这些中间结果重置掉：

- `searchContext`
- `memoryContext`
- `fileContext`
- `mergedContext`
- `plannerOutput`
- `modifyResults`
- `mergedPatchSummary`
- `reviewPayload`
- `lintSummary`
- `finalReportSummary`

同时它还会做一个非常粗粒度的判断：

- 当前请求大概率需不需要进入“代码修改链路”

这个判断写在 `requiresChanges` 里。

它并不完美，但足够作为流程开关的第一层粗筛。

---

### 第 3 步：三个上下文 Agent 并发收集信息

这一步是并发的。

也就是说，图不是按下面顺序依次执行，而是三路同时开工：

- `searchAgentNode()`
- `memoryAgentNode()`
- `fileAgentNode()`

#### 3.1 `SearchAgent`

它负责“广度摸排”。

它会结合两类信息：

- 项目索引检索
- 本地代码库关键字扫描

目标是先给出一个问题范围：

- 这个需求可能涉及哪些模块
- 哪些文件最可能相关

它不负责精读文件，更像“侦察兵”。

#### 3.2 `MemoryAgent`

它负责把历史上下文整理出来。

它会拼两块内容：

- 长期记忆摘要 `summary`
- 最近几轮会话摘要

它存在的原因是：

- 当前用户一句话经常不是完整上下文
- 之前做过什么、返工过什么、已经改了什么，Planner 也需要知道

所以它更像“记忆补丁层”。

#### 3.3 `FileAgent`

它负责“沿着用户点名的路径去预读文件或目录”。

它会先从用户请求里提取可能像路径的字符串。

如果用户明确说了某个文件或目录：

- 就去读取对应文件预览
- 或列出目录结构

如果用户没有给具体路径：

- 就退回到工作目录概览

它存在的原因是：

- SearchAgent 解决的是“广度”
- FileAgent 解决的是“用户明确指定的局部深度”

---

### 第 4 步：`Merge Context`

入口节点：

- `mergeContextNode()`

它做的事情很简单：

- 把 `SearchAgent`
- `MemoryAgent`
- `FileAgent`

三份结果合成一份 `mergedContext`

后面几乎所有关键节点都会吃这份上下文：

- Planner
- Modify
- Reviewer
- Final Report

所以 `mergedContext` 可以理解成“当前任务的统一上下文底稿”。

---

## 3. Planner 为什么不能直接往下走

这是这套架构最重要的一个设计点。

直觉上，你可能会觉得：

- Planner 输出任务数组
- 直接分给 Modify A/B/C 不就行了

但实际不能这么做。

因为 Planner 是模型产物，天然存在这几种风险：

1. 不是合法 JSON
2. 是 JSON，但结构不对
3. 结构对，但任务是空的
4. 任务拆分重复，多个任务改同一个文件
5. 任务虽然合法，但不适合并发

所以这里设计了 4 层保险。

---

### 第 5 步：`Planning Agent`

入口节点：

- `planningAgentNode()`

它只负责一件事：

- 输出严格 JSON 数组

例如：

```json
[
  {
    "task": "修改登录页",
    "files": ["Login.tsx"]
  },
  {
    "task": "修改 API",
    "files": ["AuthService.ts"]
  },
  {
    "task": "修改测试",
    "files": ["login.test.ts"]
  }
]
```

这里特别强调“只输出 JSON，不要解释文本”，就是因为后面程序要做结构化校验。

这个节点只负责“规划”，不直接修改文件。

---

### 第 6 步：`JSON Schema 校验`

入口节点：

- `plannerSchemaValidationNode()`

它会把 Planner 原始文本交给：

- `extractPlannerJsonArray()`
- `parsePlannerPayloadWithSchema()`

做两层处理：

1. 尝试从文本里提取 JSON 数组
2. 用 `zod` 校验结构是否合法

如果失败，`plannerValidationStatus` 会被标成：

- `schema_invalid`

如果成功，会标成：

- `schema_valid`

并把解析后的结果写进：

- `plannerOutput`

---

### 第 7 步：`文件唯一性检查`

入口节点：

- `fileUniquenessCheckNode()`

这一步的目标非常明确：

- 不允许多个任务并发修改同一个文件

为什么这么严格？

因为一旦出现这种情况：

- Modify A 改 `Login.tsx`
- Modify B 也改 `Login.tsx`
- Modify C 还顺手改了 `Login.tsx`

那后面的：

- Merge Patch
- Reviewer
- 最终落盘

都会变得非常复杂。

所以这里会用：

- `collectDuplicatePlannerFiles()`

来找出跨任务重复文件。

没有重复时，状态进入：

- `files_unique`

有重复时，状态进入：

- `files_duplicated`

---

### 第 8 步：`Retry Planner`

入口节点：

- `retryPlannerNode()`

它本身并不重新规划，它只做两件事：

1. 增加 `plannerRetryCount`
2. 记录 `plannerRetryReason`

然后图会回到：

- `planningAgentNode()`

让 Planner 带着“上次为什么失败”的信息重新规划。

这个设计的好处是：

- 重试本身变成显式节点
- 前端可以明确显示“Planner 第几次重试”
- 状态也更容易排查

---

### 第 9 步：`规则修复`

入口节点：

- `rulesRepairNode()`

这是 Planner 重试多次后还失败时的“程序级保底修复”。

注意，它不是再去问一次模型，而是直接在程序层做保守处理。

目前的策略是：

- 同一个文件只保留给最先出现的任务
- 后续重复任务自动剔除重复文件

这一步主要依赖：

- `normalizePlannerTasks()`

如果修复后得到一份稳定、唯一的任务列表：

- 状态写成 `rules_repaired`
- 继续往下走

---

### 第 10 步：`单 Agent 降级`

入口节点：

- `singleAgentDegradeNode()`

如果前面的：

- Schema 校验
- 文件唯一性检查
- Retry Planner
- 规则修复

全都没法得到稳定可并发的任务列表，就会走这里。

这里的思路很直接：

- 既然并发拆分不稳定，那就不要再硬拆
- 改成一个大任务，交给单 Agent 串行执行

对应的核心函数是：

- `buildSingleAgentFallbackPlan()`

这样做的意义不是“最优”，而是“至少别卡死，流程要能继续跑完”。

---

## 4. Structured Task List 为什么还要单独有个节点

入口节点：

- `structuredTaskListNode()`

它做的事情不是重新规划，而是把 Planner 结果整理成更适合阅读和传递的摘要。

里面会同时放：

- Planner 当前状态
- Planner 的说明信息
- Planner 重试次数
- 结构化 JSON
- 可读版任务列表

为什么不直接把 `plannerOutput` 原样往后传？

因为后面有两类消费者：

1. 机器节点
2. 人类调试和日志查看

JSON 适合机器，但不够适合人。

所以这里相当于做了一份“中间讲义”。

---

## 5. Modify A / B / C 是怎么并发工作的

这是执行链路的核心。

入口逻辑来自：

- `createModifyAgentNode(slot)`

最终导出成：

- `modifyAgentANode`
- `modifyAgentBNode`
- `modifyAgentCNode`

为什么用工厂函数？

因为三路 Modify 的逻辑几乎完全一样，唯一差别只是：

- 自己负责哪个槽位

所以用工厂函数最省事，也最不容易改漏。

---

### 每个 Modify 节点具体做什么

单个 Modify 节点内部大致是这个过程：

1. 先根据 `slot` 取出自己的任务
2. 判断本轮是否需要执行
3. 如果是 Reviewer 返工轮，检查自己是否在返工名单里
4. 构造提示词，把任务、上下文、Reviewer 反馈都喂给模型
5. 允许模型调用工具
6. 循环执行“工具调用 -> 工具结果回喂模型”
7. 直到模型给出最终中文总结
8. 把结果收敛成 `ModifyTaskResult`

它为什么不是“一次模型调用就结束”？

因为真正做代码修改通常需要闭环：

1. 先读文件
2. 再搜索
3. 再提议修改
4. 看 diff
5. 再 apply

所以这里必须支持工具循环，而不是一次性回答。

---

### Modify 用到了哪些关键工具函数

#### `executeToolBatch()`

它负责一批工具调用的调度。

最关键的设计是：

- 只读工具并行
- 写入工具串行

为什么？

因为读操作彼此不冲突，但写操作如果并发，很容易互相覆盖。

#### `proposeFileChange()`

这一步不是直接改正式文件，而是先写一个：

- `xxx.pending`

目的就是先把修改提案暂存起来。

#### `getDiff()`

它会比较：

- 正式文件
- `.pending` 文件

把差异整理出来，给模型和人看。

#### `applyFileChange()`

只有走到这里，修改才真正落盘。

也就是说，这条链路的基本思路是：

```text
先提案 -> 看差异 -> 再正式应用
```

这比模型直接覆盖文件安全得多。

---

## 6. 为什么 `Merge Patch` 现在只做汇总

入口节点：

- `mergePatchNode()`

名字看起来像“自动合并补丁”，但当前实现其实不是。

它现在只做：

1. 汇总 Planner 任务数组
2. 汇总三路 Modify 的执行结果

然后生成：

- `mergedPatchSummary`

为什么故意不做真正的 patch 自动合并？

因为当前架构的前提是：

- 尽量通过 Planner 文件唯一性检查，避免多 Agent 改同一个文件

既然前面已经尽量避免同文件冲突，那这里就没必要再做一个复杂、脆弱的自动 patch merge 系统。

所以当前 `Merge Patch` 更准确的理解是：

- “修改结果汇总器”

而不是：

- “通用补丁合并器”

---

## 7. Reviewer 为什么是这套架构的关键

入口节点：

- `reviewerAgentNode()`

它是整个执行阶段的质量闸门。

它的职责不是亲自改代码，而是做判断：

1. 当前结果能不能通过
2. 哪些地方有问题
3. 哪个任务需要返工

它输入的关键信息包括：

- 用户请求
- Planner 任务数组
- Modify 结果
- Merge Patch 汇总
- 当前文件快照
- 当前 Review 轮次

然后它要求模型输出严格 JSON：

```json
{
  "decision": "PASS",
  "feedback": "说明",
  "risks": [],
  "retryTasks": [0]
}
```

---

### 为什么 Reviewer 只返工指定槽位

这是这套架构里非常值钱的一个优化。

如果不这么做，会发生什么？

假设：

- Task A 有问题
- Task B 没问题
- Task C 也没问题

如果 Reviewer 一打回就让 A/B/C 全部重跑：

- 浪费模型调用
- 浪费工具调用
- 浪费本地命令执行
- 还可能把原本没问题的结果跑坏

所以现在的策略是：

- Reviewer 输出 `retryTasks`
- `Retry Dispatcher` 把返工槽位写回状态
- 各个 Modify 节点自己判断本轮要不要跑

例如：

```json
{
  "decision": "RETRY",
  "feedback": "Task A 修改不完整，测试文件遗漏",
  "risks": ["登录逻辑没有覆盖异常分支"],
  "retryTasks": [0]
}
```

那就只会重跑：

- `Modify A`

而不会动：

- `Modify B`
- `Modify C`

---

### Reviewer 为什么还要限制最大返工轮次

因为如果不限制，图可能会在：

- `Modify -> Reviewer -> Retry -> Modify -> Reviewer`

之间无限循环。

所以这里加了：

- `MAX_REVIEW_RETRIES`

达到上限后，就算 Reviewer 还想打回，也会强制带着风险往后走，进入最终总结。

这是一种工程取舍：

- 不追求理论上无限修复
- 优先保证整条链路能收束

---

## 8. `Retry Dispatcher` 真正在做什么

入口节点：

- `retryDispatchNode()`

这个节点其实非常“轻”。

它不负责修改代码，只负责记录：

- 这一次到底哪些槽位要返工

真正决定跑不跑的是每个 Modify 节点自己：

- 如果当前槽位在 `retryTaskSlots` 里，就执行
- 如果不在，就直接沿用上一轮结果并标记为 `skipped`

这个设计很好，因为它把：

- 返工目标的决定权
- 修改执行的实际控制

拆开了。

这样结构更清晰，也更容易调试。

---

## 9. 为什么还要跑 `Lint / Build / Test`

入口节点：

- `lintBuildTestNode()`

前面的 Reviewer 本质上还是模型审查。

它能发现很多逻辑问题，但它不能替代真实工程验证。

所以最后还要补一层“硬校验”：

- `eslint`
- `build`
- `test`

这里的策略是：

1. 如果 touched 到了可 lint 的代码文件，就跑 lint
2. 如果项目配置了 `build` 脚本，就跑 build
3. 如果项目配置了 `test` 脚本，就跑 test

这样做的意义很直接：

- Reviewer 说“看起来没问题”
- 工程验证说“实际上能不能过”

只有两层都看过，结果才更可信。

---

## 10. Final Report 为什么单独做一个节点

入口节点：

- `finalReportNode()`

这一步的作用是把前面所有结构化结果收束成一个适合人阅读的最终结论。

它会综合：

- 用户请求
- Planner 任务数组
- Structured Task List
- Modify 结果
- Merge Patch 汇总
- Reviewer 结果
- Lint / Build / Test 输出

然后让模型生成一段简洁中文 Markdown。

为什么不在 `route.ts` 里自己字符串拼接就完了？

因为最终报告既要：

- 保留结构化事实
- 又要对用户足够自然可读

这时候模型来负责“表达整理”会更合适。

另外，这一步还会顺手更新：

- `summary`

也就是长期记忆摘要。

这样下一轮对话还能记住这次做了什么。

---

## 11. `route.ts` 和 `graph.ts` 的分工

这一点很容易混。

你可以这样记：

### `graph.ts`

负责：

- 工作流怎么跑
- 节点怎么连
- 分支怎么走
- 哪些节点会回环

它关注的是：

- “内部状态机”

### `route.ts`

负责：

- 前端请求怎么进来
- graph 怎么启动
- SSE 状态怎么推给前端
- 图跑完以后最终文本怎么返回

它关注的是：

- “对外接口和交互体验”

所以：

- 业务决策看 `graph.ts` 和 `workflow-nodes.ts`
- 前端为什么看到这些状态，看 `route.ts`

---

## 12. SQLite 持久化在这套架构里的意义

入口文件：

- `app/api/chat/agent/checkpointer.ts`

这里的关键不是“用了 SQLite”这四个字，而是它解决了什么问题。

它解决的是：

1. 图状态不要只放内存
2. 同一个 `thread_id` 下次还能继续接着跑
3. 服务重启后状态尽量不要丢

所以你可以把它理解成：

- 这是 LangGraph 层面的会话状态持久化

它和你原来存聊天内容的 SQLite 是同类问题，但不是同一层职责。

一个更偏：

- 聊天记录 / 工作区数据存储

另一个更偏：

- 状态图执行状态存储

---

## 13. 以后如果你要继续改，应该从哪里下手

下面按“想改什么”给一个最快入口。

### 想改任务拆分格式

先看：

- `types.ts`
- `planningAgentNode()`
- `parsePlannerPayloadWithSchema()`

---

### 想改 Planner 的校验规则

先看：

- `plannerPayloadSchema`
- `plannerSchemaValidationNode()`
- `fileUniquenessCheckNode()`
- `rulesRepairNode()`

---

### 想改并发 Modify 的行为

先看：

- `createModifyAgentNode()`
- `executeToolBatch()`
- `executeSingleTool()`

---

### 想改 Reviewer 的返工策略

先看：

- `ReviewPayload`
- `safeParseReviewPayload()`
- `reviewerAgentNode()`
- `retryDispatchNode()`
- `resolveRetryTaskSlots()`

---

### 想改最终前端状态提示

先看：

- `app/api/chat/route.ts`

---

### 想改状态持久化

先看：

- `checkpointer.ts`
- `graph.ts`

---

## 14. 这套架构当前最核心的设计思想

如果你以后把很多细节忘了，只记下面这 6 句话就够了：

1. 先收集上下文，再规划，不要一上来就改文件。
2. Planner 的输出不能直接信，必须先做结构化校验。
3. 并发 Modify 的前提是任务文件尽量互斥。
4. Merge Patch 现在只是汇总器，不是真正的自动补丁合并器。
5. Reviewer 负责局部返工，不要让所有 Modify 白跑。
6. 最后必须补一层真实工程校验，再出 Final Report。

---

## 15. 建议你的复习顺序

如果你下次只想花 10 分钟复习，可以这么做：

1. 先看 `graph.ts`
2. 再看 `state.ts`
3. 再看 `planningAgentNode()`
4. 再看 `plannerSchemaValidationNode()` 和 `fileUniquenessCheckNode()`
5. 再看 `createModifyAgentNode()`
6. 再看 `reviewerAgentNode()`
7. 最后看 `lintBuildTestNode()` 和 `finalReportNode()`

如果你按这个顺序走一遍，基本就能重新把整条链路在脑子里搭起来。
