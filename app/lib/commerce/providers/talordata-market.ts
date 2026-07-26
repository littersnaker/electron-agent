// 模块说明：负责 talordata market 核心服务与领域逻辑。
import { getCommerceMarketplace } from "../marketplaces";
import type { CommerceProductSignal } from "../types";
import {
  getTalorDataEnvironmentToken,
  getTalorDataTokenCandidates,
  requestTalorData,
  testTalorDataConnection,
} from "./talordata-client";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "./types";

export { getTalorDataEnvironmentToken, testTalorDataConnection };

const MAX_KEYWORDS = 2;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/,/gu, "").replace(/[^0-9.-]/gu, "");
  const parsed = Number(normalized);
  return normalized && Number.isFinite(parsed) ? parsed : undefined;
}

/** TalorData 版本迭代时字段命名可能不同，因此同时兼容常见 SERP 容器。 */
function findArrays(payload: unknown, keys: readonly string[]): unknown[] {
  const found: unknown[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || !value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    for (const key of keys) {
      const candidate = value[key];
      if (Array.isArray(candidate)) found.push(...candidate);
    }
    for (const child of Object.values(value)) {
      if (isRecord(child)) visit(child, depth + 1);
    }
  };
  visit(payload, 0);
  return found;
}

function extractAsin(value?: string): string | undefined {
  if (!value) return undefined;
  const match = /(?:\/dp\/|\/gp\/product\/|\b)(B0[A-Z0-9]{8}|[A-Z0-9]{10})(?:[/?\s]|$)/iu.exec(value);
  return match?.[1]?.toUpperCase();
}

function parsePrice(value: unknown): number | undefined {
  if (typeof value === "number") return readNumber(value);
  const text = readString(value);
  if (!text) return undefined;
  const match = /(?:US\$|CA\$|AU\$|£|€|￥|¥|\$)?\s*([0-9][0-9,.]*(?:\.[0-9]{1,2})?)/u.exec(text);
  return match ? readNumber(match[1]) : undefined;
}

function parseBought(value: unknown): number | undefined {
  const text = readString(value);
  if (!text) return undefined;
  const match = /([0-9]+(?:\.[0-9]+)?)\s*([KkMm])?\+?\s*(?:bought|purchased)/u.exec(text.replace(/,/gu, ""));
  if (!match) return undefined;
  const base = Number(match[1]);
  const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
  return Number.isFinite(base) ? Math.round(base * multiplier) : undefined;
}

function stringFrom(item: JsonRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = readString(item[key]);
    if (value) return value;
  }
  return undefined;
}

function numberFrom(item: JsonRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = readNumber(item[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function normalizeAmazonResult(
  value: unknown,
  amazonDomain: string,
  currency: string,
): CommerceProductSignal | null {
  if (!isRecord(value)) return null;
  const url = stringFrom(value, ["product_link", "link", "url", "product_url"]);
  const seller = stringFrom(value, ["source", "seller", "merchant", "domain"]);
  const isAmazon = Boolean(
    url?.toLowerCase().includes(amazonDomain.toLowerCase()) ||
      seller?.toLowerCase().includes("amazon"),
  );
  if (!isAmazon) return null;

  const title = stringFrom(value, ["title", "name", "product_title"]);
  const asin = stringFrom(value, ["asin", "product_id"])?.toUpperCase() || extractAsin(url);
  if (!title || !asin) return null;

  const snippet = [
    stringFrom(value, ["snippet", "description"]),
    readString(value.extensions),
  ].filter(Boolean).join(" · ");

  return {
    asin,
    title,
    platform: "amazon",
    brand: stringFrom(value, ["brand", "manufacturer"]),
    imageUrl: stringFrom(value, ["thumbnail", "image", "image_url"]),
    productUrl: url,
    price: numberFrom(value, ["extracted_price", "price_value"]) ?? parsePrice(value.price) ?? parsePrice(snippet),
    currency,
    rating: numberFrom(value, ["rating", "stars"]),
    reviewCount: numberFrom(value, ["reviews", "review_count", "ratings"]),
    recentPurchaseLowerBound: parseBought(snippet),
    recentPurchaseLabel: /bought|purchased/iu.test(snippet) ? snippet : undefined,
    source: "talordata-amazon",
  };
}

function searchContext(code: CommerceProviderSearchInput["marketplace"]): {
  gl: string;
  hl: string;
  googleDomain: string;
  location: string;
} {
  const market = getCommerceMarketplace(code);
  const [language = "en", country = "US"] = market.locale.split("_");
  const domains: Partial<Record<typeof code, string>> = {
    US: "google.com", CA: "google.ca", UK: "google.co.uk", DE: "google.de",
    FR: "google.fr", IT: "google.it", ES: "google.es", JP: "google.co.jp",
  };
  const locations: Partial<Record<typeof code, string>> = {
    US: "United States", CA: "Canada", UK: "United Kingdom", DE: "Germany",
    FR: "France", IT: "Italy", ES: "Spain", JP: "Japan",
  };
  return {
    gl: country.toLowerCase(),
    hl: language.toLowerCase(),
    googleDomain: domains[code] || "google.com",
    location: locations[code] || "United States",
  };
}

/** 无 Seller Central 也可以使用的 Amazon 市场样本 Provider。 */
export class TalorDataMarketProvider implements CommerceDataProvider {
  readonly kind = "talordata-amazon" as const;

  constructor(private readonly requestToken?: string) {}

  isConfigured(): boolean {
    return getTalorDataTokenCandidates(this.requestToken).length > 0;
  }

  async searchProducts(input: CommerceProviderSearchInput): Promise<CommerceProviderSearchResult> {
    const market = getCommerceMarketplace(input.marketplace);
    const context = searchContext(input.marketplace);
    const amazonDomain = market.domain.replace(/^www\./u, "");
    const keywords = Array.from(new Set([...input.category.keywords, input.category.categoryNameEn]))
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, MAX_KEYWORDS);
    const products = new Map<string, CommerceProductSignal>();
    const warnings: string[] = [];

    for (const keyword of keywords) {
      if (products.size >= input.sampleSize) break;
      const queries = [
        { q: `${keyword} Amazon`, tbm: "shop" },
        { q: `site:${amazonDomain}/dp/ ${keyword}` },
      ];
      for (const query of queries) {
        if (products.size >= input.sampleSize) break;
        try {
          const { payload, credentialSource } = await requestTalorData(
            { ...context, q: query.q, tbm: query.tbm, num: Math.min(20, input.sampleSize) },
            this.requestToken,
            input.signal,
          );
          const candidates = findArrays(payload, [
            "shopping_results", "shopping", "inline_shopping_results", "product_results",
            "products", "organic_results", "organic", "web_results", "items",
          ]);
          for (const candidate of candidates) {
            const product = normalizeAmazonResult(candidate, amazonDomain, market.currency);
            if (product) products.set(product.asin, { ...products.get(product.asin), ...product });
          }
          warnings.push(`TalorData ${query.tbm ? "Shopping" : "Search"} 使用 ${credentialSource === "environment" ? "应用默认 Token" : "本机 Token"}。`);
        } catch (error) {
          warnings.push(`${keyword}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const result = Array.from(products.values()).slice(0, input.sampleSize);
    if (!result.length) {
      throw new Error(`TalorData 没有解析出 ${market.label} Amazon 商品样本。${warnings.length ? ` 诊断：${warnings.join("；")}` : ""}`);
    }

    return {
      provider: this.kind,
      sourceId: "amazon",
      products: result,
      coverage: ["商品", "价格", "评分", "评论", "公开搜索可见度"],
      warnings,
    };
  }
}
