/**
 * 模块职责：数据质量、确定性洞察和来源置信度。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import type { CommerceDataProviderKind, CommerceMarketMetrics, CommerceProductSignal, CommerceResearchInsights, CommerceSourceReport } from "../types";
export function inferDataQuality(
  products: CommerceProductSignal[],
  provider: CommerceDataProviderKind,
): "high" | "medium" | "low" {
  if (!products.length) return "low";
  const rankCoverage =
    products.filter((product) => product.salesRank !== undefined).length /
    products.length;
  const marketSignalCoverage =
    products.filter(
      (product) =>
        product.price !== undefined ||
        product.rating !== undefined ||
        product.reviewCount !== undefined,
    ).length / products.length;

  if (provider === "amazon-sp-api" && rankCoverage >= 0.65) {
    return marketSignalCoverage >= 0.5 ? "high" : "medium";
  }

  const purchaseCoverage =
    products.filter((product) => product.recentPurchaseLowerBound !== undefined)
      .length / products.length;
  if (
    (provider === "serpapi-amazon" || provider === "talordata-amazon") &&
    marketSignalCoverage >= 0.8 &&
    purchaseCoverage >= 0.2
  ) {
    return "medium";
  }
  if (
    marketSignalCoverage >= 0.65 &&
    (rankCoverage >= 0.25 || purchaseCoverage >= 0.25)
  ) {
    return "medium";
  }
  return marketSignalCoverage >= 0.65 ? "medium" : "low";
}

/**
 * LLM 不可用时仍能给出不会编造销量的基础市场情报结论。
 * 这些文案只描述“公开市场信号”，不会把它写成最终选品/备货建议。
 */
export function buildDeterministicInsights(
  metrics: CommerceMarketMetrics,
): CommerceResearchInsights {
  const opportunities: string[] = [];
  const risks: string[] = [];
  const actions: string[] = [];

  if (metrics.demandScore >= 70) {
    opportunities.push("公开搜索与商业结果较丰富，当前类目具备继续研究的市场活跃度。 ");
  } else {
    risks.push("当前公开市场信号偏弱，建议扩大关键词和细分类目后再判断是否值得继续投入。 ");
  }

  if (metrics.competitionScore >= 65) {
    opportunities.push("公开结果来源相对分散，可以继续寻找细分定位、内容或渠道差异化机会。 ");
  } else {
    risks.push("公开可见竞争较集中，后续需要重点验证头部品牌与渠道壁垒。 ");
  }

  if (metrics.priceHealthScore >= 65) {
    opportunities.push("已取得一定价格样本，可继续做价格带和定位对比。 ");
  } else {
    risks.push("价格信号覆盖有限，本轮不适合做利润或采购决策。 ");
  }

  actions.push("继续比较 3–5 个核心关键词的 SERP / Shopping 重合度，确认稳定出现的品牌与产品方向。 ");
  actions.push("对公开结果中的高频卖点、价格带和竞品域名做二次拆解，形成差异化假设。 ");
  actions.push("在真正备货前，再补充销量历史、供应链成本、履约费用和广告成本等付费/授权数据。 ");

  return {
    summary:
      metrics.opportunityScore >= 75
        ? "公开市场信号显示该方向值得继续深挖，但当前结论属于市场情报初筛，不等同于最终选品结论。"
        : metrics.opportunityScore >= 60
          ? "当前方向存在一定市场信号，适合继续做细分类目和竞品验证；现阶段不建议直接据此备货。"
          : "当前公开数据对该方向的支持有限，建议先调整关键词或细分品类，再决定是否投入更深的数据验证。",
    opportunities: opportunities.map((item) => item.trim()),
    risks: risks.map((item) => item.trim()),
    actions: actions.map((item) => item.trim()),
  };
}

/**
 * 无真实数据演示模式使用的固定说明。
 *
 * 演示模式不会调用 LLM 生成商业判断，避免模型把模拟价格、评论或评分误写成真实结论。
 */
export function buildDemoInsights(
  categoryName: string,
): CommerceResearchInsights {
  return {
    summary: `当前未取得 ${categoryName} 的真实外部市场数据。本报告仅用于展示 Commerce Agent 的检索、归一化、评分、报告与 PDF 链路，不代表真实市场机会。`,
    opportunities: [
      "可验证在没有 TalorData、Amazon、Keepa 或供应链 API 时，产品流程仍能完整运行。",
      "接入任意真实数据源后，系统会自动退出演示模式并重新计算实际市场信号。",
    ],
    risks: [
      "所有样本、价格、评论与评分均为模拟内容，不能用于选品、采购、定价或广告决策。",
      "当前数据覆盖可信度为 0，任何商业判断都需要真实公开数据或平台授权数据支持。",
    ],
    actions: [
      "优先配置 TalorData，以进入基础市场洞察模式并获取真实公开 SERP / Shopping 数据。",
      "按需要连接 Keepa、Amazon 或 1688 等增强来源，以进入完整研究模式。",
      "接入真实数据后重新运行同一研究任务，不要沿用本次演示评分。",
    ],
  };
}

/**
 * 根据各数据源是否真正返回数据计算“本轮数据覆盖可信度”。
 * 这是数据覆盖评分，不是 LLM 自信程度；未配置或失败的来源会明确降低分数。
 */
export function calculateSourceConfidence(sources: CommerceSourceReport[]): number {
  const weights: Record<CommerceSourceReport["id"], number> = {
    // 公开 SERP 是 v10 的核心真实来源；只要它完整可用，就能形成一份可交付的市场情报报告。
    "market-search": 60,
    amazon: 10,
    keepa: 10,
    "tiktok-shop": 8,
    temu: 5,
    "1688": 7,
  };

  return Math.round(
    sources.reduce((total, source) => {
      const weight = weights[source.id] || 0;
      const statusFactor =
        source.status === "collected"
          ? 1
          : source.status === "partial"
            ? 0.65
            : source.status === "empty"
              ? 0.25
              : 0;
      const qualityFactor =
        source.quality === "high"
          ? 1
          : source.quality === "medium"
            ? 0.85
            : source.quality === "low"
              ? 0.65
              : 0;
      return total + weight * statusFactor * qualityFactor;
    }, 0),
  );
}
