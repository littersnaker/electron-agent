# 白雪条 Commerce v10 修改说明

## 本次解决的问题

原流程可能出现以下现象：

1. TalorData Token 测试返回 HTTP 200，因此连接测试显示成功；
2. 实际研究时，响应中的结果字段没有被 Provider 正确识别；
3. 系统把本轮误判为“没有可验证数据”，并终止报告；
4. Amazon、Keepa、1688 等增强 API 未配置时，用户无法完整验证 Commerce 产品流程。

## 主要改动

### 1. TalorData 响应结构兼容层

新增：`app/lib/commerce/providers/talordata-response.ts`

支持：

- `organic`、`organic_results`、`results`；
- `shopping`、`shopping_results`、`product_results`；
- `sponsored_results`、`ads`、`paid_results`；
- `related`、`people_also_ask`、`people_are_saying`；
- 顶层数组、嵌套对象和 JSON 字符串包装。

解析失败时只输出结构摘要和数组长度，不把完整搜索内容写入错误日志。

### 2. 连接测试从“HTTP 成功”升级为“结果可解析”

修改：

- `app/lib/commerce/providers/talordata-client.ts`
- `app/lib/commerce/providers/provider-health.ts`

现在测试连接必须同时满足：

- 请求成功；
- 响应中至少解析出一条搜索结果。

### 3. 三档运行模式

新增：`app/lib/commerce/run-mode.ts`

模式：

- `full`：核心公开市场数据 + 至少一个真实增强来源；
- `market-intelligence`：至少一个真实来源可用，但增强覆盖不足；
- `demo`：所有真实来源均无数据，使用模拟样本展示流程。

### 4. 无 API 演示 Provider

新增：`app/lib/commerce/providers/demo-market.ts`

特点：

- 同一市场和类目生成稳定、可重复的演示样本；
- 所有样本带 `isDemo: true`；
- 不生成真实链接和真实品牌；
- 不与任何真实来源混合；
- 不调用 LLM 做商业判断；
- 不生成月销量估算。

### 5. Orchestrator 降级策略

修改：`app/lib/commerce/orchestrator/data-source-orchestrator.ts`

规则：

- 所有真实来源并行运行；
- 任意单个来源失败不会阻断其他来源；
- 有真实数据就生成真实报告并自动判断 full / market-intelligence；
- 所有真实来源为空才进入 demo。

### 6. 报告与界面

修改：

- `app/api/commerce/research/route.ts`
- `app/component/commerce/CommerceReportCard.tsx`
- `app/lib/commerce/report-html.ts`
- `app/lib/commerce/llm.ts`
- `app/lib/commerce/analytics.ts`
- `app/lib/commerce/types.ts`

页面、SSE 文本和 PDF 均展示运行模式。演示模式使用橙色提示，并明确声明不能用于选品、采购、定价或投放决策。

## 已执行验证

已完成以下本地、无外网验证：

- TalorData 当前 `organic / sponsored_results / related` 响应解析测试；
- `organic_results / results / shopping_results` 兼容测试；
- 顶层数组、嵌套对象和 JSON 字符串包装测试；
- TalorData Provider 字段归一化测试；
- 仅 TalorData 时自动进入 `market-intelligence` 测试；
- 无任何 API 时自动进入 `demo` 测试；
- 三档模式判定与真实数据覆盖评分测试；
- Commerce 纯模块严格 TypeScript 编译检查。

压缩包未包含 `node_modules`，当前隔离环境也没有项目 ESLint 依赖，因此没有执行完整 `pnpm lint` 和 `pnpm build`。代码已按仓库的 Next.js ESLint / TypeScript 风格整理。替换后建议在项目依赖完整的环境执行：

```bash
pnpm install
pnpm lint
pnpm build
```

## 安全说明

交付包主动排除：

- `.env.local`
- `.env.sentry-build-plugin`
- `node_modules`
- `.next`
- `tsconfig.tsbuildinfo`

请继续在本地环境文件中保存真实 API Key，不要提交到版本库。
