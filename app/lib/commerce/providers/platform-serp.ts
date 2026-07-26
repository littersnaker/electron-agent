// 模块说明：负责 platform serp 核心服务与领域逻辑。
import { createHash } from "node:crypto";
import { getCommerceMarketplace } from "../marketplaces";
import type {
  CommerceDataProviderKind,
  CommerceMarketSourceId,
  CommerceProductSignal,
} from "../types";
import { getTalorDataTokenCandidates, requestTalorData } from "./talordata-client";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "./types";

type JsonRecord = Record<string, unknown>;

export interface PlatformConfig {
  sourceId: Extract<CommerceMarketSourceId, "tiktok-shop" | "temu" | "1688">;
  kind: Extract<CommerceDataProviderKind, "talordata-tiktok" | "talordata-temu" | "talordata-1688">;
  label: string;
  domains: string[];
  querySuffix: string;
  currency?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.replace(/,/gu, "").replace(/[^0-9.-]/gu, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function collectResultObjects(payload: unknown): JsonRecord[] {
  const keys = new Set(["organic", "organic_results", "shopping", "shopping_results", "items", "products", "web_results"]);
  const result: JsonRecord[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || !value) return;
    if (Array.isArray(value)) {
      for (const item of value) if (isRecord(item)) result.push(item);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (keys.has(key) && Array.isArray(child)) {
        for (const item of child) if (isRecord(item)) result.push(item);
      } else if (isRecord(child)) visit(child, depth + 1);
    }
  };
  visit(payload, 0);
  return result;
}

function createStableId(source: CommerceMarketSourceId, value: string): string {
  return `${source.toUpperCase()}-${createHash("sha1").update(value).digest("hex").slice(0, 10)}`;
}

function normalizeResult(value: JsonRecord, config: PlatformConfig): CommerceProductSignal | null {
  const url = text(value.link) || text(value.url) || text(value.product_link);
  const domainMatched = config.domains.some((domain) => url?.toLowerCase().includes(domain));
  if (!url || !domainMatched) return null;
  const title = text(value.title) || text(value.name);
  if (!title) return null;
  const price = number(value.extracted_price) ?? number(value.price);
  return {
    asin: createStableId(config.sourceId, url),
    title,
    platform: config.sourceId,
    brand: text(value.brand) || text(value.seller) || text(value.merchant),
    imageUrl: text(value.thumbnail) || text(value.image),
    productUrl: url,
    price,
    currency: config.currency,
    rating: number(value.rating),
    reviewCount: number(value.reviews) ?? number(value.review_count),
    source: config.kind,
  };
}

/**
 * TikTok Shop / Temu / 1688 的 API 数据入口。
 *
 * 当前项目把 TalorData 的平台定向 SERP 作为无需卖家授权的 API 候选：
 * - 有 TalorData Token 时优先走该 API；
 * - API 未配置、失败或返回空数据时，由 PlatformAutoProvider 自动切换公开页面爬虫；
 * - Provider 只返回公开可见字段，不把搜索可见度冒充平台官方销量或 GMV。
 */
export class PlatformSerpProvider implements CommerceDataProvider {
  readonly kind: CommerceDataProviderKind;

  constructor(
    private readonly config: PlatformConfig,
    private readonly requestToken?: string,
  ) {
    this.kind = config.kind;
  }

  isConfigured(): boolean {
    return getTalorDataTokenCandidates(this.requestToken).length > 0;
  }

  async searchProducts(input: CommerceProviderSearchInput): Promise<CommerceProviderSearchResult> {
    const market = getCommerceMarketplace(input.marketplace);
    const [language = "en", country = "US"] = market.locale.split("_");
    const keyword = input.category.keywords[0] || input.category.categoryNameEn;
    const domainQuery = this.config.domains.map((domain) => `site:${domain}`).join(" OR ");
    const { payload } = await requestTalorData(
      {
        q: `(${domainQuery}) ${keyword} ${this.config.querySuffix}`,
        gl: country.toLowerCase(),
        hl: language.toLowerCase(),
        location: input.marketplace === "US" ? "United States" : market.label,
        num: Math.min(20, input.sampleSize),
      },
      this.requestToken,
      input.signal,
    );
    const products = collectResultObjects(payload)
      .map((item) => normalizeResult(item, { ...this.config, currency: this.config.currency || market.currency }))
      .filter((item): item is CommerceProductSignal => Boolean(item));
    const unique = Array.from(new Map(products.map((item) => [item.productUrl || item.asin, item])).values())
      .slice(0, input.sampleSize);

    return {
      provider: this.config.kind,
      sourceId: this.config.sourceId,
      products: unique,
      coverage: ["公开搜索可见度", "商品标题", "商品链接", "可解析价格/评分"],
      warnings: [
        `${this.config.label} 当前使用公开 SERP 信号，不代表平台官方销量或完整 GMV。`,
      ],
    };
  }
}

export const PLATFORM_SERP_CONFIGS: PlatformConfig[] = [
  {
    sourceId: "tiktok-shop",
    kind: "talordata-tiktok",
    label: "TikTok Shop",
    domains: ["shop.tiktok.com", "tiktok.com/shop"],
    querySuffix: "TikTok Shop",
  },
  {
    sourceId: "temu",
    kind: "talordata-temu",
    label: "Temu",
    domains: ["temu.com"],
    querySuffix: "Temu",
  },
  {
    sourceId: "1688",
    kind: "talordata-1688",
    label: "1688",
    domains: ["1688.com", "detail.1688.com"],
    querySuffix: "1688 supplier wholesale",
    currency: "CNY",
  },
];
