// 模块说明：负责 types 核心服务与领域逻辑。
/**
 * Cross-border Market Intelligence Agent 的共享类型。
 *
 * v10 的核心设计是把“公开市场情报”与“平台商品数据”彻底拆开：
 * - TalorData 只要返回正常 SERP / Shopping 结果，就能形成 `CommerceMarketObservation`；
 * - Amazon / Keepa / TikTok Shop / Temu / 1688 都是增强来源，不再是完成报告的硬依赖；
 * - 报告会明确标记每个来源是否拿到数据，绝不会因为付费 API 未配置而中断主流程。
 */

export type CommerceMarketplaceCode =
  | "US"
  | "CA"
  | "UK"
  | "DE"
  | "FR"
  | "IT"
  | "ES"
  | "JP";

export type CommerceDataProviderKind =
  | "talordata-market"
  | "talordata-amazon"
  | "talordata-tiktok"
  | "talordata-temu"
  | "talordata-1688"
  | "tiktok-shop-public-page"
  | "temu-public-page"
  | "alibaba-1688-public-page"
  | "tiktok-shop-auto"
  | "temu-auto"
  | "alibaba-1688-auto"
  | "keepa"
  | "amazon-sp-api"
  | "amazon-public-page"
  | "amazon-auto"
  | "serpapi-amazon"
  | "demo-market";

export type CommerceMarketSourceId =
  | "market-search"
  | "amazon"
  | "keepa"
  | "tiktok-shop"
  | "temu"
  | "1688";

export type CommerceSourceStatus =
  | "collected"
  | "partial"
  | "unconfigured"
  | "empty"
  | "error"
  | "demo";

export type CommerceDataQuality = "high" | "medium" | "low" | "unavailable";

/**
 * 平台数据最终采用的链路。
 *
 * - api：TalorData 或平台授权 API；
 * - crawler：无需平台 API Key 的公开页面采集。
 */
export type CommercePlatformDataRoute = "api" | "crawler";

/** 爬虫链路实际使用的执行引擎。 */
export type CommerceCrawlerEngine = "http" | "browser";

/** 兼容历史代码的 Amazon 专用别名。 */
export type CommerceAmazonDataRoute = CommercePlatformDataRoute;

/**
 * Commerce Agent 的三档运行模式。
 *
 * - full：公开市场数据 + 至少一个真实增强来源；
 * - market-intelligence：至少取得一组真实数据，但增强来源不足；
 * - demo：所有真实来源都不可用时，用明确标记的模拟数据走完整产品流程。
 */
export type CommerceRunMode =
  | "full"
  | "market-intelligence"
  | "demo";

export interface CommerceCategoryResolution {
  categoryName: string;
  categoryNameEn: string;
  keywords: string[];
  subcategories: string[];
  analysisDimensions: string[];
  researchGoal: string;
}

/**
 * TalorData 等公开搜索数据源返回的通用市场观察项。
 *
 * 它不要求 ASIN，也不假装是平台官方销量。只记录搜索结果中真实出现的标题、域名、
 * 价格、评分等可验证信息，用于“市场活跃度 / 竞争可见度 / 价格信号”分析。
 */
export interface CommerceMarketObservation {
  id: string;
  title: string;
  url?: string;
  domain?: string;
  snippet?: string;
  resultType: "organic" | "shopping" | "ad" | "related" | "other";
  position?: number;
  price?: number;
  currency?: string;
  rating?: number;
  reviewCount?: number;
  merchant?: string;
  provider: CommerceDataProviderKind;
  /** 仅 Demo Provider 生成，UI 与 LLM 必须明确标记为模拟数据。 */
  isDemo?: boolean;
}

export interface CommerceProductSignal {
  /**
   * 兼容历史 Amazon 报告保留 asin 字段。
   * 非 Amazon 平台没有 ASIN 时，Provider 会写入稳定的 source-prefixed 标识，
   * UI 会展示 platform/source，而不会把该值冒充 Amazon ASIN。
   */
  asin: string;
  title: string;
  platform?: CommerceMarketSourceId;
  brand?: string;
  imageUrl?: string;
  productUrl?: string;
  category?: string;
  price?: number;
  currency?: string;
  rating?: number;
  reviewCount?: number;
  salesRank?: number;
  salesRankCategory?: string;
  variationCount?: number;
  recentPurchaseLowerBound?: number;
  recentPurchaseLabel?: string;
  /** 公开详情页可见的核心卖点；API 不返回时可以为空。 */
  bulletPoints?: string[];
  /** 搜索结果页公开展示的 Best Seller / Amazon Choice 等标签。 */
  badges?: string[];
  estimatedMonthlyUnits?: {
    low: number;
    median: number;
    high: number;
    confidence: "low" | "medium";
    basis?: "public-purchase-signal" | "sales-rank";
  };
  source: CommerceDataProviderKind;
  /** 仅 Demo Provider 生成，不能作为真实商业事实引用。 */
  isDemo?: boolean;
}

/**
 * 为兼容现有 UI 保留原字段名，但 v10 的语义已经从“Amazon 选品分”调整为“公开市场信号分”：
 * - demandScore: 市场活跃度（不是搜索量或真实销量）；
 * - competitionScore: 竞争开放度（越高代表公开结果越分散、越容易继续研究）；
 * - priceHealthScore: 价格信号完整度；
 * - newEntryScore: 进入研究度（是否值得继续投入更昂贵的数据验证）；
 * - opportunityScore: 综合市场信号分，不等于最终备货决策。
 */
export interface CommercePlatformComparison {
  platform: CommerceMarketSourceId;
  label: string;
  sampleSize: number;
  priceSampleSize: number;
  medianPrice?: number;
  currency?: string;
  medianRating?: number;
  medianReviewCount?: number;
  topBrandShare?: number;
}

export interface CommerceMarketMetrics {
  sampleSize: number;
  opportunityScore: number;
  demandScore: number;
  competitionScore: number;
  priceHealthScore: number;
  newEntryScore: number;
  medianPrice?: number;
  currency?: string;
  medianSalesRank?: number;
  medianReviewCount?: number;
  topBrandShare?: number;
  estimatedMonthlyUnits?: { low: number; median: number; high: number };
  /** v10：通用 SERP 市场情报补充指标。 */
  observationCount?: number;
  shoppingResultCount?: number;
  uniqueDomainCount?: number;
  topDomainShare?: number;
  priceSignalCount?: number;
  /** 按平台、按币种独立计算，避免把 1688 人民币价格与海外站点价格直接混算。 */
  platformComparisons?: CommercePlatformComparison[];
}

/** 单个数据来源的可用性、覆盖字段和分析摘要。 */
export interface CommerceSourceReport {
  id: CommerceMarketSourceId;
  label: string;
  status: CommerceSourceStatus;
  provider?: CommerceDataProviderKind;
  /**
   * 本轮平台来源最终成功采用的链路。Amazon、TikTok Shop、Temu、1688 都使用该字段。
   */
  dataRoute?: CommercePlatformDataRoute;
  /** dataRoute=crawler 时，标记本轮由轻量 HTTP 还是 Playwright 浏览器取得样本。 */
  crawlerEngine?: CommerceCrawlerEngine;
  /**
   * 所有候选链路最终都失败时，记录实际尝试顺序，例如 ["api", "crawler"]。
   * 该字段只用于故障诊断，不代表这些链路曾成功返回数据。
   */
  attemptedRoutes?: CommercePlatformDataRoute[];
  /** 兼容历史报告与旧 UI；新代码优先读取 dataRoute。 */
  amazonDataRoute?: CommerceAmazonDataRoute;
  /** 兼容历史报告与旧 UI；新代码优先读取 attemptedRoutes。 */
  amazonAttemptedRoutes?: CommerceAmazonDataRoute[];
  quality: CommerceDataQuality;
  sampleSize: number;
  coverage: string[];
  summary: string;
  warnings: string[];
  error?: string;
  metrics?: Partial<CommerceMarketMetrics>;
}

export interface CommerceResearchInsights {
  summary: string;
  opportunities: string[];
  risks: string[];
  actions: string[];
}

/** 单个商品的 Amazon 评论分析结果（评分分布 + 情感主题 + 评论样本）。 */
export interface CommerceReviewAnalysis {
  asin: string;
  productTitle: string;
  stats: {
    sampleSize: number;
    averageRating: number | null;
    ratingDistribution: Record<string, number>;
    verifiedPurchaseRatio: number | null;
    positiveRatio: number | null;
  };
  /** 确定性词频兜底或 LLM 增强后的情感结论。 */
  sentiment: {
    summary: string;
    positiveTopics: string[];
    negativeTopics: string[];
    keyFindings?: string[];
    suggestions?: string[];
  };
  sentimentSource: "template" | "llm";
  positiveTopics: string[];
  negativeTopics: string[];
  samples: Array<{
    rating: number | null;
    title: string | null;
    text: string | null;
    date: string | null;
    verifiedPurchase: boolean | null;
  }>;
  dataSource: {
    provider: string;
    quality: CommerceDataQuality;
    isDemo: boolean;
  };
  warnings: string[];
}

export interface CommerceResearchReport {
  /** v3：公开市场情报成为核心，平台 API 变为可选增强。 */
  version: 2 | 3;
  /**
   * v10 新增。历史报告可能没有该字段，展示层应回退到 market-intelligence。
   */
  runMode?: CommerceRunMode;
  generatedAt: string;
  query: string;
  marketplace: CommerceMarketplaceCode;
  marketplaceLabel: string;
  category: CommerceCategoryResolution;
  products: CommerceProductSignal[];
  /** v10 沿用；读取历史 v2 报告时可以不存在。 */
  observations?: CommerceMarketObservation[];
  metrics: CommerceMarketMetrics;
  insights: CommerceResearchInsights;
  /** 评论分析结果；历史报告或未采集到 Amazon 商品时不存在。 */
  reviewAnalyses?: CommerceReviewAnalysis[];
  /** 兼容旧 UI 的主数据源摘要。 */
  dataSource: {
    provider: CommerceDataProviderKind | "multi-source" | "none";
    quality: CommerceDataQuality;
    description: string;
  };
  /** 每个来源都必须出现在这里，即使失败或未配置。 */
  sources: CommerceSourceReport[];
  /** 0-100，代表本轮数据覆盖可信度，不是模型置信度。 */
  confidenceScore: number;
  warnings: string[];
}

export type CommerceResearchStage =
  | "intent"
  | "category"
  | "collect"
  | "normalize"
  | "analyze"
  | "strategy"
  | "erp"
  | "keywords"
  | "draft"
  | "validate"
  | "done";

export interface CommerceProgressEvent {
  stage: CommerceResearchStage;
  progress: number;
  detail: string;
}

export interface CommerceResearchRequest {
  query: string;
  marketplace: CommerceMarketplaceCode;
  sampleSize?: number;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
}
