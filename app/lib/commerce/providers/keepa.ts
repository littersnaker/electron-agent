import { getCommerceMarketplace } from "../marketplaces";
import type { CommerceProductSignal } from "../types";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "./types";

type JsonRecord = Record<string, unknown>;
const KEEPA_BASE_URL = "https://api.keepa.com";

const DOMAIN_BY_MARKETPLACE: Record<CommerceProviderSearchInput["marketplace"], number> = {
  US: 1,
  UK: 2,
  DE: 3,
  FR: 4,
  JP: 5,
  CA: 6,
  IT: 8,
  ES: 9,
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function keepaApiKey(requestKey?: string): string | undefined {
  return requestKey?.trim() || process.env.KEEPA_API_KEY?.trim() || undefined;
}

async function keepaFetch(
  path: string,
  params: URLSearchParams,
  requestKey?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const key = keepaApiKey(requestKey);
  if (!key) throw new Error("Keepa API Key 未配置");
  params.set("key", key);
  const response = await fetch(`${KEEPA_BASE_URL}${path}?${params.toString()}`, { signal });
  const payload = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    const message = isRecord(payload) ? readString(payload.error) || readString(payload.message) : undefined;
    throw new Error(`Keepa 请求失败（HTTP ${response.status}）${message ? `：${message}` : ""}`);
  }
  return payload;
}

function extractAsins(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const candidates = [payload.asinList, payload.asins, payload.products];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const values = candidate.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (isRecord(item) && typeof item.asin === "string") return [item.asin];
      return [];
    });
    if (values.length) return values;
  }
  return [];
}

function normalizeKeepaProduct(value: unknown, currency: string): CommerceProductSignal | null {
  if (!isRecord(value)) return null;
  const asin = readString(value.asin);
  const title = readString(value.title);
  if (!asin || !title) return null;
  const stats = isRecord(value.stats) ? value.stats : undefined;
  const current = Array.isArray(stats?.current) ? stats.current : [];
  // Keepa 的 current 数组按其 API 价格类型索引；这里只读取稳定且可解释的 Amazon price / sales rank 槽位，
  // 如果数据缺失就留空，不对不存在的字段做猜测。
  const amazonPriceRaw = readNumber(current[0]);
  const salesRankRaw = readNumber(current[3]);
  return {
    asin: asin.toUpperCase(),
    title,
    platform: "amazon",
    brand: readString(value.brand),
    price: amazonPriceRaw && amazonPriceRaw > 0 ? amazonPriceRaw / 100 : undefined,
    currency,
    salesRank: salesRankRaw && salesRankRaw > 0 ? salesRankRaw : undefined,
    source: "keepa",
  };
}

/**
 * Keepa 是独立增强源：没有 KEEPA_API_KEY 时直接标记“未配置”，不会拖垮其他来源。
 * 搜索先拿 ASIN，再调用 product endpoint 获取历史/排名摘要；所有失败都会由 Orchestrator 单独记录。
 */
export class KeepaProvider implements CommerceDataProvider {
  readonly kind = "keepa" as const;

  constructor(private readonly requestKey?: string) {}

  isConfigured(): boolean {
    return Boolean(keepaApiKey(this.requestKey));
  }

  async searchProducts(input: CommerceProviderSearchInput): Promise<CommerceProviderSearchResult> {
    const domain = DOMAIN_BY_MARKETPLACE[input.marketplace];
    const keyword = input.category.keywords[0] || input.category.categoryNameEn;
    const searchPayload = await keepaFetch(
      "/search",
      new URLSearchParams({ domain: String(domain), type: "product", term: keyword }),
      this.requestKey,
      input.signal,
    );
    const asins = extractAsins(searchPayload).slice(0, Math.min(20, input.sampleSize));
    if (!asins.length) {
      return {
        provider: this.kind,
        sourceId: "keepa",
        products: [],
        coverage: ["Amazon 历史价格", "Sales Rank 历史"],
        warnings: ["Keepa 搜索没有返回可用 ASIN。"],
      };
    }

    const productPayload = await keepaFetch(
      "/product",
      new URLSearchParams({
        domain: String(domain),
        asin: asins.join(","),
        stats: "90",
        history: "1",
      }),
      this.requestKey,
      input.signal,
    );
    const productsRaw = isRecord(productPayload) && Array.isArray(productPayload.products)
      ? productPayload.products
      : [];
    const market = getCommerceMarketplace(input.marketplace);
    const products = productsRaw
      .map((item) => normalizeKeepaProduct(item, market.currency))
      .filter((item): item is CommerceProductSignal => Boolean(item));

    return {
      provider: this.kind,
      sourceId: "keepa",
      products,
      coverage: ["Amazon 历史价格", "Sales Rank", "商品生命周期信号"],
      warnings: ["Keepa 数据用于历史趋势与 Amazon 排名增强，不代表卖家私有订单。"],
    };
  }
}
