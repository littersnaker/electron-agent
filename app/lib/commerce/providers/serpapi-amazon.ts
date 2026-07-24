import { getCommerceMarketplace } from "../marketplaces";
import type { CommerceProductSignal } from "../types";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "./types";

const SERPAPI_ENDPOINT = "https://serpapi.com/search.json";
const MAX_SEARCH_KEYWORDS = 2;
const MAX_PAGES_PER_KEYWORD = 2;

type SerpApiAmazonResult = {
  asin?: unknown;
  title?: unknown;
  link?: unknown;
  link_clean?: unknown;
  thumbnail?: unknown;
  brand?: unknown;
  rating?: unknown;
  reviews?: unknown;
  extracted_price?: unknown;
  bought_last_month?: unknown;
  sponsored?: unknown;
};

type SerpApiAmazonResponse = {
  error?: unknown;
  organic_results?: unknown;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.replace(/[^0-9.-]/gu, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 将 Amazon 搜索结果里的 “1K+ bought in past month” 转为可计算的保守下限。
 * 这里保留的是“至少购买量”，不是官方订单精确值，后续分析层仍会明确标注为估算。
 */
function parseBoughtLastMonth(value: unknown): number | undefined {
  const text = readString(value);
  if (!text) return undefined;

  const match = /([0-9]+(?:\.[0-9]+)?)\s*([KkMm])?\+?/u.exec(
    text.replace(/,/gu, ""),
  );
  if (!match) return undefined;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;

  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  return Math.round(base * multiplier);
}

function normalizeResult(
  value: unknown,
  currency: string,
): CommerceProductSignal | null {
  if (!value || typeof value !== "object") return null;
  const item = value as SerpApiAmazonResult;
  const asin = readString(item.asin);
  const title = readString(item.title);
  if (!asin || !title) return null;

  const boughtLastMonth = readString(item.bought_last_month);
  return {
    asin,
    title,
    brand: readString(item.brand),
    imageUrl: readString(item.thumbnail),
    productUrl: readString(item.link_clean) || readString(item.link),
    price: readNumber(item.extracted_price),
    currency,
    rating: readNumber(item.rating),
    reviewCount: readNumber(item.reviews),
    recentPurchaseLowerBound: parseBoughtLastMonth(boughtLastMonth),
    recentPurchaseLabel: boughtLastMonth,
    source: "serpapi-amazon",
  };
}

function sortOrganicResults(values: unknown[]): unknown[] {
  // 市场样本优先使用自然结果；样本不足时才补 sponsored，减少广告位对竞争判断的干扰。
  return [...values].sort((left, right) => {
    const leftSponsored =
      Boolean(left && typeof left === "object" && (left as SerpApiAmazonResult).sponsored);
    const rightSponsored =
      Boolean(right && typeof right === "object" && (right as SerpApiAmazonResult).sponsored);
    return Number(leftSponsored) - Number(rightSponsored);
  });
}

/**
 * 无 Amazon Seller 店铺即可使用的稳定市场数据 Provider。
 *
 * SerpApi 负责处理 Amazon 搜索页抓取与结构解析，本项目只消费其结构化 JSON。
 * 相比服务端直接请求 Amazon HTML，这种方式更适合桌面运营工具：不依赖 Seller
 * Central 授权，也不会把 CAPTCHA / 页面 DOM 变化直接传播到分析主链路。
 */
export class SerpApiAmazonProvider implements CommerceDataProvider {
  readonly kind = "serpapi-amazon" as const;

  constructor(private readonly requestApiKey?: string) {}

  private getApiKey(): string | undefined {
    return this.requestApiKey?.trim() || process.env.SERPAPI_COM_API_KEY?.trim();
  }

  isConfigured(): boolean {
    return Boolean(this.getApiKey());
  }

  async searchProducts(
    input: CommerceProviderSearchInput,
  ): Promise<CommerceProviderSearchResult> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error("SerpApi API Key 未配置");
    }

    const marketplace = getCommerceMarketplace(input.marketplace);
    const amazonDomain = marketplace.domain.replace(/^www\./u, "");
    const keywords = Array.from(
      new Set(
        [...input.category.keywords, input.category.categoryNameEn]
          .map((keyword) => keyword.trim())
          .filter(Boolean),
      ),
    ).slice(0, MAX_SEARCH_KEYWORDS);
    const productMap = new Map<string, CommerceProductSignal>();
    const warnings: string[] = [];

    for (const keyword of keywords) {
      for (
        let page = 1;
        page <= MAX_PAGES_PER_KEYWORD && productMap.size < input.sampleSize;
        page += 1
      ) {
        const url = new URL(SERPAPI_ENDPOINT);
        url.searchParams.set("engine", "amazon");
        url.searchParams.set("amazon_domain", amazonDomain);
        url.searchParams.set("language", marketplace.locale);
        url.searchParams.set("device", "desktop");
        url.searchParams.set("k", keyword);
        url.searchParams.set("page", String(page));
        url.searchParams.set("api_key", apiKey);

        const response = await fetch(url, { signal: input.signal });
        if (!response.ok) {
          throw new Error(`SerpApi Amazon Search 请求失败（HTTP ${response.status}）`);
        }

        const payload = (await response.json()) as SerpApiAmazonResponse;
        const apiError = readString(payload.error);
        if (apiError) throw new Error(`SerpApi 返回错误：${apiError}`);

        const rawResults = Array.isArray(payload.organic_results)
          ? sortOrganicResults(payload.organic_results)
          : [];
        const normalized = rawResults
          .map((item) => normalizeResult(item, marketplace.currency))
          .filter((item): item is CommerceProductSignal => Boolean(item));

        for (const product of normalized) {
          if (!productMap.has(product.asin)) productMap.set(product.asin, product);
          if (productMap.size >= input.sampleSize) break;
        }

        if (!normalized.length) {
          warnings.push(`${keyword} 第 ${page} 页没有可用 Amazon 商品结果。`);
          break;
        }
      }
      if (productMap.size >= input.sampleSize) break;
    }

    const products = Array.from(productMap.values()).slice(0, input.sampleSize);
    if (!products.length) {
      throw new Error("SerpApi 没有返回可用于市场分析的 Amazon 商品样本。");
    }

    return {
      provider: this.kind,
      sourceId: "amazon",
      products,
      coverage: ["商品", "价格", "评分", "评论", "Amazon 搜索可见度"],
      warnings: [
        ...warnings,
        "本轮无需 Amazon 店铺或 Seller Central 授权；商品样本来自 SerpApi Amazon Search 的结构化公开市场结果。",
        "过去一个月购买量来自 Amazon 搜索结果公开展示的 bought_last_month 信号；它是下限，不等同于官方精确订单量。",
      ],
    };
  }
}
