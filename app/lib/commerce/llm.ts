import { z } from "zod";
import { completeWithLlm } from "../llm/gateway";
import type { LlmCredentials, LlmTokenUsage } from "../llm/types";
import { getCommerceMarketplace } from "./marketplaces";
import type {
  CommerceCategoryResolution,
  CommerceMarketMetrics,
  CommerceMarketObservation,
  CommerceMarketplaceCode,
  CommerceProductSignal,
  CommerceResearchInsights,
  CommerceRunMode,
  CommerceSourceReport,
} from "./types";

const categorySchema = z.object({
  categoryName: z.string().min(1),
  categoryNameEn: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1).max(8),
  subcategories: z.array(z.string().min(1)).max(8).default([]),
  analysisDimensions: z.array(z.string().min(1)).min(1).max(8),
  researchGoal: z.string().min(1),
});

const insightsSchema = z.object({
  summary: z.string().min(1),
  opportunities: z.array(z.string().min(1)).max(6),
  risks: z.array(z.string().min(1)).max(6),
  actions: z.array(z.string().min(1)).max(6),
});

function extractJsonObject(value: string): unknown {
  const trimmed = value.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error("LLM 未返回可解析的 JSON 对象");
  }
  return JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1)) as unknown;
}

function usageFromResponse(response: Awaited<ReturnType<typeof completeWithLlm>>): LlmTokenUsage {
  return {
    prompt: response.usage?.prompt_tokens || 0,
    completion: response.usage?.completion_tokens || 0,
    total: response.usage?.total_tokens || 0,
  };
}

export interface CommerceLlmResult<T> {
  value: T;
  usage: LlmTokenUsage;
}

/**
 * 将“宠物喝水的机器”之类的宽泛描述解析成可执行的跨境市场研究计划。
 * LLM 只负责语义理解和关键词规划；公开 SERP 数据由 Provider 获取，数值分析由确定性代码计算。
 */
export async function resolveCommerceCategory(input: {
  query: string;
  marketplace: CommerceMarketplaceCode;
  recentContext?: Array<{ role: "user" | "assistant"; content: string }>;
  credentials: LlmCredentials;
  preferredModelId?: string;
  signal?: AbortSignal;
}): Promise<CommerceLlmResult<CommerceCategoryResolution>> {
  const marketplace = getCommerceMarketplace(input.marketplace);
  const context = (input.recentContext || [])
    .slice(-6)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  const response = await completeWithLlm({
    task: "commerce_intent",
    preferredModelId: input.preferredModelId,
    credentials: input.credentials,
    signal: input.signal,
    requiredCapabilities: ["structured_output"],
    messages: [
      {
        role: "system",
        content: [
          "你是跨境电商市场研究的类目解析 Agent。",
          "把用户的宽泛商品描述转换为跨境公开市场检索计划。",
          "只返回 JSON，不要 Markdown，不要解释。",
          "keywords 必须适合目标站点真实搜索，可使用目标站点当地语言；categoryNameEn 保留英文规范类目名称。",
          "不要假设用户拥有 Amazon / Keepa / TikTok Shop 等付费 API；核心计划必须能仅靠公开市场 SERP 执行。",
          "JSON 字段固定为 categoryName, categoryNameEn, keywords, subcategories, analysisDimensions, researchGoal。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `目标站点：${marketplace.label} (${marketplace.code}, ${marketplace.locale})`,
          `用户需求：${input.query}`,
          context ? `最近上下文：\n${context}` : "",
          "请输出 3-8 个高相关检索关键词，并把研究目标归纳为一句话。",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });

  const content = response.choices[0]?.message.content || "";
  const value = categorySchema.parse(extractJsonObject(content));
  return { value, usage: usageFromResponse(response) };
}

function compactProduct(product: CommerceProductSignal): Record<string, unknown> {
  return {
    id: product.asin,
    platform: product.platform || "amazon",
    title: product.title,
    brand: product.brand,
    price: product.price,
    currency: product.currency,
    rating: product.rating,
    reviewCount: product.reviewCount,
    salesRank: product.salesRank,
    salesRankCategory: product.salesRankCategory,
    estimatedMonthlyUnits: product.estimatedMonthlyUnits,
    badges: product.badges,
    bulletPoints: product.bulletPoints?.slice(0, 5),
  };
}

/**
 * 让 LLM 解释“已经算好的”市场指标，而不是让 LLM 自己做算术。
 * 这能减少幻觉，也让 Opportunity Score 与界面展示保持完全一致。
 */
export async function generateCommerceInsights(input: {
  query: string;
  marketplace: CommerceMarketplaceCode;
  category: CommerceCategoryResolution;
  metrics: CommerceMarketMetrics;
  products: CommerceProductSignal[];
  observations?: CommerceMarketObservation[];
  sources?: CommerceSourceReport[];
  runMode: CommerceRunMode;
  credentials: LlmCredentials;
  preferredModelId?: string;
  signal?: AbortSignal;
}): Promise<CommerceLlmResult<CommerceResearchInsights>> {
  const marketplace = getCommerceMarketplace(input.marketplace);
  const response = await completeWithLlm({
    task: "commerce_analysis",
    preferredModelId: input.preferredModelId,
    credentials: input.credentials,
    signal: input.signal,
    requiredCapabilities: ["reasoning", "structured_output"],
    messages: [
      {
        role: "system",
        content: [
          "你是 Cross-border Market Intelligence Agent，负责解释公开市场 SERP、Shopping 与可选平台增强数据。",
          "Amazon 商品样本可能来自 API，也可能来自公开页面爬虫；必须以 sources 中的 amazonDataRoute 和 provider 为准。",
          "即使没有 Amazon、Keepa、TikTok Shop、Temu、1688 的付费 API，也必须基于已取得的公开市场或爬虫数据完成一份市场情报初筛。",
          "你只能解释输入中已经给出的数据，不得编造真实搜索量、成交量、GMV、利润率、CPC 或平台私有字段。",
          "market observations 代表公开搜索可见度，不代表真实销量或平台市场份额。Amazon 爬虫字段同样只代表采集时公开可见的信息。",
          "estimatedMonthlyUnits 只有在输入真的存在时才可引用，并必须当作启发式区间而非平台官方销量。",
          "sources 会明确标记每个平台 collected/partial/unconfigured/empty/error/demo；严禁对未获取的数据源做事实性结论。",
          input.runMode === "full"
            ? "当前为完整研究模式：允许交叉解释多个真实来源，但仍只能引用输入中实际存在的字段。"
            : input.runMode === "market-intelligence"
              ? "当前为基础市场洞察模式：禁止推断真实销量、GMV、市场份额、利润或供应链成本。"
              : "当前为演示模式：所有数据都是模拟内容，只能说明流程，不得输出任何真实商业判断。",
          "综合结论必须区分：已获取数据支持的判断、缺失数据造成的不确定性、下一步需要补的来源。",
          "只返回 JSON，不要 Markdown。",
          "JSON 字段固定为 summary, opportunities, risks, actions，每个数组最多 6 项。",
          "建议必须具体、可执行，优先告诉运营下一步该验证什么。",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            userQuery: input.query,
            marketplace: marketplace.label,
            category: input.category,
            runMode: input.runMode,
            metrics: input.metrics,
            dataSources: input.sources || [],
            topProducts: input.products.slice(0, 16).map(compactProduct),
            marketObservations: (input.observations || []).slice(0, 24),
          },
          null,
          2,
        ),
      },
    ],
  });

  const content = response.choices[0]?.message.content || "";
  const value = insightsSchema.parse(extractJsonObject(content));
  return { value, usage: usageFromResponse(response) };
}
