import { getCommerceMarketplace } from "../marketplaces";
import type { CommerceProductSignal } from "../types";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "./types";

interface CachedAccessToken {
  value: string;
  expiresAt: number;
}

interface LwaTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

let cachedAccessToken: CachedAccessToken | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(
  record: Record<string, unknown> | null,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  return asRecord(asArray(value)[0]);
}

function parseCatalogItem(
  value: unknown,
  marketplaceDomain: string,
): CommerceProductSignal | null {
  const item = asRecord(value);
  const asin = readString(item, "asin");
  if (!asin) return null;

  const summary = firstRecord(item?.summaries);
  const imagesByMarketplace = firstRecord(item?.images);
  const images = asArray(imagesByMarketplace?.images)
    .map(asRecord)
    .filter((image): image is Record<string, unknown> => Boolean(image));
  const mainImage =
    images.find((image) => readString(image, "variant") === "MAIN") ||
    images[0];

  const salesRankGroup = firstRecord(item?.salesRanks);
  const classificationRanks = asArray(salesRankGroup?.classificationRanks)
    .map(asRecord)
    .filter((rank): rank is Record<string, unknown> => Boolean(rank));
  const displayGroupRanks = asArray(salesRankGroup?.displayGroupRanks)
    .map(asRecord)
    .filter((rank): rank is Record<string, unknown> => Boolean(rank));
  const bestRank = [...classificationRanks, ...displayGroupRanks]
    .flatMap((rank) => {
      const rankValue = readNumber(rank, "rank");
      if (rankValue === undefined) return [];
      return [{ rank: rankValue, title: readString(rank, "title") }];
    })
    .sort((left, right) => left.rank - right.rank)[0];

  const classifications = firstRecord(item?.classifications);
  const classification = firstRecord(classifications?.classifications);
  const relationships = firstRecord(item?.relationships);
  const relationshipList = asArray(relationships?.relationships)
    .map(asRecord)
    .filter((relationship): relationship is Record<string, unknown> =>
      Boolean(relationship),
    );
  const variationCount = relationshipList.reduce((count, relationship) => {
    const children = asArray(relationship.childAsins).length;
    return Math.max(count, children);
  }, 0);

  return {
    asin,
    platform: "amazon",
    title: readString(summary, "itemName") || asin,
    brand: readString(summary, "brand"),
    imageUrl: readString(mainImage || null, "link"),
    productUrl: `https://${marketplaceDomain}/dp/${asin}`,
    category:
      readString(classification, "displayName") ||
      readString(summary, "websiteDisplayGroupName"),
    salesRank: bestRank?.rank,
    salesRankCategory: bestRank?.title,
    variationCount: variationCount || undefined,
    source: "amazon-sp-api",
  };
}

function hasRefreshCredentials(): boolean {
  return Boolean(
    process.env.AMAZON_SP_API_CLIENT_ID?.trim() &&
      process.env.AMAZON_SP_API_CLIENT_SECRET?.trim() &&
      process.env.AMAZON_SP_API_REFRESH_TOKEN?.trim(),
  );
}

async function getAccessToken(signal?: AbortSignal): Promise<string> {
  const directToken = process.env.AMAZON_SP_API_ACCESS_TOKEN?.trim();
  if (directToken) return directToken;

  const now = Date.now();
  if (cachedAccessToken && cachedAccessToken.expiresAt > now + 60_000) {
    return cachedAccessToken.value;
  }

  const clientId = process.env.AMAZON_SP_API_CLIENT_ID?.trim();
  const clientSecret = process.env.AMAZON_SP_API_CLIENT_SECRET?.trim();
  const refreshToken = process.env.AMAZON_SP_API_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Amazon SP-API 未配置。请设置 AMAZON_SP_API_CLIENT_ID、AMAZON_SP_API_CLIENT_SECRET 和 AMAZON_SP_API_REFRESH_TOKEN。",
    );
  }

  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
    signal,
  });
  const payload = (await response.json()) as LwaTokenResponse;

  if (!response.ok || !payload.access_token) {
    throw new Error(
      payload.error_description ||
        payload.error ||
        `Amazon LWA 授权失败（HTTP ${response.status}）`,
    );
  }

  const expiresIn = Math.max(300, payload.expires_in || 3600);
  cachedAccessToken = {
    value: payload.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return payload.access_token;
}

async function fetchCatalogPage(
  input: CommerceProviderSearchInput,
): Promise<CommerceProductSignal[]> {
  const marketplace = getCommerceMarketplace(input.marketplace);
  const accessToken = await getAccessToken(input.signal);
  const url = new URL(
    "/catalog/2022-04-01/items",
    marketplace.spApiEndpoint,
  );
  url.searchParams.set("marketplaceIds", marketplace.marketplaceId);
  url.searchParams.set(
    "includedData",
    [
      "summaries",
      "images",
      "salesRanks",
      "classifications",
      "productTypes",
      "relationships",
    ].join(","),
  );
  url.searchParams.set("locale", marketplace.locale);
  url.searchParams.set("pageSize", String(Math.min(20, input.sampleSize)));
  url.searchParams.set(
    "keywords",
    input.category.keywords.slice(0, 8).join(","),
  );

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Multi-agent-Commerce/1.0 (Language=TypeScript)",
      "x-amz-access-token": accessToken,
      "x-amz-date": new Date()
        .toISOString()
        .replace(/[-:]|\.\d{3}/gu, ""),
    },
    signal: input.signal,
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 600);
    throw new Error(
      `Amazon Catalog Items API 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`,
    );
  }

  const payload = asRecord(await response.json());
  return asArray(payload?.items)
    .map((item) => parseCatalogItem(item, marketplace.domain))
    .filter((item): item is CommerceProductSignal => Boolean(item))
    .slice(0, input.sampleSize);
}

/**
 * Amazon Selling Partner API 数据源。
 *
 * 第一版使用 Catalog Items v2022-04-01 做关键词检索并读取类目、图片和 Sales Rank。
 * 真实竞品订单量不属于 Catalog Items 数据，因此分析层只会基于排名做透明的区间估算。
 */
export class AmazonSpApiProvider implements CommerceDataProvider {
  readonly kind = "amazon-sp-api" as const;

  isConfigured(): boolean {
    return Boolean(
      process.env.AMAZON_SP_API_ACCESS_TOKEN?.trim() || hasRefreshCredentials(),
    );
  }

  async searchProducts(
    input: CommerceProviderSearchInput,
  ): Promise<CommerceProviderSearchResult> {
    const products = await fetchCatalogPage(input);
    if (!products.length) {
      throw new Error("Amazon SP-API 请求成功，但没有返回可分析的商品样本。");
    }

    return {
      provider: this.kind,
      sourceId: "amazon",
      products,
      coverage: ["商品", "品牌", "类目", "图片", "Sales Rank", "变体关系"],
      warnings: [
        "Amazon Catalog Items API 不提供任意竞品的真实订单量；界面中的月销量仅为基于 Sales Rank 的启发式估算。",
        "Catalog Items API 本身不保证返回竞品价格、评分和评论数；如需这些字段，可开启合规的公开页面采集或接入额外授权数据源。",
      ],
    };
  }
}
