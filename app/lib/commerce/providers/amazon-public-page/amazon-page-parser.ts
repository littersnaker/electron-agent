/**
 * 模块职责：亚马逊搜索页与详情页 HTML 解析。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */

import type { HttpsProxyAgent } from "https-proxy-agent";
import type { CommerceProductSignal } from "../../types";
export const DEFAULT_MAX_SEARCH_KEYWORDS = 3;

export const DEFAULT_MAX_SEARCH_PAGES_PER_KEYWORD = 2;

export const DEFAULT_MAX_DETAIL_ENRICHMENT = 10;

export const DEFAULT_DETAIL_CONCURRENCY = 2;

export const DEFAULT_REQUEST_INTERVAL_MS = 1_200;

export const DEFAULT_REQUEST_TIMEOUT_MS = 18_000;

export const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1_000;

export const MAX_HTTP_RETRIES = 1;

export interface HtmlCacheEntry {
  expiresAt: number;
  html: string;
}

export interface AmazonPageResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}

export interface AmazonPagePayload {
  html: string;
  finalUrl: string;
  status: number;
  usedProxy: boolean;
}

export interface CachedProxyAgent {
  proxyUrl: string;
  agent: InstanceType<typeof HttpsProxyAgent>;
}

/**
 * 进程内短时缓存用于避免同一轮对话重复请求同一个搜索页或商品页。
 * 缓存只存在于本地 Next.js 进程，不会写入用户目录，也不会跨设备共享。
 */
export const htmlCache = new Map<string, HtmlCacheEntry>();

/**
 * 所有爬虫请求共用一个起始时间队列，确保请求之间至少保留固定间隔。
 * 这是限速保护，不包含代理轮换、指纹伪造或验证码绕过。
 */
export const amazonCrawlerRuntimeState = {
  requestStartQueue: Promise.resolve() as Promise<void>,
  lastRequestStartedAt: 0,
  cachedProxyAgent: undefined as CachedProxyAgent | undefined,
  invalidProxyWarningPrinted: false,
};

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

export function decodeHtml(value: string): string {
  return value
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
  return decodeHtml(value.replace(/<[^>]+>/gu, " "));
}

export function readFirstMatch(value: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(value);
  return match?.[1] ? stripTags(match[1]) : undefined;
}

export function readNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[^0-9.,]/gu, "").replace(/,/gu, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

export function readCompactNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/,/gu, "");
  const match = /^([0-9]+(?:\.[0-9]+)?)([KkMm])?\+?$/u.exec(normalized);
  if (!match) return undefined;

  const number = Number(match[1]);
  if (!Number.isFinite(number)) return undefined;
  const multiplier =
    match[2]?.toLowerCase() === "m"
      ? 1_000_000
      : match[2]?.toLowerCase() === "k"
        ? 1_000
        : 1;
  return Math.round(number * multiplier);
}

/**
 * HTML 属性顺序不稳定，Amazon 真实页面经常把 data-asin 放在
 * data-component-type 前面。统一通过属性读取器解析，禁止依赖固定顺序。
 */
export function readHtmlAttribute(tag: string, attributeName: string): string | undefined {
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `\\b${escapedName}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')`,
    "iu",
  );
  const match = pattern.exec(tag);
  const value = match?.[1] ?? match?.[2];
  return value ? decodeHtml(value) : undefined;
}

export function parseRecentPurchaseSignal(html: string): {
  lowerBound?: number;
  label?: string;
} {
  const label = readFirstMatch(
    html,
    /([0-9]+(?:[.,][0-9]+)?\s*[KkMm]?\+?\s+(?:bought in past month|purchased in the past month))/iu,
  );
  if (!label) return {};

  const amount = /^([0-9]+(?:[.,][0-9]+)?\s*[KkMm]?\+?)/iu.exec(label)?.[1];
  return {
    lowerBound: readCompactNumber(amount?.replace(/\s+/gu, "")),
    label,
  };
}

export function parseBadges(html: string): string[] {
  const candidates = [
    /Amazon(?:'|’)?s Choice/iu,
    /#1 Best Seller/iu,
    /Best Seller/iu,
    /Sponsored/iu,
  ];
  const plainText = stripTags(html);

  return Array.from(
    new Set(
      candidates.flatMap((pattern) => {
        const match = pattern.exec(plainText);
        return match?.[0] ? [match[0]] : [];
      }),
    ),
  );
}

export function parseBulletPoints(html: string): string[] {
  const featureSection = /id="feature-bullets"[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/iu.exec(
    html,
  )?.[1];
  if (!featureSection) return [];

  return Array.from(
    featureSection.matchAll(
      /<span[^>]+class="[^"]*a-list-item[^"]*"[^>]*>([\s\S]*?)<\/span>/giu,
    ),
  )
    .map((match) => stripTags(match[1] || ""))
    .filter((value) => value.length >= 3)
    .slice(0, 8);
}

export function parseImageUrl(html: string): string | undefined {
  const imageTags = Array.from(html.matchAll(/<img\b[^>]*>/giu)).map(
    (match) => match[0],
  );
  const preferred =
    imageTags.find((tag) =>
      /\bs-image\b|data-image-latency\s*=\s*["']s-product-image["']/iu.test(
        tag,
      ),
    ) || imageTags[0];
  if (!preferred) return undefined;
  return (
    readHtmlAttribute(preferred, "src") ||
    readHtmlAttribute(preferred, "data-src")
  );
}

export function parseSearchResultBlock(
  asin: string,
  html: string,
  marketplaceDomain: string,
  currency: string,
): CommerceProductSignal | null {
  const title =
    readFirstMatch(
      html,
      /data-cy="title-recipe"[\s\S]{0,1200}?<span[^>]*>([\s\S]*?)<\/span>/iu,
    ) ||
    readFirstMatch(
      html,
      /<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/iu,
    ) ||
    readFirstMatch(
      html,
      /class="[^"]*a-size-(?:medium|base-plus)[^"]*"[^>]*>([\s\S]*?)<\//iu,
    ) ||
    readFirstMatch(
      html,
      /<a[^>]+class="[^"]*s-link-style[^"]*"[^>]+aria-label="([^"]+)"/iu,
    );
  if (!title) return null;

  const whole = readFirstMatch(
    html,
    /class="a-price-whole"[^>]*>([\s\S]*?)<\/span>/iu,
  );
  const fraction = readFirstMatch(
    html,
    /class="a-price-fraction"[^>]*>([\s\S]*?)<\/span>/iu,
  );
  const offscreenPrice = readFirstMatch(
    html,
    /class="a-offscreen"[^>]*>([^<]*[0-9][^<]*)<\/span>/iu,
  );
  const price =
    readNumber(whole ? `${whole}.${fraction ?? "00"}` : undefined) ??
    readNumber(offscreenPrice);
  const rating = readNumber(
    readFirstMatch(
      html,
      /(?:aria-label|title)="([0-9.,]+)\s*(?:out of 5 stars|von 5 Sternen|sur 5 étoiles|su 5 stelle|de 5 estrellas|5つ星のうち)/iu,
    ),
  );
  const reviewCount =
    readNumber(
      readFirstMatch(
        html,
        /aria-label="([0-9.,]+)\s+(?:ratings?|reviews?)"/iu,
      ),
    ) ??
    readNumber(
      readFirstMatch(
        html,
        /class="[^"]*(?:s-underline-text|a-size-base s-underline-text)[^"]*"[^>]*>([0-9.,]+)<\/span>/iu,
      ),
    );
  const purchaseSignal = parseRecentPurchaseSignal(html);

  return {
    asin,
    platform: "amazon",
    title,
    price,
    currency: price !== undefined ? currency : undefined,
    rating,
    reviewCount,
    imageUrl: parseImageUrl(html),
    recentPurchaseLowerBound: purchaseSignal.lowerBound,
    recentPurchaseLabel: purchaseSignal.label,
    badges: parseBadges(html),
    productUrl: `https://${marketplaceDomain}/dp/${asin}`,
    source: "amazon-public-page",
  };
}

/**
 * 从搜索页提取商品卡片。
 *
 * 旧实现使用单个正则并假定属性顺序为：
 * data-component-type -> data-asin。真实 Amazon 页面常为相反顺序，导致整页被误判为 0 条。
 * 新实现先提取所有 div 起始标签，再独立读取属性，因此属性顺序、单双引号变化都不会影响。
 */
export function extractSearchResultBlocks(html: string): Array<{
  asin: string;
  html: string;
}> {
  const allDivTags = Array.from(html.matchAll(/<div\b[^>]*>/giu));
  const markers = allDivTags.flatMap((match) => {
    const tag = match[0];
    const asin = readHtmlAttribute(tag, "data-asin")?.toUpperCase();
    if (!asin || !/^[A-Z0-9]{10}$/u.test(asin)) return [];

    const componentType = readHtmlAttribute(tag, "data-component-type");
    const className = readHtmlAttribute(tag, "class") || "";
    const dataCy = readHtmlAttribute(tag, "data-cy");
    const isSearchResult =
      componentType === "s-search-result" ||
      /(?:^|\s)s-result-item(?:\s|$)/u.test(className) ||
      dataCy === "asin-faceout-container";
    if (!isSearchResult) return [];

    return [
      {
        asin,
        index: match.index || 0,
      },
    ];
  });

  return markers.map((marker, index) => {
    const end = markers[index + 1]?.index || html.length;
    return {
      asin: marker.asin,
      html: html.slice(marker.index, end),
    };
  });
}

export function assertNotRobotPage(html: string): void {
  if (
    /robot check|enter the characters you see below|captcha|automated access to amazon data/iu.test(
      html,
    )
  ) {
    throw new Error(
      "Amazon 返回了机器人校验或自动访问限制页。爬虫不会绕过验证码，请稍后重试、切换合规网络出口或配置 Amazon API。",
    );
  }
}

export function assertUsableHtml(html: string, finalUrl: string): void {
  if (!html.trim()) {
    throw new Error("Amazon 返回了空页面。");
  }
  assertNotRobotPage(html);

  if (/\/ap\/signin|\/signin/iu.test(finalUrl)) {
    throw new Error("Amazon 将公开页面重定向到了登录页，当前网络出口无法匿名采集。");
  }

  if (/Sorry! Something went wrong|Page Not Found/iu.test(stripTags(html))) {
    throw new Error("Amazon 返回了错误页，未取得可解析的商品内容。");
  }
}

export function parseProductDetail(html: string): Partial<CommerceProductSignal> {
  const rankMatch =
    /Best Sellers Rank[\s\S]{0,1200}?#([0-9,]+)\s+in\s+([^<(]{2,120})/iu.exec(
      html,
    );
  const salesRank = readNumber(rankMatch?.[1]);
  const salesRankCategory = rankMatch?.[2]
    ? decodeHtml(stripTags(rankMatch[2]))
    : undefined;
  const brand =
    readFirstMatch(html, /id="bylineInfo"[^>]*>([\s\S]*?)<\/a>/iu)
      ?.replace(/^(?:Visit the|Brand:)\s+/iu, "")
      .replace(/\s+Store$/iu, "") ||
    readFirstMatch(
      html,
      />\s*Brand\s*<[^>]*>[\s\S]{0,240}?<[^>]*>([\s\S]*?)<\//iu,
    );
  const purchaseSignal = parseRecentPurchaseSignal(html);
  const bulletPoints = parseBulletPoints(html);

  return {
    brand,
    salesRank,
    salesRankCategory,
    recentPurchaseLowerBound: purchaseSignal.lowerBound,
    recentPurchaseLabel: purchaseSignal.label,
    bulletPoints: bulletPoints.length ? bulletPoints : undefined,
  };
}
