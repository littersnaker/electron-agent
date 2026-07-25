import { createHash } from "node:crypto";
import nodeFetch, {
  type RequestInit as NodeFetchRequestInit,
} from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getCommerceMarketplace } from "../marketplaces";
import type {
  CommerceDataProviderKind,
  CommerceMarketSourceId,
  CommerceProductSignal,
} from "../types";
import type { PlatformConfig } from "./platform-serp";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "./types";

export type SupportedPlatformSource = Extract<
  CommerceMarketSourceId,
  "tiktok-shop" | "temu" | "1688"
>;
type JsonRecord = Record<string, unknown>;

export interface PlatformCrawlerDefinition {
  sourceId: SupportedPlatformSource;
  label: string;
  providerKind: Extract<
    CommerceDataProviderKind,
    | "tiktok-shop-public-page"
    | "temu-public-page"
    | "alibaba-1688-public-page"
  >;
  enabledEnvironmentName: string;
  proxyEnvironmentName: string;
  userAgentEnvironmentName: string;
  searchUrlTemplateEnvironmentName: string;
  defaultSearchUrlTemplate: string;
  browserSearchUrlTemplatesEnvironmentName: string;
  defaultBrowserSearchUrlTemplates: string[];
  productUrlPatterns: RegExp[];
  robotPatterns: RegExp[];
  defaultCurrency?: string;
  keywordMode: "localized" | "english";
  pageParameter: string;
}

interface HtmlCacheEntry {
  expiresAt: number;
  html: string;
  finalUrl: string;
}

interface PlatformPagePayload {
  html: string;
  finalUrl: string;
  status: number;
  usedProxy: boolean;
}

interface CachedProxyAgent {
  proxyUrl: string;
  agent: InstanceType<typeof HttpsProxyAgent>;
}

const DEFAULT_MAX_KEYWORDS = 2;
const DEFAULT_MAX_PAGES_PER_KEYWORD = 2;
const DEFAULT_REQUEST_INTERVAL_MS = 1_500;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1_000;
const MAX_HTTP_RETRIES = 1;
const MAX_JSON_OBJECTS = 40_000;
const MAX_ANCHOR_MATCHES = 2_000;

const htmlCache = new Map<string, HtmlCacheEntry>();
let requestStartQueue: Promise<void> = Promise.resolve();
let lastRequestStartedAt = 0;
const proxyAgents = new Map<string, CachedProxyAgent>();
const invalidProxyWarnings = new Set<string>();

export const PLATFORM_CRAWLER_DEFINITIONS: Record<
  SupportedPlatformSource,
  PlatformCrawlerDefinition
> = {
  "tiktok-shop": {
    sourceId: "tiktok-shop",
    label: "TikTok Shop",
    providerKind: "tiktok-shop-public-page",
    enabledEnvironmentName: "TIKTOK_SHOP_PUBLIC_RESEARCH_ENABLED",
    proxyEnvironmentName: "TIKTOK_SHOP_CRAWLER_PROXY_URL",
    userAgentEnvironmentName: "TIKTOK_SHOP_CRAWLER_USER_AGENT",
    searchUrlTemplateEnvironmentName:
      "TIKTOK_SHOP_CRAWLER_SEARCH_URL_TEMPLATE",
    defaultSearchUrlTemplate:
      "https://shop.tiktok.com/us/search?q={keyword}&page={page}",
    browserSearchUrlTemplatesEnvironmentName:
      "TIKTOK_SHOP_BROWSER_SEARCH_URL_TEMPLATES",
    defaultBrowserSearchUrlTemplates: [
      "https://www.tiktok.com/shop/search?q={keyword}",
      "https://shop.tiktok.com/us/search?q={keyword}&page={page}",
    ],
    productUrlPatterns: [
      /shop\.tiktok\.com\/[a-z]{2}\/view\/product\//iu,
      /shop\.tiktok\.com\/view\/product\//iu,
      /tiktok\.com\/shop\/pdp\//iu,
      /\/view\/product\/\d+/iu,
    ],
    robotPatterns: [
      /verify to continue/iu,
      /security verification/iu,
      /captcha/iu,
      /access denied/iu,
    ],
    keywordMode: "english",
    pageParameter: "page",
  },
  temu: {
    sourceId: "temu",
    label: "Temu",
    providerKind: "temu-public-page",
    enabledEnvironmentName: "TEMU_PUBLIC_RESEARCH_ENABLED",
    proxyEnvironmentName: "TEMU_CRAWLER_PROXY_URL",
    userAgentEnvironmentName: "TEMU_CRAWLER_USER_AGENT",
    searchUrlTemplateEnvironmentName: "TEMU_CRAWLER_SEARCH_URL_TEMPLATE",
    defaultSearchUrlTemplate:
      "https://www.temu.com/search_result.html?search_key={keyword}&page={page}",
    browserSearchUrlTemplatesEnvironmentName:
      "TEMU_BROWSER_SEARCH_URL_TEMPLATES",
    defaultBrowserSearchUrlTemplates: [
      "https://www.temu.com/search_result.html?search_key={keyword}&page={page}",
    ],
    productUrlPatterns: [
      /temu\.com\/[^\s"']*-g-\d+\.html/iu,
      /temu\.com\/goods\.html/iu,
      /\/[^\s"']*-g-\d+\.html/iu,
      /goods_id=\d+/iu,
    ],
    robotPatterns: [
      /verify you are human/iu,
      /security check/iu,
      /captcha/iu,
      /access denied/iu,
    ],
    keywordMode: "english",
    pageParameter: "page",
  },
  "1688": {
    sourceId: "1688",
    label: "1688",
    providerKind: "alibaba-1688-public-page",
    enabledEnvironmentName: "ALIBABA_1688_PUBLIC_RESEARCH_ENABLED",
    proxyEnvironmentName: "ALIBABA_1688_CRAWLER_PROXY_URL",
    userAgentEnvironmentName: "ALIBABA_1688_CRAWLER_USER_AGENT",
    searchUrlTemplateEnvironmentName: "ALIBABA_1688_CRAWLER_SEARCH_URL_TEMPLATE",
    defaultSearchUrlTemplate:
      "https://s.1688.com/selloffer/offer_search.htm?keywords={keyword}&beginPage={page}",
    browserSearchUrlTemplatesEnvironmentName:
      "ALIBABA_1688_BROWSER_SEARCH_URL_TEMPLATES",
    defaultBrowserSearchUrlTemplates: [
      "https://s.1688.com/selloffer/offer_search.htm?keywords={keyword}&beginPage={page}",
    ],
    productUrlPatterns: [
      /detail\.1688\.com\/offer\/\d+\.html/iu,
      /\/offer\/\d+\.html/iu,
      /offerId=\d+/iu,
    ],
    robotPatterns: [
      /punish/iu,
      /bixi\.alicdn\.com/iu,
      /滑动验证/u,
      /验证码/u,
      /访问过于频繁/u,
      /captcha/iu,
    ],
    defaultCurrency: "CNY",
    keywordMode: "localized",
    pageParameter: "beginPage",
  },
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function decodeHtml(value: string): string {
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

function stripTags(value: string): string {
  return decodeHtml(
    value
      .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
      .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
      .replace(/<[^>]+>/gu, " "),
  );
}

function readBoundedInteger(
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

function isEnabled(environmentName: string): boolean {
  const raw = process.env[environmentName]?.trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

function readText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = decodeHtml(value);
    return normalized || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
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

function firstText(
  record: JsonRecord,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = readText(record[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

function firstNumber(
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

function firstImage(record: JsonRecord): string | undefined {
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

function normalizeUrl(value: string | undefined, baseUrl: URL): string | undefined {
  if (!value) return undefined;
  const decoded = decodeHtml(value);
  if (/^(?:javascript:|data:|#)/iu.test(decoded)) return undefined;
  try {
    return new URL(decoded, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function matchesProductUrl(
  value: string,
  definition: PlatformCrawlerDefinition,
): boolean {
  return definition.productUrlPatterns.some((pattern) => pattern.test(value));
}

function createStableId(sourceId: SupportedPlatformSource, value: string): string {
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

function parsePriceFromText(value: string): number | undefined {
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

function parseRatingFromText(value: string): number | undefined {
  const match =
    /(?:rating|rated|评分|星级|stars?)\D{0,12}([0-5](?:\.[0-9])?)/iu.exec(
      value,
    ) || /([0-5](?:\.[0-9])?)\s*(?:out of 5|stars?|分)/iu.exec(value);
  return match?.[1] ? readNumber(match[1]) : undefined;
}

function parseReviewCountFromText(value: string): number | undefined {
  const match =
    /([0-9]+(?:[.,][0-9]+)?\s*[KkMm万]?\+?)\s*(?:reviews?|ratings?|评价|条评价)/iu.exec(
      value,
    );
  return match?.[1] ? readNumber(match[1]) : undefined;
}

function parseSoldSignalFromText(
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

function readHtmlAttribute(tag: string, attributeName: string): string | undefined {
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "iu",
  );
  const match = pattern.exec(tag);
  const value = match?.[1] ?? match?.[2];
  return value ? decodeHtml(value) : undefined;
}

function buildProductUrlFromRecord(
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

function productFromJsonRecord(
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

function collectJsonObjects(value: unknown): JsonRecord[] {
  const objects: JsonRecord[] = [];
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new Set<object>();

  while (stack.length && objects.length < MAX_JSON_OBJECTS) {
    const current = stack.pop();
    if (!current || current.depth > 14) continue;
    const item = current.value;

    if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(item) || visited.has(item)) continue;
    visited.add(item);
    objects.push(item);

    for (const child of Object.values(item)) {
      if (child && typeof child === "object") {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }

  return objects;
}

function extractJsonScriptPayloads(html: string): unknown[] {
  const payloads: unknown[] = [];
  const scripts = html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/giu,
  );

  for (const match of scripts) {
    const attributes = match[1] || "";
    const body = (match[2] || "").trim();
    if (!body || body.length > 15_000_000) continue;

    const type = readHtmlAttribute(`<script ${attributes}>`, "type") || "";
    const id = readHtmlAttribute(`<script ${attributes}>`, "id") || "";
    const looksLikeJson =
      /application\/(?:ld\+)?json/iu.test(type) ||
      /__NEXT_DATA__|__NUXT_DATA__|SIGI_STATE|INIT_DATA|SSR_DATA/iu.test(id);
    if (!looksLikeJson && !/^[\[{]/u.test(body)) continue;

    try {
      payloads.push(JSON.parse(body) as unknown);
    } catch {
      // 部分站点把 JSON 包在 JavaScript 赋值语句中。这里只解析首尾明确的对象/数组，
      // 不执行页面脚本，避免把爬虫变成任意代码执行器。
      const objectStart = body.indexOf("{");
      const arrayStart = body.indexOf("[");
      const start =
        objectStart < 0
          ? arrayStart
          : arrayStart < 0
            ? objectStart
            : Math.min(objectStart, arrayStart);
      const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
      if (start < 0 || end <= start) continue;
      try {
        payloads.push(JSON.parse(body.slice(start, end + 1)) as unknown);
      } catch {
        // 无法安全解析的脚本直接跳过；后续仍会使用 HTML 卡片解析。
      }
    }
  }

  return payloads;
}

export function parsePlatformJsonPayload(
  payload: unknown,
  definition: PlatformCrawlerDefinition,
  baseUrl: URL,
  currency: string,
): CommerceProductSignal[] {
  const products: CommerceProductSignal[] = [];
  for (const record of collectJsonObjects(payload)) {
    const product = productFromJsonRecord(
      record,
      definition,
      baseUrl,
      currency,
    );
    if (product) products.push(product);
  }
  return products;
}

function extractProductsFromJson(
  html: string,
  definition: PlatformCrawlerDefinition,
  baseUrl: URL,
  currency: string,
): CommerceProductSignal[] {
  return extractJsonScriptPayloads(html).flatMap((payload) =>
    parsePlatformJsonPayload(payload, definition, baseUrl, currency),
  );
}

function extractProductsFromAnchors(
  html: string,
  definition: PlatformCrawlerDefinition,
  baseUrl: URL,
  currency: string,
): CommerceProductSignal[] {
  const products: CommerceProductSignal[] = [];
  const anchorPattern = /<a\b([^>]*\bhref\s*=\s*(?:"[^"]+"|'[^']+')[^>]*)>([\s\S]*?)<\/a>/giu;
  let matchCount = 0;

  for (const match of html.matchAll(anchorPattern)) {
    matchCount += 1;
    if (matchCount > MAX_ANCHOR_MATCHES) break;

    const openingTag = `<a ${match[1] || ""}>`;
    const href = readHtmlAttribute(openingTag, "href");
    const productUrl = normalizeUrl(href, baseUrl);
    if (!productUrl || !matchesProductUrl(productUrl, definition)) continue;

    const body = match[2] || "";
    const title =
      readHtmlAttribute(openingTag, "aria-label") ||
      readHtmlAttribute(openingTag, "title") ||
      stripTags(body);
    if (!title || title.length < 3 || title.length > 500) continue;

    const index = match.index || 0;
    const context = html.slice(
      Math.max(0, index - 800),
      Math.min(html.length, index + match[0].length + 2_000),
    );
    const contextText = stripTags(context);
    const imageTag = /<img\b[^>]*>/iu.exec(body)?.[0] ||
      /<img\b[^>]*>/iu.exec(context)?.[0];
    const imageUrl = imageTag
      ? normalizeUrl(
          readHtmlAttribute(imageTag, "src") ||
            readHtmlAttribute(imageTag, "data-src") ||
            readHtmlAttribute(imageTag, "data-original"),
          baseUrl,
        )
      : undefined;
    const reviewCount = parseReviewCountFromText(contextText);
    const soldSignal = parseSoldSignalFromText(contextText);

    products.push({
      asin: createStableId(definition.sourceId, productUrl),
      title,
      platform: definition.sourceId,
      imageUrl,
      productUrl,
      price: parsePriceFromText(contextText),
      currency,
      rating: parseRatingFromText(contextText),
      reviewCount,
      recentPurchaseLowerBound: soldSignal.count,
      recentPurchaseLabel: soldSignal.label,
      source: definition.providerKind,
    });
  }

  return products;
}

export function mergePlatformProducts(
  products: CommerceProductSignal[],
  sampleSize: number,
): CommerceProductSignal[] {
  const map = new Map<string, CommerceProductSignal>();
  for (const product of products) {
    const key = product.productUrl || product.asin;
    const current = map.get(key);
    map.set(
      key,
      current
        ? {
            ...current,
            ...product,
            brand: product.brand ?? current.brand,
            imageUrl: product.imageUrl ?? current.imageUrl,
            price: product.price ?? current.price,
            rating: product.rating ?? current.rating,
            reviewCount: product.reviewCount ?? current.reviewCount,
            recentPurchaseLowerBound:
              product.recentPurchaseLowerBound ??
              current.recentPurchaseLowerBound,
            recentPurchaseLabel:
              product.recentPurchaseLabel ?? current.recentPurchaseLabel,
          }
        : product,
    );
  }
  return Array.from(map.values()).slice(0, sampleSize);
}

function abortError(): Error {
  const error = new Error("平台爬虫请求已取消。");
  error.name = "AbortError";
  return error;
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const handleAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
      reject(abortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function waitForRequestSlot(signal?: AbortSignal): Promise<void> {
  const interval = readBoundedInteger(
    "COMMERCE_CRAWLER_REQUEST_INTERVAL_MS",
    DEFAULT_REQUEST_INTERVAL_MS,
    250,
    15_000,
  );
  const scheduled = requestStartQueue.then(async () => {
    const waitTime = Math.max(0, lastRequestStartedAt + interval - Date.now());
    if (waitTime > 0) await sleep(waitTime, signal);
    if (signal?.aborted) throw abortError();
    lastRequestStartedAt = Date.now();
  });
  requestStartQueue = scheduled.catch(() => undefined);
  await scheduled;
}

function createRequestSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parentSignal?.reason);
  const timeout = setTimeout(
    () => controller.abort(new Error(`${label} 爬虫请求超时。`)),
    timeoutMs,
  );

  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function matchesNoProxy(hostname: string): boolean {
  const rules = (process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",")
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean);
  const normalizedHost = hostname.toLowerCase();
  return rules.some((rule) => {
    if (rule === "*") return true;
    const hostRule = rule.split(":")[0]?.replace(/^\./u, "");
    return Boolean(
      hostRule &&
        (normalizedHost === hostRule ||
          normalizedHost.endsWith(`.${hostRule}`)),
    );
  });
}

export function resolvePlatformCrawlerProxyUrl(
  url: URL,
  definition: PlatformCrawlerDefinition,
): string | undefined {
  if (matchesNoProxy(url.hostname)) return undefined;

  return (
    process.env[definition.proxyEnvironmentName]?.trim() ||
    process.env.COMMERCE_CRAWLER_PROXY_URL?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    undefined
  );
}

function resolveProxyAgent(
  url: URL,
  definition: PlatformCrawlerDefinition,
): CachedProxyAgent | undefined {
  const proxyUrl = resolvePlatformCrawlerProxyUrl(url, definition);
  if (!proxyUrl) return undefined;

  try {
    const parsed = new URL(proxyUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("代理协议必须是 http 或 https");
    }
  } catch {
    if (!invalidProxyWarnings.has(definition.sourceId)) {
      invalidProxyWarnings.add(definition.sourceId);
      console.warn(
        `[Commerce/${definition.label}Crawler] 代理地址格式无效，本轮改用直连。`,
      );
    }
    return undefined;
  }

  const cacheKey = `${definition.sourceId}:${proxyUrl}`;
  const cached = proxyAgents.get(cacheKey);
  if (cached) return cached;
  const created = {
    proxyUrl,
    agent: new HttpsProxyAgent(proxyUrl, { keepAlive: true }),
  };
  proxyAgents.set(cacheKey, created);
  return created;
}

export function resolvePlatformCrawlerUserAgent(
  definition: PlatformCrawlerDefinition,
): string {
  return (
    process.env[definition.userAgentEnvironmentName]?.trim() ||
    process.env.COMMERCE_CRAWLER_USER_AGENT?.trim() ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  );
}

function buildHeaders(
  url: URL,
  definition: PlatformCrawlerDefinition,
  locale: string,
): Record<string, string> {
  const normalizedLocale = locale.replace("_", "-");
  return {
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": `${normalizedLocale},en;q=0.8,zh-CN;q=0.6`,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Referer: `https://${url.hostname}/`,
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": resolvePlatformCrawlerUserAgent(definition),
  };
}

function readCachedPage(cacheKey: string): HtmlCacheEntry | undefined {
  const cached = htmlCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    htmlCache.delete(cacheKey);
    return undefined;
  }
  return cached;
}

function writeCachedPage(
  cacheKey: string,
  html: string,
  finalUrl: string,
): void {
  const ttl = readBoundedInteger(
    "COMMERCE_CRAWLER_CACHE_TTL_MS",
    DEFAULT_CACHE_TTL_MS,
    30_000,
    60 * 60 * 1_000,
  );
  if (htmlCache.size >= 180) {
    const firstKey = htmlCache.keys().next().value as string | undefined;
    if (firstKey) htmlCache.delete(firstKey);
  }
  htmlCache.set(cacheKey, {
    html,
    finalUrl,
    expiresAt: Date.now() + ttl,
  });
}

export function assertPlatformPageUsable(
  html: string,
  finalUrl: string,
  definition: PlatformCrawlerDefinition,
): void {
  if (!html.trim()) throw new Error(`${definition.label} 返回了空页面。`);
  const normalized = `${finalUrl}\n${stripTags(html).slice(0, 20_000)}`;
  if (definition.robotPatterns.some((pattern) => pattern.test(normalized))) {
    throw new Error(
      `${definition.label} 返回了风控、验证码或访问限制页。爬虫不会绕过验证，请降低频率、使用合规网络出口或配置 API。`,
    );
  }
  if (/\/login|\/signin|passport/iu.test(finalUrl)) {
    throw new Error(
      `${definition.label} 将公开搜索页重定向到登录页，当前网络无法匿名采集。`,
    );
  }
}

function formatNetworkFailure(
  error: unknown,
  definition: PlatformCrawlerDefinition,
  usedProxy: boolean,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && "cause" in error
      ? (error.cause as { code?: unknown; message?: unknown } | undefined)
      : undefined;
  const details = [
    typeof cause?.code === "string" ? cause.code : undefined,
    typeof cause?.message === "string" ? cause.message : undefined,
    message,
  ]
    .filter(Boolean)
    .join(" / ");
  return `${definition.label} 页面网络请求失败${usedProxy ? "（已使用代理）" : "（直连）"}：${details}`;
}

async function fetchPlatformPage(
  url: URL,
  definition: PlatformCrawlerDefinition,
  locale: string,
  signal?: AbortSignal,
): Promise<PlatformPagePayload> {
  const cacheKey = `${definition.sourceId}:${url.toString()}`;
  const cached = readCachedPage(cacheKey);
  if (cached) {
    return {
      html: cached.html,
      finalUrl: cached.finalUrl,
      status: 200,
      usedProxy: Boolean(resolveProxyAgent(url, definition)),
    };
  }

  const timeoutMs = readBoundedInteger(
    "COMMERCE_CRAWLER_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
    3_000,
    60_000,
  );
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt += 1) {
    await waitForRequestSlot(signal);
    const requestSignal = createRequestSignal(
      signal,
      timeoutMs,
      definition.label,
    );
    const proxy = resolveProxyAgent(url, definition);
    const usedProxy = Boolean(proxy);

    try {
      const headers = buildHeaders(url, definition, locale);
      const response = proxy
        ? await nodeFetch(url.toString(), {
            headers,
            redirect: "follow",
            signal: requestSignal.signal as NodeFetchRequestInit["signal"],
            agent: proxy.agent,
          })
        : await fetch(url, {
            headers,
            redirect: "follow",
            signal: requestSignal.signal,
          });
      const html = await response.text();
      const finalUrl = response.url || url.toString();

      if (!response.ok) {
        throw new Error(
          `${definition.label} 返回 HTTP ${response.status} ${response.statusText}`,
        );
      }
      assertPlatformPageUsable(html, finalUrl, definition);
      writeCachedPage(cacheKey, html, finalUrl);
      return {
        html,
        finalUrl,
        status: response.status,
        usedProxy,
      };
    } catch (error) {
      lastError = new Error(
        formatNetworkFailure(error, definition, usedProxy),
      );
      if (attempt < MAX_HTTP_RETRIES) await sleep(700, signal);
    } finally {
      requestSignal.cleanup();
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${definition.label} 页面请求失败。`);
}

export function resolvePlatformCrawlerKeywords(
  input: CommerceProviderSearchInput,
  definition: PlatformCrawlerDefinition,
): string[] {
  const candidates =
    definition.keywordMode === "localized"
      ? [
          input.category.categoryName,
          ...input.category.keywords,
          input.category.categoryNameEn,
        ]
      : [
          ...input.category.keywords,
          input.category.categoryNameEn,
          input.category.categoryName,
        ];
  const maximum = readBoundedInteger(
    "COMMERCE_CRAWLER_MAX_KEYWORDS",
    DEFAULT_MAX_KEYWORDS,
    1,
    5,
  );
  return Array.from(
    new Set(candidates.map((item) => item.trim()).filter(Boolean)),
  ).slice(0, maximum);
}

export function resolvePlatformBrowserSearchTemplates(
  definition: PlatformCrawlerDefinition,
): string[] {
  const configured =
    process.env[definition.browserSearchUrlTemplatesEnvironmentName]?.trim();
  if (!configured) return definition.defaultBrowserSearchUrlTemplates;

  return configured
    .split(/\r?\n|\|/gu)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildPlatformSearchUrl(
  definition: PlatformCrawlerDefinition,
  keyword: string,
  page: number,
  templateOverride?: string,
): URL {
  const template =
    templateOverride ||
    process.env[definition.searchUrlTemplateEnvironmentName]?.trim() ||
    definition.defaultSearchUrlTemplate;
  const encodedKeyword = encodeURIComponent(keyword);
  const value = template
    .replaceAll("{keyword}", encodedKeyword)
    .replaceAll("{page}", String(page));
  const url = new URL(value);

  // 自定义模板可能没有页码占位符。此时统一补上平台定义的分页参数。
  if (!template.includes("{page}")) {
    url.searchParams.set(definition.pageParameter, String(page));
  }
  return url;
}

export function parsePlatformPage(
  html: string,
  definition: PlatformCrawlerDefinition,
  pageUrl: URL,
  currency: string,
): CommerceProductSignal[] {
  return mergePlatformProducts(
    [
      ...extractProductsFromJson(html, definition, pageUrl, currency),
      ...extractProductsFromAnchors(html, definition, pageUrl, currency),
    ],
    Number.MAX_SAFE_INTEGER,
  );
}

/**
 * TikTok Shop / Temu / 1688 公开页面爬虫。
 *
 * 设计边界：
 * - 只采集无需登录即可看见的搜索结果与嵌入 JSON；
 * - 不携带账号 Cookie，不绕过验证码，不做浏览器指纹伪造；
 * - 支持项目已有代理变量、固定限速、超时、重试和短时缓存；
 * - 页面结构变化时返回结构化错误，由 Auto Provider 记录完整 API → 爬虫诊断。
 */
export class PlatformPublicPageProvider implements CommerceDataProvider {
  readonly kind: CommerceDataProviderKind;
  private readonly definition: PlatformCrawlerDefinition;

  constructor(config: PlatformConfig) {
    this.definition = PLATFORM_CRAWLER_DEFINITIONS[config.sourceId];
    this.kind = this.definition.providerKind;
  }

  isConfigured(): boolean {
    return isEnabled(this.definition.enabledEnvironmentName);
  }

  async searchProducts(
    input: CommerceProviderSearchInput,
  ): Promise<CommerceProviderSearchResult> {
    const market = getCommerceMarketplace(input.marketplace);
    const currency = this.definition.defaultCurrency || market.currency;
    const keywords = resolvePlatformCrawlerKeywords(input, this.definition);
    const maxPages = readBoundedInteger(
      "COMMERCE_CRAWLER_MAX_PAGES_PER_KEYWORD",
      DEFAULT_MAX_PAGES_PER_KEYWORD,
      1,
      5,
    );
    const products: CommerceProductSignal[] = [];
    const warnings: string[] = [];

    for (const keyword of keywords) {
      for (let page = 1; page <= maxPages; page += 1) {
        if (mergePlatformProducts(products, input.sampleSize).length >= input.sampleSize) {
          break;
        }
        const searchUrl = buildPlatformSearchUrl(this.definition, keyword, page);
        try {
          console.info(
            `[Commerce/${this.definition.label}Crawler] 抓取关键词“${keyword}”第 ${page} 页。`,
          );
          const payload = await fetchPlatformPage(
            searchUrl,
            this.definition,
            market.locale,
            input.signal,
          );
          const pageProducts = parsePlatformPage(
            payload.html,
            this.definition,
            new URL(payload.finalUrl),
            currency,
          );
          products.push(...pageProducts);
          warnings.push(
            `${this.definition.label} 公开页“${keyword}”第 ${page} 页解析 ${pageProducts.length} 个商品${payload.usedProxy ? "（代理）" : "（直连）"}。`,
          );
        } catch (error) {
          warnings.push(
            `${this.definition.label}“${keyword}”第 ${page} 页：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    const unique = mergePlatformProducts(products, input.sampleSize);
    if (!unique.length) {
      throw new Error(
        `${this.definition.label} 公开页面爬虫没有解析出商品样本。可能原因包括页面仅返回 JavaScript 壳、地区不可用、登录重定向、网络限制或页面结构变化。${warnings.length ? ` 诊断：${warnings.join("；")}` : ""}`,
      );
    }

    return {
      provider: this.definition.providerKind,
      sourceId: this.definition.sourceId,
      crawlerEngine: "http",
      products: unique,
      coverage: [
        "公开商品标题",
        "商品链接",
        "图片",
        "可解析价格",
        "可解析评分/评论/销量文案",
      ],
      warnings: [
        `${this.definition.label} 当前使用无需 API 的公开页面爬虫；字段只代表采集时公开可见信息，不代表平台完整销量、GMV 或市场份额。`,
        ...warnings,
      ],
    };
  }
}

/** 供无网络回归测试验证三类页面解析，不对业务层暴露内部实现。 */
export const platformCrawlerParserTestUtils = {
  extractJsonScriptPayloads,
  extractProductsFromAnchors,
  extractProductsFromJson,
  parsePage(
    sourceId: SupportedPlatformSource,
    html: string,
    pageUrl: string,
    currency: string,
  ): CommerceProductSignal[] {
    return parsePlatformPage(
      html,
      PLATFORM_CRAWLER_DEFINITIONS[sourceId],
      new URL(pageUrl),
      currency,
    );
  },
};
