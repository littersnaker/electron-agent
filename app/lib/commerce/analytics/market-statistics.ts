/**
 * 模块职责：市场统计工具、需求评分与平台对比。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import type { CommercePlatformComparison, CommerceProductSignal } from "../types";
export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function median(values: number[]): number | undefined {
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

export function demandScoreFromSignals(products: CommerceProductSignal[]): number {
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

export function competitionFriendlinessScore(
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

export function priceHealthScore(products: CommerceProductSignal[]): number {
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

export function computeTopBrandShare(products: CommerceProductSignal[]): number | undefined {
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

export const PLATFORM_LABELS: Record<string, string> = {
  amazon: "Amazon",
  "tiktok-shop": "TikTok Shop",
  temu: "Temu",
  "1688": "1688",
  "market-search": "公开市场",
};

export function dominantCurrency(
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
export function buildPlatformComparisons(
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
