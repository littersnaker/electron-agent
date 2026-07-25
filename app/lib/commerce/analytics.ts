import type {
  CommerceDataProviderKind,
  CommerceMarketMetrics,
  CommerceMarketObservation,
  CommercePlatformComparison,
  CommerceProductSignal,
  CommerceResearchInsights,
  CommerceSourceReport,
} from "./types";

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * 根据 BSR / Sales Rank 生成保守的月销量区间。
 *
 * 这里明确是启发式模型，不把估算值伪装成 Amazon 官方成交量。
 * 后续若接入 Keepa、品牌分析或自有历史校准数据，只需替换该函数即可。
 */
export function estimateMonthlyUnitsFromRank(
  rank: number | undefined,
): CommerceProductSignal["estimatedMonthlyUnits"] {
  if (!rank || rank <= 0) return undefined;

  let medianUnits: number;
  if (rank <= 100) medianUnits = 5200;
  else if (rank <= 500) medianUnits = 2600;
  else if (rank <= 1_000) medianUnits = 1600;
  else if (rank <= 5_000) medianUnits = 720;
  else if (rank <= 10_000) medianUnits = 360;
  else if (rank <= 50_000) medianUnits = 110;
  else if (rank <= 100_000) medianUnits = 48;
  else medianUnits = 18;

  return {
    low: Math.max(1, Math.round(medianUnits * 0.55)),
    median: medianUnits,
    high: Math.round(medianUnits * 1.7),
    confidence: rank <= 10_000 ? "medium" : "low",
  };
}

function demandScoreFromSignals(products: CommerceProductSignal[]): number {
  const ranks = products.flatMap((product) =>
    typeof product.salesRank === "number" ? [product.salesRank] : [],
  );
  const purchases = products.flatMap((product) =>
    (!product.platform || product.platform === "amazon") &&
    typeof product.recentPurchaseLowerBound === "number"
      ? [product.recentPurchaseLowerBound]
      : [],
  );
  const reviews = products.flatMap((product) =>
    typeof product.reviewCount === "number" ? [product.reviewCount] : [],
  );
  const rankMedian = median(ranks);
  const purchaseMedian = median(purchases);
  const reviewMedian = median(reviews);

  let rankScore = 55;
  if (rankMedian !== undefined) {
    if (rankMedian <= 500) rankScore = 95;
    else if (rankMedian <= 2_000) rankScore = 88;
    else if (rankMedian <= 5_000) rankScore = 81;
    else if (rankMedian <= 10_000) rankScore = 73;
    else if (rankMedian <= 30_000) rankScore = 63;
    else if (rankMedian <= 100_000) rankScore = 49;
    else rankScore = 34;
  }

  let purchaseScore = 55;
  if (purchaseMedian !== undefined) {
    if (purchaseMedian >= 10_000) purchaseScore = 98;
    else if (purchaseMedian >= 5_000) purchaseScore = 93;
    else if (purchaseMedian >= 2_000) purchaseScore = 86;
    else if (purchaseMedian >= 1_000) purchaseScore = 80;
    else if (purchaseMedian >= 500) purchaseScore = 72;
    else if (purchaseMedian >= 200) purchaseScore = 64;
    else if (purchaseMedian >= 50) purchaseScore = 55;
    else purchaseScore = 44;
  }

  let reviewScore = 55;
  if (reviewMedian !== undefined) {
    reviewScore = clamp(38 + Math.log10(Math.max(1, reviewMedian)) * 17);
  }

  // “过去一个月购买”是公开搜索结果中的直接需求信号；没有它时再依赖 BSR。
  // 这样无 Seller 店铺的公开市场数据也能得到可解释的需求评分，而不是只看评论存量。
  if (purchaseMedian !== undefined) {
    return round(
      purchaseScore * 0.7 +
        (rankMedian !== undefined ? rankScore * 0.2 : 0) +
        reviewScore * (rankMedian !== undefined ? 0.1 : 0.3),
    );
  }

  return round(
    rankMedian !== undefined ? rankScore * 0.8 + reviewScore * 0.2 : reviewScore,
  );
}

function competitionFriendlinessScore(
  products: CommerceProductSignal[],
  topBrandShare: number | undefined,
): number {
  const reviews = products.flatMap((product) =>
    typeof product.reviewCount === "number" ? [product.reviewCount] : [],
  );
  const ratings = products.flatMap((product) =>
    typeof product.rating === "number" ? [product.rating] : [],
  );
  const reviewMedian = median(reviews);
  const ratingMedian = median(ratings);

  let reviewBarrier = 50;
  if (reviewMedian !== undefined) {
    if (reviewMedian <= 100) reviewBarrier = 88;
    else if (reviewMedian <= 300) reviewBarrier = 76;
    else if (reviewMedian <= 1_000) reviewBarrier = 61;
    else if (reviewMedian <= 3_000) reviewBarrier = 45;
    else reviewBarrier = 28;
  }

  const brandScore =
    topBrandShare === undefined ? 55 : clamp(100 - topBrandShare * 100 * 1.15);
  const ratingScore =
    ratingMedian === undefined
      ? 55
      : ratingMedian >= 4.7
        ? 34
        : ratingMedian >= 4.5
          ? 44
          : ratingMedian >= 4.2
            ? 58
            : 68;

  return round(reviewBarrier * 0.55 + brandScore * 0.3 + ratingScore * 0.15);
}

function priceHealthScore(products: CommerceProductSignal[]): number {
  const prices = products.flatMap((product) =>
    typeof product.price === "number" ? [product.price] : [],
  );
  const priceMedian = median(prices);
  if (priceMedian === undefined) return 55;

  // 跨品类通用的初筛分，不代表利润率；真正利润分析需叠加采购、FBA、广告与退货成本。
  if (priceMedian >= 25 && priceMedian <= 80) return 82;
  if (priceMedian >= 15 && priceMedian < 25) return 70;
  if (priceMedian > 80 && priceMedian <= 180) return 72;
  if (priceMedian < 15) return 48;
  return 58;
}

function computeTopBrandShare(products: CommerceProductSignal[]): number | undefined {
  const brands = products
    .map((product) => product.brand?.trim().toLowerCase())
    .filter((brand): brand is string => Boolean(brand));
  if (!brands.length) return undefined;

  const counts = new Map<string, number>();
  for (const brand of brands) {
    counts.set(brand, (counts.get(brand) || 0) + 1);
  }
  const top = Math.max(...counts.values());
  return round(top / brands.length, 3);
}

const PLATFORM_LABELS: Record<string, string> = {
  amazon: "Amazon",
  "tiktok-shop": "TikTok Shop",
  temu: "Temu",
  "1688": "1688",
  "market-search": "公开市场",
};

function dominantCurrency(
  products: CommerceProductSignal[],
): string | undefined {
  const counts = new Map<string, number>();
  for (const product of products) {
    if (product.price === undefined || !product.currency) continue;
    counts.set(product.currency, (counts.get(product.currency) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0];
}

/**
 * 按平台独立统计价格、评分与评论，避免跨币种价格直接混算。
 * 这里只比较采集到的公开样本，不把样本占比解释成平台市场份额。
 */
function buildPlatformComparisons(
  products: CommerceProductSignal[],
): CommercePlatformComparison[] {
  const groups = new Map<string, CommerceProductSignal[]>();
  for (const product of products) {
    const platform = product.platform || "amazon";
    groups.set(platform, [...(groups.get(platform) || []), product]);
  }

  return Array.from(groups.entries())
    .map(([platform, items]) => {
      const currency = dominantCurrency(items);
      const prices = items.flatMap((item) =>
        item.price !== undefined && (!currency || item.currency === currency)
          ? [item.price]
          : [],
      );
      const ratings = items.flatMap((item) =>
        item.rating !== undefined ? [item.rating] : [],
      );
      const reviews = items.flatMap((item) =>
        item.reviewCount !== undefined ? [item.reviewCount] : [],
      );
      return {
        platform: platform as CommercePlatformComparison["platform"],
        label: PLATFORM_LABELS[platform] || platform,
        sampleSize: items.length,
        priceSampleSize: prices.length,
        medianPrice: prices.length ? round(median(prices) || 0, 2) : undefined,
        currency,
        medianRating: ratings.length ? round(median(ratings) || 0, 2) : undefined,
        medianReviewCount: reviews.length
          ? round(median(reviews) || 0)
          : undefined,
        topBrandShare: computeTopBrandShare(items),
      };
    })
    .sort((left, right) => right.sampleSize - left.sampleSize);
}

export function enrichProductsWithEstimates(
  products: CommerceProductSignal[],
): CommerceProductSignal[] {
  return products.map((product) => {
    if (product.estimatedMonthlyUnits) return product;

    // TikTok Shop、Temu 与 1688 的“已售”通常不是月度口径，不能套用 Amazon 月销量模型。
    if (product.platform && product.platform !== "amazon") return product;

    const rankEstimate = estimateMonthlyUnitsFromRank(product.salesRank);
    const publicLowerBound = product.recentPurchaseLowerBound;

    // Amazon 公开展示的“X+ bought in past month”虽然只是下限，但比纯 BSR 推算更直接。
    // 如果两者同时存在，则用公开购买下限校正区间，仍明确标注为估算而非官方成交量。
    if (publicLowerBound && publicLowerBound > 0) {
      const median = Math.max(
        Math.round(publicLowerBound * 1.25),
        rankEstimate?.median || 0,
      );
      return {
        ...product,
        estimatedMonthlyUnits: {
          low: publicLowerBound,
          median,
          high: Math.max(
            Math.round(publicLowerBound * 2.2),
            rankEstimate?.high || 0,
          ),
          confidence: "medium",
          basis: "public-purchase-signal",
        },
      };
    }

    return {
      ...product,
      estimatedMonthlyUnits: rankEstimate
        ? { ...rankEstimate, basis: "sales-rank" }
        : undefined,
    };
  });
}

export function calculateMarketMetrics(
  products: CommerceProductSignal[],
): CommerceMarketMetrics {
  const enriched = enrichProductsWithEstimates(products);
  const currency = dominantCurrency(enriched);
  const prices = enriched.flatMap((product) =>
    typeof product.price === "number" &&
    (!currency || !product.currency || product.currency === currency)
      ? [product.price]
      : [],
  );
  const ranks = enriched.flatMap((product) =>
    typeof product.salesRank === "number" ? [product.salesRank] : [],
  );
  const reviews = enriched.flatMap((product) =>
    typeof product.reviewCount === "number" ? [product.reviewCount] : [],
  );
  const estimates = enriched.flatMap((product) =>
    product.estimatedMonthlyUnits ? [product.estimatedMonthlyUnits] : [],
  );
  const topBrandShare = computeTopBrandShare(enriched);
  const demandScore = demandScoreFromSignals(enriched);
  const competitionScore = competitionFriendlinessScore(
    enriched,
    topBrandShare,
  );
  const priceScore = priceHealthScore(
    enriched.filter(
      (product) =>
        product.price === undefined ||
        !currency ||
        !product.currency ||
        product.currency === currency,
    ),
  );
  const newEntryScore = round(
    competitionScore * 0.55 + priceScore * 0.25 + demandScore * 0.2,
  );
  const opportunityScore = round(
    demandScore * 0.35 +
      competitionScore * 0.3 +
      priceScore * 0.15 +
      newEntryScore * 0.2,
  );

  return {
    sampleSize: enriched.length,
    opportunityScore,
    demandScore,
    competitionScore,
    priceHealthScore: priceScore,
    newEntryScore,
    medianPrice: prices.length ? round(median(prices) || 0, 2) : undefined,
    currency,
    medianSalesRank: ranks.length ? round(median(ranks) || 0) : undefined,
    medianReviewCount: reviews.length ? round(median(reviews) || 0) : undefined,
    topBrandShare,
    estimatedMonthlyUnits: estimates.length
      ? {
          low: estimates.reduce((sum, value) => sum + value.low, 0),
          median: estimates.reduce((sum, value) => sum + value.median, 0),
          high: estimates.reduce((sum, value) => sum + value.high, 0),
        }
      : undefined,
    platformComparisons: buildPlatformComparisons(enriched),
  };
}


/**
 * 使用公开 SERP observations 计算“市场情报”指标。
 *
 * 这些分数刻意不把 SERP 数量解释成真实搜索量或销量：
 * - 市场活跃度：结果丰富度 + Shopping / 广告等商业化信号；
 * - 竞争开放度：域名分散度越高，说明公开可见竞争并非被单一站点垄断；
 * - 价格信号：可解析价格的覆盖与样本数量；
 * - 进入研究度：是否值得继续投入 Keepa / 供应链 / 平台付费数据做下一轮验证。
 */
export function calculateMarketIntelligenceMetrics(
  products: CommerceProductSignal[],
  observations: CommerceMarketObservation[],
): CommerceMarketMetrics {
  if (products.length >= 5) {
    const productMetrics = calculateMarketMetrics(products);
    return {
      ...productMetrics,
      observationCount: observations.length,
      shoppingResultCount: observations.filter((item) => item.resultType === "shopping").length,
      uniqueDomainCount: new Set(observations.map((item) => item.domain).filter(Boolean)).size,
      priceSignalCount: observations.filter((item) => item.price !== undefined).length,
    };
  }

  const valid = observations.filter((item) => item.title.trim());
  const shopping = valid.filter((item) => item.resultType === "shopping");
  const ads = valid.filter((item) => item.resultType === "ad");
  const prices = valid.flatMap((item) =>
    typeof item.price === "number" ? [item.price] : [],
  );
  const reviews = valid.flatMap((item) =>
    typeof item.reviewCount === "number" ? [item.reviewCount] : [],
  );
  const domains = valid
    .map((item) => item.domain?.trim().toLowerCase())
    .filter((domain): domain is string => Boolean(domain));
  const domainCounts = new Map<string, number>();
  for (const domain of domains) {
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
  }
  const topDomainCount = domainCounts.size
    ? Math.max(...domainCounts.values())
    : 0;
  const topDomainShare = domains.length ? topDomainCount / domains.length : undefined;
  const uniqueDomainCount = domainCounts.size;

  const resultRichness = clamp(30 + Math.min(45, valid.length * 1.8));
  const commerceSignal = valid.length
    ? clamp(((shopping.length + ads.length) / valid.length) * 100)
    : 0;
  const demandScore = round(resultRichness * 0.72 + commerceSignal * 0.28);

  const diversityScore = domains.length
    ? clamp((uniqueDomainCount / domains.length) * 140)
    : 45;
  const concentrationPenalty = topDomainShare === undefined
    ? 15
    : clamp(topDomainShare * 70);
  const competitionScore = round(clamp(55 + diversityScore * 0.45 - concentrationPenalty));

  const priceCoverage = valid.length ? prices.length / valid.length : 0;
  const priceHealthScore = round(
    prices.length >= 5
      ? clamp(55 + priceCoverage * 40)
      : prices.length
        ? clamp(42 + priceCoverage * 35)
        : 38,
  );

  const newEntryScore = round(
    demandScore * 0.35 + competitionScore * 0.35 + priceHealthScore * 0.3,
  );
  const opportunityScore = round(
    demandScore * 0.4 + competitionScore * 0.35 + priceHealthScore * 0.1 + newEntryScore * 0.15,
  );
  const currency = valid.find((item) => item.currency)?.currency;

  return {
    sampleSize: Math.max(products.length, valid.length),
    opportunityScore,
    demandScore,
    competitionScore,
    priceHealthScore,
    newEntryScore,
    medianPrice: prices.length ? round(median(prices) || 0, 2) : undefined,
    currency,
    medianReviewCount: reviews.length ? round(median(reviews) || 0) : undefined,
    observationCount: valid.length,
    shoppingResultCount: shopping.length,
    uniqueDomainCount,
    topDomainShare: topDomainShare === undefined ? undefined : round(topDomainShare, 3),
    priceSignalCount: prices.length,
    platformComparisons: buildPlatformComparisons(products),
  };
}

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
