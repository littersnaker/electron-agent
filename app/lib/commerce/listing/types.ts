/**
 * Amazon Listing Demo 的领域类型。
 *
 * 当前版本故意不连接 Seller Central 写入接口：
 * - 商品资料来自“模拟 ERP 适配器”；
 * - 竞品参考来自现有 Amazon API / 公开页面爬虫；
 * - 所有待确认字段都会明确标记，避免 Demo 文案被误当成可直接发布的数据。
 */
import type {
  CommerceCategoryResolution,
  CommerceDataProviderKind,
  CommerceMarketplaceCode,
  CommercePlatformDataRoute,
  CommerceProductSignal,
} from "../types";

export type CommerceWorkflowMode = "research" | "listing";

export type AmazonListingFactSource = "user" | "mock-erp" | "amazon-competitor-inference";

export interface AmazonListingFact {
  id: string;
  label: string;
  value: string;
  source: AmazonListingFactSource;
  confidence: number;
  requiresConfirmation: boolean;
}

export interface AmazonMockErpProduct {
  sourceName: "Mock ERP Adapter";
  sku: string;
  brand: string;
  productName: string;
  productType: string;
  facts: AmazonListingFact[];
  assumptions: string[];
  readyForPublish: false;
}

export type AmazonKeywordCluster =
  "core" | "feature" | "use-case" | "audience" | "attribute" | "long-tail";

export type AmazonKeywordPlacement = "title" | "bullet" | "backend";

export interface AmazonListingKeyword {
  phrase: string;
  normalized: string;
  cluster: AmazonKeywordCluster;
  source: "query" | "category" | "amazon-competitor";
  score: number;
  placement: AmazonKeywordPlacement;
}

export interface AmazonListingDraft {
  title: string;
  bulletPoints: string[];
  productDescription: string;
  searchTerms: string;
}

export type AmazonListingIssueSeverity = "error" | "warning" | "suggestion";

export interface AmazonListingIssue {
  field: "title" | "bulletPoints" | "productDescription" | "searchTerms" | "facts";
  severity: AmazonListingIssueSeverity;
  code: string;
  message: string;
  suggestedFix?: string;
}

export interface AmazonListingScore {
  overall: number;
  compliance: number;
  keywordCoverage: number;
  completeness: number;
  readability: number;
  factualSafety: number;
}

export interface AmazonListingValidation {
  policyVersion: "amazon-demo-2026-07-27";
  titleMaxCharacters: 75;
  bulletMinimumCount: 3;
  bulletMaximumCount: 5;
  bulletMinimumCharacters: 10;
  bulletMaximumCharacters: 255;
  backendSearchTermMaximumBytes: 240;
  issues: AmazonListingIssue[];
  score: AmazonListingScore;
  keywordCoverage: {
    covered: string[];
    missing: string[];
  };
}

export interface AmazonListingSourceSummary {
  provider: CommerceDataProviderKind | "demo-market" | "none";
  dataRoute?: CommercePlatformDataRoute;
  sampleSize: number;
  isDemo: boolean;
  description: string;
  warnings: string[];
}

export interface AmazonListingHumanConfirmation {
  status: "pending" | "confirmed" | "rejected" | "not_persisted";
  checklist: string[];
}

export interface AmazonListingDemoReport {
  version: 1;
  mode: "listing-demo";
  generatedAt: string;
  query: string;
  marketplace: CommerceMarketplaceCode;
  marketplaceLabel: string;
  locale: string;
  category: CommerceCategoryResolution;
  mockErp: AmazonMockErpProduct;
  keywords: AmazonListingKeyword[];
  draft: AmazonListingDraft;
  /** 生成时自动落库的草稿 id；空字符串表示未持久化。 */
  draftId: string;
  draftSource: "template" | "llm";
  requiresHumanConfirmation: boolean;
  humanConfirmation: AmazonListingHumanConfirmation;
  validation: AmazonListingValidation;
  competitors: CommerceProductSignal[];
  source: AmazonListingSourceSummary;
  warnings: string[];
}

export interface AmazonListingDemoRequest {
  query: string;
  marketplace: CommerceMarketplaceCode;
  sampleSize?: number;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
}
