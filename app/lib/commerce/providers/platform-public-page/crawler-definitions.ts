/**
 * 模块职责：平台爬虫类型、配置和平台定义。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { HttpsProxyAgent } from "https-proxy-agent";
import type { CommerceDataProviderKind, CommerceMarketSourceId } from "../../types";
export type SupportedPlatformSource = Extract<
  CommerceMarketSourceId,
  "tiktok-shop" | "temu" | "1688"
>;

export type JsonRecord = Record<string, unknown>;

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

export interface HtmlCacheEntry {
  expiresAt: number;
  html: string;
  finalUrl: string;
}

export interface PlatformPagePayload {
  html: string;
  finalUrl: string;
  status: number;
  usedProxy: boolean;
}

export interface CachedProxyAgent {
  proxyUrl: string;
  agent: InstanceType<typeof HttpsProxyAgent>;
}

export const DEFAULT_MAX_KEYWORDS = 2;

export const DEFAULT_MAX_PAGES_PER_KEYWORD = 2;

export const DEFAULT_REQUEST_INTERVAL_MS = 1_500;

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1_000;

export const MAX_HTTP_RETRIES = 1;

export const MAX_JSON_OBJECTS = 40_000;

export const MAX_ANCHOR_MATCHES = 2_000;

export const htmlCache = new Map<string, HtmlCacheEntry>();

export const crawlerRequestState = {
  requestStartQueue: Promise.resolve() as Promise<void>,
  lastRequestStartedAt: 0,
};

export const proxyAgents = new Map<string, CachedProxyAgent>();

export const invalidProxyWarnings = new Set<string>();

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
