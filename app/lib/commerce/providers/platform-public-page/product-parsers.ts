/**
 * 模块职责：公开页面字段清洗、价格解析和商品标准化。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { createHash } from "node:crypto";
import type { CommerceProductSignal } from "../../types";
import { JsonRecord, PlatformCrawlerDefinition, SupportedPlatformSource } from "./crawler-definitions";
export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function decodeHtml(value: string): string {
  return value
    .replace(/\\u002F/giu, "/")
    .replace(/\\\//gu, "/")
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&#x27;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&nbsp;|&#160;/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function stripTags(value: string): string {
  return decodeHtml(
    value
      .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
      .replace(/<[^>]+>/gu, " "),
  );
}

export function readBoundedInteger(
  environmentName: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[environmentName]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

export function isEnabled(environmentName: string): boolean {
  const raw = process.env[environmentName]?.trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

export function readText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = decodeHtml(value);
    return normalized || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

export function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;

  const compactMatch = /([0-9]+(?:[.,][0-9]+)?)\s*([KkMm万])\+?/u.exec(
    value.replace(/,/gu, ""),
  );
  if (compactMatch) {
    const base = Number(compactMatch[1]);
    const multiplier =
      compactMatch[2] === "万"
        ? 10_000
        : compactMatch[2]?.toLowerCase() === "m"
          ? 1_000_000
          : 1_000;
    return Number.isFinite(base) ? Math.round(base * multiplier) : undefined;
  }

  const normalized = value
    .replace(/,/gu, "")
    .replace(/[^0-9.-]/gu, "");
  const parsed = Number(normalized);
  return normalized && Number.isFinite(parsed) ? parsed : undefined;
}

export function firstText(
  record: JsonRecord,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = readText(record[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

export function firstNumber(
  record: JsonRecord,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const candidate = readNumber(record[key]);
    if (candidate !== undefined) return candidate;

    const nested = record[key];
    if (isRecord(nested)) {
      const nestedCandidate = firstNumber(nested, [
        "value",
        "amount",
        "min",
        "minPrice",
        "salePrice",
        "price",
      ]);
      if (nestedCandidate !== undefined) return nestedCandidate;
    }
  }
  return undefined;
}

export function firstImage(record: JsonRecord): string | undefined {
  const direct = firstText(record, [
    "image",
    "imageUrl",
    "image_url",
    "thumbnail",
    "thumbUrl",
    "mainImage",
    "main_image",
    "goodsImageUrl",
    "product_image",
  ]);
  if (direct) return direct;

  for (const key of ["images", "imageList", "image_list", "productImages"]) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const candidate = readText(item);
      if (candidate) return candidate;
      if (isRecord(item)) {
        const nested = firstText(item, ["url", "src", "imageUrl"]);
        if (nested) return nested;
      }
    }
  }
  return undefined;
}

export function normalizeUrl(value: string | undefined, baseUrl: URL): string | undefined {
  if (!value) return undefined;
  const decoded = decodeHtml(value);
  if (/^(?:javascript:|data:|#)/iu.test(decoded)) return undefined;
  try {
    return new URL(decoded, baseUrl).toString();
  } catch {
    return undefined;
  }
}

export function matchesProductUrl(
  value: string,
  definition: PlatformCrawlerDefinition,
): boolean {
  return definition.productUrlPatterns.some((pattern) => pattern.test(value));
}

export function createStableId(sourceId: SupportedPlatformSource, value: string): string {
  const extracted =
    sourceId === "1688"
      ? /(?:\/offer\/|offerId=)(\d+)/iu.exec(value)?.[1]
      : sourceId === "temu"
        ? /(?:-g-|goods_id=)(\d+)/iu.exec(value)?.[1]
        : /(?:product\/|product_id=)(\d+)/iu.exec(value)?.[1];
  if (extracted) return `${sourceId.toUpperCase()}-${extracted}`;
  return `${sourceId.toUpperCase()}-${createHash("sha1")
    .update(value)
    .digest("hex")
    .slice(0, 12)}`;
}

export function parsePriceFromText(value: string): number | undefined {
  // 必须出现货币符号、币种或明确的“价格”标签，避免把标题中的型号、尺寸误识别成价格。
  const patterns = [
    /(?:US\$|CA\$|AU\$|S\$|£|€|¥|￥|RMB|USD|CAD|GBP|EUR|CNY)\s*([0-9][0-9,.]*(?:\.[0-9]{1,2})?)/iu,
    /([0-9][0-9,.]*(?:\.[0-9]{1,2})?)\s*(?:USD|CAD|GBP|EUR|CNY|RMB|元)/iu,
    /(?:price|sale price|售价|价格|起批价)\D{0,12}([0-9][0-9,.]*(?:\.[0-9]{1,2})?)/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match?.[1]) return readNumber(match[1]);
  }
  return undefined;
}

export function parseRatingFromText(value: string): number | undefined {
  const match =
    /(?:rating|rated|评分|星级|stars?)\D{0,12}([0-5](?:\.[0-9])?)/iu.exec(
      value,
    ) || /([0-5](?:\.[0-9])?)\s*(?:out of 5|stars?|分)/iu.exec(value);
  return match?.[1] ? readNumber(match[1]) : undefined;
}

export function parseReviewCountFromText(value: string): number | undefined {
  const match =
    /([0-9]+(?:[.,][0-9]+)?\s*[KkMm万]?\+?)\s*(?:reviews?|ratings?|评价|条评价)/iu.exec(
      value,
    );
  return match?.[1] ? readNumber(match[1]) : undefined;
}

export function parseSoldSignalFromText(
  value: string,
): { count?: number; label?: string } {
  const match =
    /([0-9]+(?:[.,][0-9]+)?\s*[KkMm万]?\+?)\s*(?:sold|orders?|已售|销量|成交)/iu.exec(
      value,
    );
  if (!match?.[1]) return {};
  return {
    count: readNumber(match[1]),
    label: decodeHtml(match[0]).slice(0, 80),
  };
}

export function readHtmlAttribute(tag: string, attributeName: string): string | undefined {
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "iu",
  );
  const match = pattern.exec(tag);
  const value = match?.[1] ?? match?.[2];
  return value ? decodeHtml(value) : undefined;
}

export function buildProductUrlFromRecord(
  record: JsonRecord,
  definition: PlatformCrawlerDefinition,
  baseUrl: URL,
): string | undefined {
  const rawUrl = firstText(record, [
    "url",
    "link",
    "productUrl",
    "product_url",
    "goodsUrl",
    "goods_url",
    "detailUrl",
    "detail_url",
    "shareUrl",
    "share_url",
    "canonicalUrl",
    "jumpUrl",
    "jump_url",
  ]);
  const normalized = normalizeUrl(rawUrl, baseUrl);
  if (normalized && matchesProductUrl(normalized, definition)) return normalized;

  // 浏览器监听到的 XHR/Fetch JSON 经常只返回商品 ID，而不返回完整详情链接。
  // 这里只使用平台明确的 ID 字段合成公开商品地址，不使用模糊的任意数字字段。
  const idKeys =
    definition.sourceId === "1688"
      ? ["offerId", "offer_id"]
      : definition.sourceId === "temu"
        ? ["goodsId", "goods_id"]
        : ["productId", "product_id"];
  const productId = firstText(record, idKeys);
  if (!productId || !/^\d{5,}$/u.test(productId)) return undefined;

  if (definition.sourceId === "1688") {
    return `https://detail.1688.com/offer/${productId}.html`;
  }
  if (definition.sourceId === "temu") {
    return `https://www.temu.com/goods.html?goods_id=${productId}`;
  }
  return `https://shop.tiktok.com/us/view/product/${productId}`;
}

export function productFromJsonRecord(
  record: JsonRecord,
  definition: PlatformCrawlerDefinition,
  baseUrl: URL,
  currency: string,
): CommerceProductSignal | null {
  const title = firstText(record, [
    "title",
    "name",
    "productTitle",
    "product_title",
    "productName",
    "product_name",
    "goodsName",
    "goods_name",
    "offerTitle",
    "subject",
    "displayName",
    "display_name",
  ]);
  if (!title || title.length < 3) return null;

  const productUrl = buildProductUrlFromRecord(record, definition, baseUrl);
  if (!productUrl) return null;

  const soldCount = firstNumber(record, [
    "soldCount",
    "sold_count",
    "sales",
    "orders",
    "orderCount",
    "order_count",
    "salesVolume",
    "sales_volume",
  ]);
  const soldLabel = firstText(record, [
    "soldText",
    "sold_text",
    "salesText",
    "sales_text",
  ]);

  return {
    asin: createStableId(definition.sourceId, productUrl),
    title,
    platform: definition.sourceId,
    brand: firstText(record, [
      "brand",
      "brandName",
      "seller",
      "sellerName",
      "shopName",
      "storeName",
      "companyName",
      "merchant",
      "supplierName",
      "supplier_name",
    ]),
    imageUrl: normalizeUrl(firstImage(record), baseUrl),
    productUrl,
    category: firstText(record, ["category", "categoryName", "category_name"]),
    price: firstNumber(record, [
      "price",
      "salePrice",
      "sale_price",
      "finalPrice",
      "final_price",
      "minPrice",
      "min_price",
      "priceInfo",
      "price_info",
      "displayPrice",
      "discountPrice",
      "discount_price",
    ]),
    currency,
    rating: firstNumber(record, ["rating", "score", "star", "stars"]),
    reviewCount: firstNumber(record, [
      "reviewCount",
      "review_count",
      "ratingCount",
      "rating_count",
      "commentCount",
      "comment_count",
    ]),
    recentPurchaseLowerBound: soldCount,
    recentPurchaseLabel:
      soldLabel || (soldCount !== undefined ? `${soldCount}+ sold` : undefined),
    source: definition.providerKind,
  };
}
