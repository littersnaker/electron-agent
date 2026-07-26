// 模块说明：负责 data source orchestrator 核心服务与领域逻辑。
import { calculateMarketMetrics, inferDataQuality } from "../analytics";
import { inferCommerceRunMode } from "../run-mode";
import type {
  CommerceMarketObservation,
  CommerceMarketSourceId,
  CommerceProductSignal,
  CommerceRunMode,
  CommerceSourceReport,
} from "../types";
import {
  AmazonAutoProvider,
  AmazonDataSourceError,
  getAmazonRouteFromProvider,
} from "../providers/amazon-auto";
import { DemoMarketProvider } from "../providers/demo-market";
import { KeepaProvider } from "../providers/keepa";
import {
  getPlatformRouteFromProvider,
  PlatformAutoProvider,
  PlatformDataSourceError,
} from "../providers/platform-auto";
import { PLATFORM_SERP_CONFIGS } from "../providers/platform-serp";
import { TalorDataMarketIntelligenceProvider } from "../providers/talordata-market-intelligence";
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
  amazon: "Amazon 商品数据",
  keepa: "Keepa",
  "tiktok-shop": "TikTok Shop",
  temu: "Temu",
  "1688": "1688",
};

function getSourceDataRoute(
  sourceId: CommerceMarketSourceId,
  provider: CommerceDataProvider["kind"] | undefined,
) {
  if (sourceId === "amazon") return getAmazonRouteFromProvider(provider);
  if (sourceId === "tiktok-shop" || sourceId === "temu" || sourceId === "1688") {
    return getPlatformRouteFromProvider(provider);
  }
  return undefined;
}

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
    const dataRoute = getSourceDataRoute(sourceId, result.provider);
    metricSummary = [
      dataRoute === "api"
        ? "API 链路"
        : dataRoute === "crawler"
          ? "爬虫链路"
          : undefined,
      `已获取 ${products.length} 个可用样本`,
      metrics?.medianPrice !== undefined
        ? `中位价格 ${metrics.currency || ""} ${metrics.medianPrice}`.trim()
        : "价格覆盖不足",
      metrics?.medianReviewCount !== undefined
        ? `中位评论 ${metrics.medianReviewCount}`
        : "评论覆盖不足",
    ]
      .filter(Boolean)
      .join("；");
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
    dataRoute: getSourceDataRoute(sourceId, result.provider),
    crawlerEngine: result.crawlerEngine,
    amazonDataRoute:
      sourceId === "amazon"
        ? getAmazonRouteFromProvider(result.provider)
        : undefined,
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
            ? "未配置 TalorData；Amazon、TikTok Shop、Temu 与 1688 仍会自动尝试公开页面爬虫。"
            : sourceId === "keepa"
              ? "Keepa 未配置，本轮不会等待它，也不会因此中断报告。"
              : `${SOURCE_LABELS[sourceId]} API 与公开页面爬虫均被禁用，本轮不会生成该平台商品样本。`,
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
    const amazonError =
      sourceId === "amazon" && error instanceof AmazonDataSourceError
        ? error
        : undefined;
    const platformError =
      sourceId !== "amazon" && error instanceof PlatformDataSourceError
        ? error
        : undefined;
    const routeError = amazonError || platformError;
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
            ? "核心公开市场来源获取失败；系统仍会继续尝试各平台的 API → 爬虫自动数据链路。"
            : sourceId === "keepa"
              ? "Keepa API 本轮请求失败；该可选增强来源不会阻断其他平台采集与报告生成。"
              : routeError?.attemptedRoutes.includes("crawler")
                ? `${SOURCE_LABELS[sourceId]} 已执行公开页面爬虫，但当前网络或页面未返回可解析商品；本轮不会使用该来源生成事实性结论。`
                : `${SOURCE_LABELS[sourceId]} API 与公开页面爬虫均不可用，本轮不会使用该来源生成事实性结论。`,
        warnings: routeError
          ? routeError.diagnostics.map(
              (item) =>
                `${item.label}：${item.configured ? item.message : "未配置，已跳过"}`,
            )
          : [],
        attemptedRoutes: routeError?.attemptedRoutes,
        amazonAttemptedRoutes: amazonError?.attemptedRoutes,
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
            bulletPoints: product.bulletPoints ?? current.bulletPoints,
            badges: product.badges ?? current.badges,
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
 * 3. 演示模式：全部平台 API、公开页面爬虫与其他真实来源都没有数据时，才使用模拟样本。
 *
 * Amazon、TikTok Shop、Temu、1688 都固定执行“API 优先，API 不可用则公开页爬虫”。
 * Keepa 仍然是纯 API 可选增强；任何单一平台失败都不会阻断主流程。
 */
export async function collectMultiSourceMarketData(
  input: CommerceProviderSearchInput,
): Promise<CommerceOrchestrationResult> {
  const talorDataToken =
    input.serviceCredentials?.talorDataToken ||
    input.serviceCredentials?.serpApi ||
    input.serpApiKey;

  const marketSearch = new TalorDataMarketIntelligenceProvider(talorDataToken);
  const amazonAuto = new AmazonAutoProvider(talorDataToken);
  const keepa = new KeepaProvider(input.serviceCredentials?.keepaApiKey);
  const platformProviders = PLATFORM_SERP_CONFIGS.map((config) => ({
    sourceId: config.sourceId,
    provider: new PlatformAutoProvider(config, talorDataToken),
  }));

  // 所有真实来源并行执行。任何单个来源失败都只影响其自身状态。
  const tasks = [
    collectOne("market-search", marketSearch, input),
    collectOne("amazon", amazonAuto, input),
    collectOne("keepa", keepa, input),
    ...platformProviders.map(({ sourceId, provider }) =>
      collectOne(sourceId, provider, input),
    ),
  ];
  const results = await Promise.all(tasks);

  // 四个平台的 AutoProvider 都已在单一来源内部完成“API 优先、失败则爬虫”。
  // Orchestrator 只负责并行收集和合并，避免重复 fallback 与状态覆盖。

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
      "当前没有取得任何真实外部市场数据，报告已切换为无真实数据演示模式。所有样本和评分均为模拟内容，不能用于选品、采购或投放决策。",
      ...collectWarnings(sources),
    ],
    runMode: "demo",
  };
}
