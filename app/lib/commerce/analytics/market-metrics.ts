/**
 * 模块职责：商品估算、市场指标和情报指标计算。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import type { CommerceMarketMetrics, CommerceMarketObservation, CommerceProductSignal } from "../types";
import { buildPlatformComparisons, clamp, competitionFriendlinessScore, computeTopBrandShare, demandScoreFromSignals, dominantCurrency, estimateMonthlyUnitsFromRank, median, priceHealthScore, round } from "./market-statistics";
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
