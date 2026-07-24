import { calculateMarketMetrics, inferDataQuality } from "../analytics";
import { inferCommerceRunMode } from "../run-mode";
import type {
  CommerceMarketObservation,
  CommerceMarketSourceId,
  CommerceProductSignal,
  CommerceRunMode,
  CommerceSourceReport,
} from "../types";
import { AmazonPublicPageProvider } from "../providers/amazon-public-page";
import { DemoMarketProvider } from "../providers/demo-market";
import { KeepaProvider } from "../providers/keepa";
import {
  PLATFORM_SERP_CONFIGS,
  PlatformSerpProvider,
} from "../providers/platform-serp";
import { TalorDataMarketIntelligenceProvider } from "../providers/talordata-market-intelligence";
import { TalorDataMarketProvider } from "../providers/talordata-market";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
} from "../providers/types";

export interface CommerceOrchestrationResult {
  products: CommerceProductSignal[];
  observations: CommerceMarketObservation[];
  sources: CommerceSourceReport[];
  warnings: string[];
  runMode: CommerceRunMode;
}

const SOURCE_LABELS: Record<CommerceMarketSourceId, string> = {
  "market-search": "公开市场 SERP",
  amazon: "Amazon 公开结果",
  keepa: "Keepa",
  "tiktok-shop": "TikTok Shop",
  temu: "Temu",
  "1688": "1688",
};

function reportFromResult(
  sourceId: CommerceMarketSourceId,
  result: Awaited<ReturnType<CommerceDataProvider["searchProducts"]>>,
): CommerceSourceReport {
  const products = result.products;
  const observations = result.observations || [];
  const sampleSize = Math.max(products.length, observations.length);
  const isDemo = result.provider === "demo-market";
  const quality = isDemo
    ? "unavailable"
    : products.length
      ? inferDataQuality(products, result.provider)
      : observations.length >= 12
        ? "medium"
        : observations.length
          ? "low"
          : "unavailable";
  const metrics = !isDemo && products.length
    ? calculateMarketMetrics(products)
    : undefined;

  let metricSummary = "数据源已连接，但本轮没有返回可用于该类目的样本。";
  if (isDemo) {
    metricSummary = `已生成 ${sampleSize} 条明确标记的模拟样本，仅用于展示完整研究流程。`;
  } else if (observations.length) {
    const shoppingCount = observations.filter(
      (item) => item.resultType === "shopping",
    ).length;
    const domainCount = new Set(
      observations.map((item) => item.domain).filter(Boolean),
    ).size;
    metricSummary = `已获取 ${observations.length} 条公开市场结果；Shopping ${shoppingCount} 条；覆盖 ${domainCount} 个可识别域名。`;
  } else if (products.length) {
    metricSummary = [
      `已获取 ${products.length} 个可用样本`,
      metrics?.medianPrice !== undefined
        ? `中位价格 ${metrics.currency || ""} ${metrics.medianPrice}`.trim()
        : "价格覆盖不足",
      metrics?.medianReviewCount !== undefined
        ? `中位评论 ${metrics.medianReviewCount}`
        : "评论覆盖不足",
    ].join("；");
  }

  return {
    id: sourceId,
    label: SOURCE_LABELS[sourceId],
    status: isDemo
      ? "demo"
      : sampleSize
        ? quality === "low"
          ? "partial"
          : "collected"
        : "empty",
    provider: result.provider,
    quality,
    sampleSize,
    coverage: result.coverage || [],
    summary: metricSummary,
    warnings: result.warnings,
    metrics,
  };
}

async function collectOne(
  sourceId: CommerceMarketSourceId,
  provider: CommerceDataProvider,
  input: CommerceProviderSearchInput,
): Promise<{
  report: CommerceSourceReport;
  products: CommerceProductSignal[];
  observations: CommerceMarketObservation[];
}> {
  if (!provider.isConfigured()) {
    return {
      report: {
        id: sourceId,
        label: SOURCE_LABELS[sourceId],
        status: "unconfigured",
        quality: "unavailable",
        sampleSize: 0,
        coverage: [],
        summary:
          sourceId === "market-search"
            ? "未配置 TalorData，本轮会在所有真实来源都不可用时自动进入无 API 演示模式。"
            : "当前没有配置这个增强数据源，本轮不会等待它，也不会因此中断报告。",
        warnings: [],
      },
      products: [],
      observations: [],
    };
  }

  try {
    const result = await provider.searchProducts(input);
    return {
      report: reportFromResult(sourceId, result),
      products: result.products,
      observations: result.observations || [],
    };
  } catch (error) {
    return {
      report: {
        id: sourceId,
        label: SOURCE_LABELS[sourceId],
        status: "error",
        quality: "unavailable",
        sampleSize: 0,
        coverage: [],
        summary:
          sourceId === "market-search"
            ? "核心公开市场来源获取失败；若其他真实来源也没有数据，系统会自动进入演示模式。"
            : "本轮该增强来源获取失败，因此没有使用它生成事实性结论。",
        warnings: [],
        error: error instanceof Error ? error.message : String(error),
      },
      products: [],
      observations: [],
    };
  }
}

function mergeProductSignals(
  products: CommerceProductSignal[],
): CommerceProductSignal[] {
  const map = new Map<string, CommerceProductSignal>();
  for (const product of products) {
    const key = `${product.platform || "amazon"}:${product.asin}`;
    const current = map.get(key);
    map.set(
      key,
      current
        ? {
            ...current,
            ...product,
            price: product.price ?? current.price,
            rating: product.rating ?? current.rating,
            reviewCount: product.reviewCount ?? current.reviewCount,
            salesRank: product.salesRank ?? current.salesRank,
            recentPurchaseLowerBound:
              product.recentPurchaseLowerBound ??
              current.recentPurchaseLowerBound,
            recentPurchaseLabel:
              product.recentPurchaseLabel ?? current.recentPurchaseLabel,
          }
        : product,
    );
  }
  return Array.from(map.values());
}

function mergeObservations(
  observations: CommerceMarketObservation[],
): CommerceMarketObservation[] {
  return Array.from(
    new Map(observations.map((item) => [item.id, item])).values(),
  );
}

function collectWarnings(sources: CommerceSourceReport[]): string[] {
  return Array.from(
    new Set(
      sources.flatMap((source) => [
        ...source.warnings.map((warning) => `${source.label}: ${warning}`),
        ...(source.error ? [`${source.label}: ${source.error}`] : []),
      ]),
    ),
  );
}

/**
 * Cross-border Market Intelligence Orchestrator。
 *
 * 三档运行原则：
 * 1. 完整研究模式：TalorData 公开市场数据 + 至少一个真实增强来源；
 * 2. 基础市场洞察模式：至少一个真实来源有数据，但增强覆盖不足；
 * 3. 无 API 演示模式：所有真实来源均无数据时，使用明确标记的模拟样本走完整流程。
 *
 * Amazon / Keepa / TikTok Shop / Temu / 1688 永远不是主流程的硬前置条件。
 */
export async function collectMultiSourceMarketData(
  input: CommerceProviderSearchInput,
): Promise<CommerceOrchestrationResult> {
  const talorDataToken =
    input.serviceCredentials?.talorDataToken ||
    input.serviceCredentials?.serpApi ||
    input.serpApiKey;

  const marketSearch = new TalorDataMarketIntelligenceProvider(talorDataToken);
  const amazonPublicSearch = new TalorDataMarketProvider(talorDataToken);
  const keepa = new KeepaProvider(input.serviceCredentials?.keepaApiKey);
  const platformProviders = PLATFORM_SERP_CONFIGS.map((config) => ({
    sourceId: config.sourceId,
    provider: new PlatformSerpProvider(config, talorDataToken),
  }));

  // 所有真实来源并行执行。任何单个来源失败都只影响其自身状态。
  const tasks = [
    collectOne("market-search", marketSearch, input),
    collectOne("amazon", amazonPublicSearch, input),
    collectOne("keepa", keepa, input),
    ...platformProviders.map(({ sourceId, provider }) =>
      collectOne(sourceId, provider, input),
    ),
  ];
  const results = await Promise.all(tasks);

  // 只有 Amazon 公开结果失败时才尝试直接页面作为 best-effort 增强。
  // 这个 fallback 永远不会影响核心报告是否可以完成。
  const amazonIndex = results.findIndex(
    (item) => item.report.id === "amazon",
  );
  if (
    amazonIndex >= 0 &&
    results[amazonIndex].report.status === "error" &&
    process.env.AMAZON_PUBLIC_RESEARCH_ENABLED === "true"
  ) {
    const publicPage = new AmazonPublicPageProvider();
    if (publicPage.isConfigured()) {
      try {
        const fallback = await publicPage.searchProducts(input);
        if (fallback.products.length) {
          results[amazonIndex] = {
            products: fallback.products,
            observations: fallback.observations || [],
            report: {
              ...reportFromResult("amazon", fallback),
              summary: `TalorData 没有解析出 Amazon 结构化商品，已降级到 Amazon 公开页面并取得 ${fallback.products.length} 个增强样本。`,
              warnings: [
                results[amazonIndex].report.error ||
                  "Amazon 公开搜索增强失败",
                ...fallback.warnings,
              ],
            },
          };
        }
      } catch (error) {
        results[amazonIndex].report.warnings.push(
          `Amazon 页面备用增强源也失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const realProducts = mergeProductSignals(
    results.flatMap((item) => item.products),
  );
  const realObservations = mergeObservations(
    results.flatMap((item) => item.observations),
  );
  const hasRealData = realProducts.length > 0 || realObservations.length > 0;

  if (hasRealData) {
    const sources = results.map((item) => item.report);
    return {
      products: realProducts,
      observations: realObservations,
      sources,
      warnings: collectWarnings(sources),
      runMode: inferCommerceRunMode(sources),
    };
  }

  // 所有真实来源都没有数据时才进入 Demo，确保模拟数据不会与真实市场事实混合。
  const demoResult = await new DemoMarketProvider().searchProducts(input);
  const marketSearchIndex = results.findIndex(
    (item) => item.report.id === "market-search",
  );
  const previousMarketReport =
    marketSearchIndex >= 0 ? results[marketSearchIndex].report : undefined;
  const demoReport = reportFromResult("market-search", demoResult);
  demoReport.warnings = [
    ...(previousMarketReport?.error
      ? [`真实 TalorData 诊断：${previousMarketReport.error}`]
      : []),
    ...demoReport.warnings,
  ];

  if (marketSearchIndex >= 0) {
    results[marketSearchIndex] = {
      report: demoReport,
      products: demoResult.products,
      observations: demoResult.observations || [],
    };
  } else {
    results.unshift({
      report: demoReport,
      products: demoResult.products,
      observations: demoResult.observations || [],
    });
  }

  const sources = results.map((item) => item.report);
  return {
    products: demoResult.products,
    observations: demoResult.observations || [],
    sources,
    warnings: [
      "当前没有取得任何真实外部市场数据，报告已切换为无 API 演示模式。所有样本和评分均为模拟内容，不能用于选品、采购或投放决策。",
      ...collectWarnings(sources),
    ],
    runMode: "demo",
  };
}
