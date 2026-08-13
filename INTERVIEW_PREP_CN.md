# Multi-Agent AI 工作平台 · 面试答辩指南

> 本文档基于当前仓库（D:\next-agent\my-app）真实代码整理，供面试前复习使用。
> 所有机制描述都对应代码里的具体模块，深挖不穿帮。

---

## 一、项目一句话介绍

面向企业智能化办公场景的桌面级 Multi-Agent 平台：基于 Electron + Vite + React + Python FastAPI 构建统一 Agent Runtime，通过配置化注册代码开发、知识问答、电商运营等专业 Agent，把用户需求拆解为可并行执行的 WorkList，由自研调度器完成执行、失败重规划与断点恢复。

---

## 二、架构总览

```
Electron 桌面壳
  └─ Vite + React + TypeScript 前端
       └─ SSE 实时事件流
            └─ Python FastAPI 后端
                 ├─ 统一 Agent Runtime（AgentRegistry / SkillRegistry / MemoryRouter / ModelRouter / ContextManager / TaskManager）
                 ├─ Agent 适配器（coding / commerce / qa）
                 ├─ Code Agent 编排（分类器 → Planner → WorkList 调度 → Worker 循环 → 终审）
                 ├─ 原生 Function Calling（工具 Schema 透传 + 流式 tool_calls 累加）
                 ├─ Tool Gateway（search/read/inspect/edit/run/filesystem/software_factory）
                 ├─ SQLite（checkpoint / memory / 已完成工作注册表 / 项目索引，操作经 to_thread 移出事件循环）
                 ├─ 多模型路由（Qwen / DeepSeek / Kimi / GLM / OpenAI，自动降级）
                 └─ 电商（TalorData / Amazon 搜索与评论分析 / TikTok Shop / 1688 / Listing 草稿）
```

技术栈：Electron / Vite / React / TypeScript / Python FastAPI / SQLite / SSE / 原生 Function Calling / 多模型路由 / 自研 WorkList 调度器 / Software Factory。

---

## 三、核心链路：一条“帮我改个 bug”的消息怎么走完

### 1. 意图分类（不按复杂度，按意图）

分类器把请求分成四类：

- `workspace_info`：问项目路径/信息 → 直接返回；
- `read_only`：只读分析 → 只读 Agent 循环（search/read/inspect/finish），**不拆 WorkList**；
- `code_change`：要改代码 → 进入完整规划链路；
- `interactive_reply`：用户回复批准/拒绝建议模式提案 → 应用或取消提案。

另外执行模式三档：`suggest`（提案+人工批准）/ `auto_edit`（自动编辑不跑命令）/ `full_auto`（自动编辑+受限命令）。

### 2. 上下文构建

- 项目索引检索（SQLite LIKE）命中相关文件，未命中回退读项目概览文件；
- 注入 Runtime 上下文：Skill 约束 + Memory 记忆 + 最近对话历史，统一压缩到预算内；
- 项目树剪枝遍历（跳过 node_modules/.pnpm-store/.venv/.git 等），限制 800 行。

### 3. Planner 生成 WorkList

- 一次 LLM 调用生成：优化目标、约束、验收标准、非目标、验证命令、WorkList；
- 每个 Work 独立：id / 目标 / 依赖 / 优先级（数字小先执行）/ 目标文件 / 执行类型；
- 数量约束：默认 3-6 个，最多 8 个；
- 特例：明确的单文件重命名/移动 → 本地执行器直通，跳过 Planner 和 Worker 大模型；
- 电商类请求追加 Software Factory 契约闭环（收敛为 2 个 Work：契约生成 + 页面接入校验）。

### 4. 并行调度执行（核心卖点）

- `WorkLedger` 是唯一状态源：pending / running / succeeded / failed / skipped；
- 滚动并行：默认 4 槽（`CODE_AGENT_PARALLEL_WORKERS`），任一 Work 完成立即补位；
- **同文件冲突按优先级串行**：静态层精确匹配 targetFiles，运行时层按 (priority, sequence) 排队；
- 每个 Worker 是“模型每轮输出一个 JSON 动作 → 执行 → 写 checkpoint → 下一轮”的循环，直到 `complete_work`；
- 每个工具动作后写 checkpoint（节流 2.5s，关键节点强制写）。

### 5. 失败重规划（与 LangGraph 最大的区别）

- 失败分类：runtime（协议/超时/守卫/token）/ code / validation / resource；
- runtime 失败 → 干净重试（最多 2 次），不创建代码返工项；
- code/validation 失败 → 结构化上报 Planner（每个失败 Work 的 workId/status/error/attempts/changedFiles）→ **只重排失败项，成功 Work 不可重做**；
- 阈值：单 Work 最多 3 次尝试，全任务最多 3 轮重规划，可环境变量收紧。

### 6. Checkpoint 断点恢复

- SQLite `agent_checkpoints` 保存：taskPlan / WorkList 账本 / 每个 Work 的 WorkerState（transcript、读取版本、token 预算、守卫计数等）；
- 恢复规则：succeeded/skipped 不动；running 放回 pending；failed 按类型重试或重规划；
- 恢复后只继续未完成 Work，成功产物绝不重做。

### 7. 已完成工作注册表（幂等）

- 成功的 Work 登记到 SQLite `project_completed_works`（项目 + 标准化标题 + 产物文件）；
- 下次规划出同标题 Work 且产物文件健在 → **确定性跳过**，不经过模型；
- 防误跳：产物缺失不跳、标题不同不跳、明确“重新/覆盖/重做”不跳。

### 8. 终审与输出

- 所有 Work 完成/跳过后做本地终审：Patch 风险、回归基线、验证命令、质量门（不调 LLM）；
- full_auto 模式补跑未执行过的 test/lint/build；
- 输出交付摘要，后台重建索引，全程 SSE 实时上报生命周期。

---

## 四、十个关键技术点（每个都能展开讲）

### 1. 并行 WorkList 调度与同文件冲突串行

- 静态：`works_conflict` 精确比较 targetFiles，目录级声明不锁死；
- 动态：`WorkspaceResourceCoordinator.reserve` 按 (priority, sequence) 原子排队；
- 实际写入还有 `expected_versions`（读取时文件指纹）校验，版本不一致直接拒绝并提示重读。

### 2. 事务式编辑

- 一批 edit 操作先备份，中途失败整体回滚；
- 写入前记录回归基线（契约签名/内容哈希），终审做回归检测。

### 3. 失败隔离与增量重规划

- 成功 Work 的修改已真实落盘，后续 Work 可能依赖它 → 重跑会改坏代码；
- 所以 ledger 把 succeeded/skipped 视为不可变，重规划只交回失败/待办项。

### 4. Checkpoint

- 按 Work 粒度存状态，而不是整张图；
- 崩溃恢复时 running→pending 的原因：磁盘状态不确定、模型上下文可能过期，必须重新 read 真实文件再决策。

### 5. 上下文工程

- Worker 每轮上下文上限（约 30K 字符），transcript 单条 ≤16K、总量 ≤120K，超限丢中间保头尾；
- read 支持 offset 字符偏移分页续读，截断处明确标注；
- Token 预算：单 Work 128K，超过 2 倍阈值才终止（防死循环又不误杀）；
- 模型调用“卡住才杀”：90 秒无数据判死，慢速长生成给到 300 秒。

### 6. 记忆系统

- SQLite `agent_memories`，三类：episodic（执行摘要）/ semantic（知识，待写入）/ task（任务态）；
- 作用域按项目（无项目回退会话），搜索用 LIKE + 项目/会话/global 三作用域；
- 命中记忆注入 Planner（Related Memory）和 Worker（MEMORY NOTES）；
- 执行摘要会带上最终回答（Summary），下次同问题能“记得上次结论”。

### 7. 多模型自动路由

- auto 模式候选链 = 已配置 Key 的模型按优先级 + 最近成功率排序；
- 供应商级熔断（端点连续失败短路）、区域端点回退；
- 流式响应缺失 usage 时本地估算兜底（`ensure_usage`）。

### 8. 工具网关与安全

- 统一 Tool Gateway：按 read/write/execute 权限隔离；
- 工作区根目录边界 + 敏感路径过滤（.env/密钥）+ 命令白名单；
- 项目树/索引全部剪枝遍历，避免进入 node_modules/.pnpm-store。

### 9. 执行守卫

- 每轮防重复 read/search；分析阶段最多 6 个上下文动作；
- 连续 3 轮只读 → READ-ONLY STALL 警告，强制转向 edit/complete；
- 单次尝试默认最多 10 轮（多文件自适应 18），超限判失败交给重试/重规划。

### 10. 协议容错与超时

- read 兼容 `path` 单数、逗号/换行分隔字符串；连续协议错误容忍 5 次并附正确示例；
- 网关流式双超时：90s 无数据 = 卡死终止；总时长上限 = 慢速不误杀。

### 11. 原生 Function Calling（从 Next.js 迁移中补回的能力）

- 网关与 OpenAI 兼容协议透传 `tools` / `tool_choice`，流式 `delta.tool_calls` 按 id 累加；
- **兼容 DeepSeek 无 id 分片**：分片不带 id 时续接当前最后一个 tool_call，arguments 完整拼回，避免拆散成空动作；
- `build_openai_tools` 把 Worker 动作目录（search/read/edit/complete_work…）转成结构化 Schema，模型直接返回 tool_calls，不再输出大段自然语言分析再给 JSON——根治"模型话多与空转"；
- 面试口径：这是对标 ZCode/Claude Code 的"架构级工具约束"。

### 12. 事件循环优化：SQLite 与全盘扫描移出事件循环

- 项目原用同步 `sqlite3` 套 `async` 外观，全库 60+ 处调用都阻塞 SSE 事件循环——"改一个页面要 5 分钟"里 DB 那部分的根因；
- `AsyncConnection` 全方法经 `asyncio.to_thread` 执行，`check_same_thread=False` 允许连接跨线程；
- **协程取消陷阱**：`to_thread` 只终止 await、杀不掉 worker 线程里的 sqlite 操作，取消时立即 close 会触发 Windows access violation（C 层 use-after-free）——修复：`close()` 先 `asyncio.gather` 等在途任务结束再关连接；
- 全盘扫描（`render_workspace_tree` / `score_workspace_paths`）、Software Factory 工具、`code.inspect` 的 AST 全库扫描同样移出 async 路径；
- 后台复盘/索引任务统一 `spawn()` 登记，关闭时先排空再关连接池，杜绝 `Event loop is closed`。

### 13. 错误可见性工程（你的真实痛点：W001 掩盖原因）

- 历史问题：模型调用失败被静默吞掉，UI 只看到"W001(3次)"这类聚合码，看不出真实原因；
- 修复：Planner 降级、批量写入失败、审查调用失败全部补日志 + 原因透传；未配置 Key 时 worker 快速失败而不是空转消耗重试；
- 前端同一类问题：JS `?:` 优先级低于 `||` 导致电商错误详情恒取固定文案，后端真实原因到不了界面——加括号修正；
- 面试口径：错误要"可见、可定位、不谎报成功"，这是一整套工程原则（拦截 edit 回滚后谎报成功的漏洞也是同一原则）。

---

## 五、高频面试题（带回答要点）

### A. 架构与流程

1. **介绍一下你这个项目？**
   → 一句话定位 + 三层架构（前端/后端/Agent 运行时）+ 核心能力（代码开发、问答、电商）+ 两个卖点（并行调度、断点恢复）。

2. **一条请求从进入到完成的完整流程？**
   → 见“核心链路”八步，按顺序背熟：分类 → 上下文 → Planner → 调度 → 失败重规划 → checkpoint → 终审 → 输出。

3. **为什么不用 LangGraph？**
   → 项目早期用过（TS 版），迁移 Python 时改为自研：需要文件冲突感知调度、按 Work 粒度恢复、失败只重排失败项，通用图框架表达不了这些；对比叙事是加分项。

4. **Agent 之间怎么调度？**
   → AgentRegistry 配置化注册（YAML），统一 Runtime 按请求路由到 coding/commerce/qa；代码任务内部再用 Planner 拆 WorkList。

5. **为什么不拆 WorkList 的任务怎么走？**
   → 只读问题走只读循环；明确文件重命名走本地执行器；代码修改才走 Planner。

### B. 调度与并发

6. **WorkList 怎么并行？**
   → 依赖满足即入就绪池，滚动补位，默认 4 并发。

7. **两个 Work 写同一个文件怎么办？**
   → 静态冲突检测先排开；运行时按优先级排队；写入时版本指纹校验，不一致拒绝重读。

8. **优先级怎么定义？**
   → Planner 给 priority，数字小先执行；只影响启动顺序和同文件串行顺序。

9. **并行 Worker 会互相污染状态吗？**
   → 每个 Work 独立 WorkerState；调度时对 WorkItem 做副本，禁止共享可变对象。

### C. 状态与恢复

10. **checkpoint 存了什么？**
    → taskPlan、WorkList 账本（每个 Work 状态）、每个 Work 的 WorkerState、usage、replanRound 等。

11. **崩溃恢复怎么保证成功的不重跑？**
    → 恢复时按状态决定：succeeded/skipped 不动，running 放回 pending，failed 重试或重规划。

12. **为什么 running 的 Work 不放回原动作继续？**
    → 崩溃时磁盘状态不确定、模型上下文可能过期，必须重走一轮重新读真实文件，保证“模型看到”和“磁盘”一致。

13. **失败后为什么不整任务重跑？**
    → 正确性优先：成功 Work 已落盘且可能被下游依赖，重跑会改坏代码；只重排失败项。

### D. 上下文与 Token

14. **怎么防止上下文爆炸？**
    → 三层：transcript 单条/总量上限、每轮 prompt 预算、read offset 分页；检查点节流写入。

15. **Token 预算怎么控制？**
    → 每 Work 128K 累计，超 2 倍阈值终止；重试不重放历史（压缩成失败摘要）。

16. **模型响应超时怎么处理？**
    → 90 秒无数据判卡死终止；有进展的长生成给到 300 秒，不误杀。

17. **模型一直读不写怎么办？**
    → 执行守卫：重复动作拒绝、连续 3 轮只读强制转向、16 轮上限。

### E. 记忆

18. **长记忆怎么做的？**
    → SQLite 三类记忆，项目作用域，运行时检索注入 Planner/Worker；执行摘要带最终回答。

19. **记忆和 checkpoint 的区别？**
    → checkpoint = 单次任务执行状态（断点）；memory = 跨会话知识；两张表、两套生命周期。

20. **为什么之前记忆没生效？**
    → 检索到但被 planner/worker 解析器丢弃；已修复并加测试（这是你真实踩过的坑，面试可以讲）。

### F. 安全与工程化

21. **AI 改代码怎么保证安全？**
    → 事务式编辑 + 版本指纹 + 回归基线 + 命令白名单 + 敏感路径过滤 + 权限隔离的工具网关。

22. **怎么防 prompt 注入/恶意文件？**
    → 敏感路径软过滤、命令白名单、工作区根目录边界；诚实说明目前没有 OS 级沙箱。

23. **多模型怎么路由？**
    → auto 候选链按成功率排序、供应商熔断、区域端点回退、usage 本地估算。

### G. 踩坑与演进

24. **项目经历过哪些架构变化？**
    → Next.js + LangGraph（TS）→ Vite + React + Python FastAPI + 自研调度；迁移原因、删 LangGraph 原因、收益。

25. **遇到最难的问题是什么？**
    → 任选真实案例：上下文爆炸治理、token 预算反复超限、Mock 反复重新生成、只读误判、记忆不生效——每个都有修复过程。

26. **Mock 任务为什么反复重新生成？**
    → FileExistsError 被当失败 → 重试再生成；修复：产物存在先 validate，通过即复用。

27. **UI 组件任务重复执行怎么解决？**
    → 已完成 Work 注册表：成功落库，同标题且产物健在直接跳过；明确“重做/覆盖”不跳。

### H. 开放题

28. **如果让你加一个新 Agent？**
    → agents/ 加 YAML 配置 + 后端 adapter + 前端会话类型；注册进 Runtime 即可被统一调度。

29. **如果要支持多用户/企业化？**
    → 账号/RBAC/审计/密钥托管/OS 级沙箱/网络出口控制/成本核算/离线评测集。

30. **如果重新设计，你会改什么？**
    → 可答：语义记忆改向量检索、UI 验收加自动校验、checkpoint 分表、任务持久化队列。

### I. 电商（简历差异化，2026-08 新增）

31. **电商 Agent 现在有哪些能力？**
    → 市场研究（TalorData SERP + Amazon 搜索，SP-API 优先/公开爬虫兜底 + TikTok Shop/1688 官方 API）+ **Amazon 评论分析** + Listing 草稿（pending/confirmed/rejected 状态机，不发布）。诚实边界：Temu/Keepa 只有凭据占位，无付费数据源。

32. **评论分析怎么做？**
    → 对评论数最高的 top 3 个 Amazon 商品并行采集评论页（翻 3 页约 30 条，正则解析，无第三方库）；评分分布 + 确定性情感词频；**LLM 只增强第一个商品**（控制耗时和 token），其余确定性分析；失败降级为明确标注的演示样本，不中断研究流程——复用全流程的"降级哲学"。

33. **为什么 LLM 只增强一个商品？**
    → 评论分析的耗时和 token 成本与商品数线性增长；对 top 1 做语义提炼已能代表口碑，其余用词频兜底足够——这是"质量与成本"的工程权衡，可讲 token 预算原则。

34. **为什么坚持"不伪装数据"？**
    → 没有真实销量/BSR/评论时，报告带 `runMode: demo` 与橙色横幅声明"不可用于决策"；这是产品信任底线，也是和"套壳 demo"的区别。简历里写电商能力时主动讲这个边界反而加分。

---

## 六、简历一致性口径（必须统一）

- **LangGraph**：早期版本真实使用过（TS 版），迁移后自研；简历写”自研 WorkList 调度器”，面试主动讲”为什么不用 LangGraph”；
- **电商 Agent**：已实现市场研究（TalorData/Amazon/TikTok Shop/1688）+ Amazon 评论分析 + Listing 草稿；简历写”电商选品研究与评论分析”，面试讲清”数据源降级链 + 不伪装 demo”；
- **Media Agent**：当前是独立 `/api/media/generate` + 前端虚拟角色，后端未注册；若简历写”Media Agent”，口径是”媒体能力已打通，正在接入统一 Runtime”（或先做完再写）；
- **技术栈**：Vite + React + Python FastAPI（不是 Next.js 14）；模型调用走原生 Function Calling（非纯文本协议）；
- **”自研”口径**：架构与核心设计是自己做的，实现大量使用 AI 辅助编码——现在这是常态，重点是讲得清每条链路。

---

## 七、临场注意

1. 数字只说真实的：并行度 4、token 上限 128K、超时 300s、worklist ≤8、单 Work 尝试上限默认 10 轮（多文件 18）、重试 2/3/3；
2. 被追问到不会的细节：承认边界并给思路（”这块当前是 XXX，如果要改进我会 XXX”），比硬编强；
3. 每个机制都准备”为什么不用现成的/为什么这样设计”的答案；
4. 提前在本机把 `pytest backend` 全量测试跑绿（当前 517 passed），面试可展示工程习惯；
5. 电商相关题目要主动亮”数据源降级链 + demo 不伪装”的信任设计，这是与套壳 demo 的差异化点。
