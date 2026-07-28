# Context Budget Manager 与 Memory Ranking

## 1. Context Budget Manager

入口：`app/lib/agent-runtime/context-budget-manager.ts`

所有文本模型调用都在统一 `LLM Gateway` 中执行预算管理，覆盖 QA、Code Agent、最终回答、Commerce 和媒体质量评估，不需要各业务重复处理。

处理顺序：

1. 估算消息、图片内容和工具 Schema 的 Token 占用。
2. 从总上下文窗口中扣除输出预留、工具占用和安全余量。
3. 将“用户消息 + 后续 assistant/tool 消息”视为同一轮，避免拆坏工具调用配对。
4. 强制保留系统消息与最新用户轮次。
5. 从近到远补充历史轮次；仍超限时，对保留消息做头尾截断。
6. 将裁剪报告写入 Agent Trace，便于观察原始 Token、最终 Token、丢弃消息数和截断消息数。

配置项位于 `env.example`：

- `AGENT_CONTEXT_WINDOW_TOKENS`
- `AGENT_CONTEXT_OUTPUT_RESERVE_TOKENS`
- `AGENT_CONTEXT_SAFETY_MARGIN_TOKENS`
- `AGENT_CONTEXT_MIN_MESSAGE_TOKENS`

## 2. Memory Ranking

入口：`app/lib/agent-runtime/memory-ranking.ts`

Memory Agent 会把长期摘要和近期会话拆成独立候选记忆，并依据以下因素排序：

- 相关性：查询与记忆的中英文词项相似度。
- 时效性：有时间戳时采用 30 天指数衰减；无时间戳时按候选顺序估算。
- 重要性：显式 importance，或依据“决定、约束、错误、风险、接口、路径”等线索估算。
- 访问频率：当前进程中被选中的次数，使用对数归一化，避免热门记忆永久霸榜。
- 多样性：使用轻量 MMR 惩罚高度相似内容，避免重复记忆占满预算。

排序结果受 `limit` 和 `maxTokens` 双重限制，并将选择结果写入 Agent Trace。

## 3. 验证

```bash
pnpm test:context-memory
pnpm lint
pnpm typecheck
```

新增及本次修改的代码文件均不超过 500 行。
