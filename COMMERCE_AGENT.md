# Multi-agent Commerce Agent（v10）

## 1. 产品定位

Commerce 模块定位为 **AI 跨境市场机会分析助手**，而不是必须绑定 Amazon 店铺的卖家后台。

系统允许用户只配置 TalorData，也允许完全不配置外部市场 API：

- TalorData 提供真实公开 SERP / Shopping 市场信号；
- Amazon、Keepa、TikTok Shop、Temu、1688 作为可选增强来源；
- 所有真实来源均不可用时，使用醒目标记的模拟样本展示完整产品流程；
- 未配置或失败的数据源只降低覆盖度，不再直接中断报告。

## 2. 三档运行模式

### 2.1 完整研究模式 `full`

进入条件：

1. `market-search` 已取得真实公开市场数据；
2. Amazon、Keepa、TikTok Shop、Temu、1688 中至少一个增强来源取得真实样本。

输出可以进行多源交叉解释，但仍然只能引用实际返回的字段。没有销量、GMV、利润或供应链成本字段时，不得推测这些数据。

### 2.2 基础市场洞察模式 `market-intelligence`

进入条件：至少一个真实来源取得数据，但增强来源不足以形成多源研究。

最常见场景是用户只配置 TalorData。此时报告仍应正常完成，并输出：

- 公开搜索结果与 Shopping 可见度；
- 可见品牌、商家和域名结构；
- 可解析价格、评分与评论字段；
- 市场活跃度、竞争开放度、价格信号和继续研究建议。

该模式禁止把 SERP 数量写成真实销量、GMV、市场份额、利润率或供应链成本。

### 2.3 无 API 演示模式 `demo`

进入条件：所有真实来源均未取得任何可用样本。

系统调用 `DemoMarketProvider` 生成稳定、可重复、明确标记的模拟样本，使以下链路仍可完整验证：

```text
类目理解 → 数据归一化 → 指标计算 → UI 报告 → PDF 导出
```

演示模式的约束：

- 所有 observation / product 均带 `isDemo: true`；
- 报告设置 `runMode: "demo"`；
- UI、文本和 PDF 都显示醒目的模拟数据声明；
- 不调用 LLM 生成商业策略；
- 不运行月销量等启发式估算；
- 模拟数据绝不与真实数据混合。

## 3. 核心链路

```text
用户输入商品或类目
        ↓
LLM 类目理解与关键词规划
        ↓
真实数据源并行采集
TalorData / Amazon / Keepa / TikTok / Temu / 1688
        ↓
统一 CommerceMarketObservation / CommerceProductSignal
        ↓
判断运行模式
full / market-intelligence / demo
        ↓
确定性指标计算
        ↓
真实模式：受数据边界约束的 LLM 分析
演示模式：固定安全说明，不调用 LLM
        ↓
页面报告、文本报告与 PDF
```

## 4. TalorData 响应兼容修复

TalorData 不同引擎、版本或网关可能使用不同的结果字段，例如：

```text
organic
organic_results
results
shopping_results
sponsored_results
people_also_ask
related
```

也可能出现：

- 顶层数组；
- `data`、`result`、`response` 等对象包装；
- 内层 JSON 被再次编码为字符串；
- Web 与 Shopping 使用不同字段别名。

`providers/talordata-response.ts` 负责统一提取候选结果，
`providers/talordata-market-intelligence.ts` 再把候选结果归一化为项目类型。

连接测试不再只检查 HTTP 200，而是同时验证是否真正解析出搜索结果，避免出现“测试连接成功、实际研究无数据”的假阳性。

## 5. Provider 结构

```text
app/lib/commerce/
├── orchestrator/
│   └── data-source-orchestrator.ts
├── providers/
│   ├── talordata-client.ts
│   ├── talordata-response.ts             # TalorData schema 兼容层
│   ├── talordata-market-intelligence.ts  # 核心公开市场 Provider
│   ├── talordata-market.ts               # Amazon 公开可见度增强
│   ├── platform-serp.ts                   # TikTok / Temu / 1688 增强
│   ├── keepa.ts
│   ├── demo-market.ts                    # 无 API 演示 Provider
│   └── provider-health.ts
├── analytics.ts
├── llm.ts
├── report-html.ts
├── run-mode.ts
└── types.ts
```

## 6. 数据完成规则

真实模式满足以下任一条件即可继续：

- 至少取得一条真实 `CommerceMarketObservation`；
- 至少取得一个真实 `CommerceProductSignal`。

Amazon ASIN、BSR、Seller Central 授权、Keepa 或 1688 API 都不是报告完成的前置条件。

只有所有真实来源都没有数据时，才会进入演示模式。

## 7. TalorData 配置

```env
TALORDATA_API_TOKEN=sk_xxx

# 只有账号文档指定自定义地址时才覆盖
# TALORDATA_SERP_ENDPOINT=https://serpapi.talordata.net/serp/v1/request
```

旧变量 `SERPAPI_API_KEY` 仍保留兼容，但新部署应使用 `TALORDATA_API_TOKEN`。

## 8. 可选增强来源

```env
KEEPA_API_KEY=
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_MERCHANT_ID=
TEMU_APP_KEY=
TEMU_APP_SECRET=
TEMU_ACCESS_TOKEN=
ALIBABA_1688_APP_KEY=
ALIBABA_1688_APP_SECRET=
ALIBABA_1688_ACCESS_TOKEN=
```

这些来源未配置、无匹配结果或单次失败时，只记录为 `unconfigured`、`empty` 或 `error`，不会阻断其他来源。

## 9. 报告透明度

每份报告都必须展示：

- 当前运行模式；
- 每个来源的状态与样本量；
- 本轮真实数据覆盖评分；
- 实际可用字段；
- 缺失来源造成的限制；
- 演示模式下的醒目免责声明。

页面和 PDF 使用同一个 `CommerceResearchReport`，不得出现页面显示基础模式、PDF 却把缺失数据写成真实结论的情况。
