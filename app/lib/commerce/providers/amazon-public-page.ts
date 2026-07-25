import nodeFetch, {
  type RequestInit as NodeFetchRequestInit,
} from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getCommerceMarketplace } from "../marketplaces";
import type { CommerceProductSignal } from "../types";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "./types";

const DEFAULT_MAX_SEARCH_KEYWORDS = 3;
const DEFAULT_MAX_SEARCH_PAGES_PER_KEYWORD = 2;
const DEFAULT_MAX_DETAIL_ENRICHMENT = 10;
const DEFAULT_DETAIL_CONCURRENCY = 2;
const DEFAULT_REQUEST_INTERVAL_MS = 1_200;
const DEFAULT_REQUEST_TIMEOUT_MS = 18_000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1_000;
const MAX_HTTP_RETRIES = 1;

interface HtmlCacheEntry {
  expiresAt: number;
  html: string;
}

interface AmazonPageResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}

interface AmazonPagePayload {
  html: string;
  finalUrl: string;
  status: number;
  usedProxy: boolean;
}

interface CachedProxyAgent {
  proxyUrl: string;
  agent: InstanceType<typeof HttpsProxyAgent>;
}

/**
 * 进程内短时缓存用于避免同一轮对话重复请求同一个搜索页或商品页。
 * 缓存只存在于本地 Next.js 进程，不会写入用户目录，也不会跨设备共享。
 */
const htmlCache = new Map<string, HtmlCacheEntry>();

/**
 * 所有爬虫请求共用一个起始时间队列，确保请求之间至少保留固定间隔。
 * 这是限速保护，不包含代理轮换、指纹伪造或验证码绕过。
 */
let requestStartQueue: Promise<void> = Promise.resolve();
let lastRequestStartedAt = 0;
let cachedProxyAgent: CachedProxyAgent | undefined;
let invalidProxyWarningPrinted = false;

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

function decodeHtml(value: string): string {
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

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/gu, " "));
}

function readFirstMatch(value: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(value);
  return match?.[1] ? stripTags(match[1]) : undefined;
}

function readNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[^0-9.,]/gu, "").replace(/,/gu, "");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

function readCompactNumber(value: string | undefined): number | undefined {
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
function readHtmlAttribute(tag: string, attributeName: string): string | undefined {
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `\\b${escapedName}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')`,
    "iu",
  );
  const match = pattern.exec(tag);
  const value = match?.[1] ?? match?.[2];
  return value ? decodeHtml(value) : undefined;
}

function parseRecentPurchaseSignal(html: string): {
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

function parseBadges(html: string): string[] {
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

function parseBulletPoints(html: string): string[] {
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

function parseImageUrl(html: string): string | undefined {
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

function parseSearchResultBlock(
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
function extractSearchResultBlocks(html: string): Array<{
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

function assertNotRobotPage(html: string): void {
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

function assertUsableHtml(html: string, finalUrl: string): void {
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

function parseProductDetail(html: string): Partial<CommerceProductSignal> {
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

function abortError(): Error {
  return new Error("Amazon 爬虫请求已取消。");
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
    "AMAZON_CRAWLER_REQUEST_INTERVAL_MS",
    DEFAULT_REQUEST_INTERVAL_MS,
    250,
    10_000,
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
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parentSignal?.reason);
  const timeout = setTimeout(
    () => controller.abort(new Error("Amazon 爬虫请求超时。")),
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

function readCachedHtml(cacheKey: string): string | undefined {
  const cached = htmlCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    htmlCache.delete(cacheKey);
    return undefined;
  }
  return cached.html;
}

function writeCachedHtml(cacheKey: string, html: string): void {
  const ttl = readBoundedInteger(
    "AMAZON_CRAWLER_CACHE_TTL_MS",
    DEFAULT_CACHE_TTL_MS,
    30_000,
    60 * 60 * 1_000,
  );

  if (htmlCache.size >= 120) {
    const firstKey = htmlCache.keys().next().value as string | undefined;
    if (firstKey) htmlCache.delete(firstKey);
  }
  htmlCache.set(cacheKey, { html, expiresAt: Date.now() + ttl });
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
        (normalizedHost === hostRule || normalizedHost.endsWith(`.${hostRule}`)),
    );
  });
}

/**
 * Node.js 原生 fetch 不会自动使用 HTTP_PROXY / HTTPS_PROXY。
 * 桌面端和公司网络通常依赖这些变量出网，因此这里显式接入项目已有的
 * https-proxy-agent；代理地址只在服务端读取，绝不会写入报告或日志。
 */
function resolveProxyAgent(url: URL): CachedProxyAgent | undefined {
  if (matchesNoProxy(url.hostname)) return undefined;

  const proxyUrl =
    process.env.AMAZON_CRAWLER_PROXY_URL?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim();
  if (!proxyUrl) return undefined;

  try {
    const parsed = new URL(proxyUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("代理协议必须是 http 或 https");
    }
  } catch {
    if (!invalidProxyWarningPrinted) {
      invalidProxyWarningPrinted = true;
      console.warn(
        "[Commerce/AmazonCrawler] 检测到代理变量，但格式无效；本轮改用直连。",
      );
    }
    return undefined;
  }

  if (cachedProxyAgent?.proxyUrl === proxyUrl) return cachedProxyAgent;
  cachedProxyAgent = {
    proxyUrl,
    agent: new HttpsProxyAgent(proxyUrl, { keepAlive: true }),
  };
  return cachedProxyAgent;
}

function buildAmazonHeaders(url: URL, locale: string, currency: string): Record<string, string> {
  const normalizedLocale = locale.replace("_", "-");
  return {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": `${normalizedLocale},en;q=0.8`,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Referer: `https://${url.hostname}/`,
    "Upgrade-Insecure-Requests": "1",
    // 只写公开站点语言和币种偏好，不写账号 Cookie、登录态或设备指纹。
    Cookie: `lc-main=${locale}; i18n-prefs=${currency};`,
    "User-Agent":
      process.env.AMAZON_CRAWLER_USER_AGENT?.trim() ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  };
}

async function requestAmazonPage(
  url: URL,
  locale: string,
  currency: string,
  signal: AbortSignal,
): Promise<{ response: AmazonPageResponse; usedProxy: boolean }> {
  const headers = buildAmazonHeaders(url, locale, currency);
  const proxy = resolveProxyAgent(url);

  if (proxy) {
    const requestInit: NodeFetchRequestInit = {
      headers,
      redirect: "follow",
      signal: signal as NodeFetchRequestInit["signal"],
      agent: proxy.agent,
    };
    const response = await nodeFetch(url.toString(), requestInit);
    return { response, usedProxy: true };
  }

  const response = await fetch(url, {
    headers,
    redirect: "follow",
    signal,
  });
  return { response, usedProxy: false };
}

function formatNetworkFailure(error: unknown, usedProxy: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && "cause" in error
      ? (error.cause as { code?: unknown; message?: unknown } | undefined)
      : undefined;
  const causeCode = typeof cause?.code === "string" ? cause.code : undefined;
  const causeMessage =
    typeof cause?.message === "string" ? cause.message : undefined;
  const networkDetail = [causeCode, causeMessage, message]
    .filter(Boolean)
    .join(" / ");

  return `Amazon 页面网络请求失败${usedProxy ? "（已使用代理）" : "（直连）"}：${networkDetail}`;
}

async function fetchHtml(
  url: URL,
  locale: string,
  currency: string,
  signal?: AbortSignal,
): Promise<AmazonPagePayload> {
  const cacheKey = url.toString();
  const cached = readCachedHtml(cacheKey);
  if (cached) {
    return {
      html: cached,
      finalUrl: cacheKey,
      status: 200,
      usedProxy: Boolean(resolveProxyAgent(url)),
    };
  }

  const timeoutMs = readBoundedInteger(
    "AMAZON_CRAWLER_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
    3_000,
    60_000,
  );

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt += 1) {
    await waitForRequestSlot(signal);
    const requestSignal = createRequestSignal(signal, timeoutMs);
    let usedProxy = false;

    try {
      const requestResult = await requestAmazonPage(
        url,
        locale,
        currency,
        requestSignal.signal,
      );
      const { response } = requestResult;
      usedProxy = requestResult.usedProxy;

      if (
        (response.status === 429 || response.status === 503) &&
        attempt < MAX_HTTP_RETRIES
      ) {
        lastError = new Error(`Amazon 暂时限流（HTTP ${response.status}）`);
        await sleep(2_000, signal);
        continue;
      }
      if (!response.ok) {
        throw new Error(
          `Amazon 公开页面请求失败（HTTP ${response.status} ${response.statusText}）`,
        );
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType && !/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
        throw new Error(`Amazon 返回了非 HTML 内容（${contentType}）`);
      }

      const html = await response.text();
      assertUsableHtml(html, response.url || url.toString());
      writeCachedHtml(cacheKey, html);
      console.info(
        `[Commerce/AmazonCrawler] 页面获取成功：${url.hostname}${url.pathname}，HTTP ${response.status}，${usedProxy ? "代理" : "直连"}，${html.length} bytes。`,
      );
      return {
        html,
        finalUrl: response.url || url.toString(),
        status: response.status,
        usedProxy,
      };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_HTTP_RETRIES) {
        await sleep(1_500, signal);
        continue;
      }
      throw new Error(formatNetworkFailure(error, usedProxy), {
        cause: error,
      });
    } finally {
      requestSignal.cleanup();
    }
  }

  throw new Error(
    `Amazon 公开页面请求失败，重试后仍未取得页面内容：${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function enrichProductDetails(
  products: CommerceProductSignal[],
  marketplaceDomain: string,
  locale: string,
  currency: string,
  signal?: AbortSignal,
): Promise<CommerceProductSignal[]> {
  const maxDetailEnrichment = readBoundedInteger(
    "AMAZON_CRAWLER_MAX_DETAIL_PRODUCTS",
    DEFAULT_MAX_DETAIL_ENRICHMENT,
    0,
    20,
  );
  const targets = products.slice(0, maxDetailEnrichment);
  const enriched = new Map(products.map((product) => [product.asin, product]));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const currentIndex = cursor;
      cursor += 1;
      const product = targets[currentIndex];
      if (!product) continue;

      try {
        const url = new URL(`https://${marketplaceDomain}/dp/${product.asin}`);
        const { html } = await fetchHtml(url, locale, currency, signal);
        const detail = parseProductDetail(html);
        enriched.set(product.asin, {
          ...product,
          ...Object.fromEntries(
            Object.entries(detail).filter(([, value]) => value !== undefined),
          ),
        });
      } catch (error) {
        // 单个详情页被限流或结构变化时保留搜索页样本，避免一个 ASIN 影响整轮研究。
        console.warn(
          `[Commerce/AmazonCrawler] 商品详情补充失败（${product.asin}）：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const detailConcurrency = readBoundedInteger(
    "AMAZON_CRAWLER_DETAIL_CONCURRENCY",
    DEFAULT_DETAIL_CONCURRENCY,
    1,
    4,
  );
  await Promise.all(
    Array.from(
      { length: Math.min(detailConcurrency, targets.length) },
      () => worker(),
    ),
  );

  return products.map((product) => enriched.get(product.asin) || product);
}

/**
 * 无 Amazon API Key 时使用的公开页面爬虫 Provider。
 *
 * 数据来自 Amazon 对普通访客公开的搜索结果和少量商品详情页。实现包含：
 * - API 缺失或失败后的自动接管；
 * - HTTP_PROXY / HTTPS_PROXY 显式代理支持；
 * - 固定限速、请求超时、有限重试和短时缓存；
 * - 搜索卡片属性顺序无关解析；
 * - 单商品详情失败隔离。
 *
 * 不使用代理池、账号 Cookie、验证码识别或其他绕过机制。公开页面结构和访问策略可能变化，
 * 因此它是“无 API 时的真实数据降级链路”，不是带 SLA 的官方数据服务。
 */
export class AmazonPublicPageProvider implements CommerceDataProvider {
  readonly kind = "amazon-public-page" as const;

  isConfigured(): boolean {
    // 默认开启；只有部署方明确设置为 false 时才禁用无 API 爬虫链路。
    return process.env.AMAZON_PUBLIC_RESEARCH_ENABLED?.trim() !== "false";
  }

  async searchProducts(
    input: CommerceProviderSearchInput,
  ): Promise<CommerceProviderSearchResult> {
    const marketplace = getCommerceMarketplace(input.marketplace);
    const maxSearchKeywords = readBoundedInteger(
      "AMAZON_CRAWLER_MAX_KEYWORDS",
      DEFAULT_MAX_SEARCH_KEYWORDS,
      1,
      6,
    );
    const maxSearchPages = readBoundedInteger(
      "AMAZON_CRAWLER_MAX_PAGES_PER_KEYWORD",
      DEFAULT_MAX_SEARCH_PAGES_PER_KEYWORD,
      1,
      5,
    );

    // 优先使用英文规范类目名，避免中文会话下 LLM 返回中文关键词后直接搜索美国站。
    const keywords = Array.from(
      new Set(
        [input.category.categoryNameEn, ...input.category.keywords]
          .map((keyword) => keyword.trim())
          .filter(Boolean),
      ),
    ).slice(0, maxSearchKeywords);
    const productMap = new Map<string, CommerceProductSignal>();
    const warnings: string[] = [];
    const attempts: string[] = [];

    for (const keyword of keywords) {
      for (
        let page = 1;
        page <= maxSearchPages && productMap.size < input.sampleSize;
        page += 1
      ) {
        const url = new URL(`https://${marketplace.domain}/s`);
        url.searchParams.set("k", keyword);
        url.searchParams.set("ref", "nb_sb_noss");
        if (page > 1) url.searchParams.set("page", String(page));

        try {
          const payload = await fetchHtml(
            url,
            marketplace.locale,
            marketplace.currency,
            input.signal,
          );
          const blocks = extractSearchResultBlocks(payload.html);
          attempts.push(
            `${keyword} 第 ${page} 页：HTTP ${payload.status}，${payload.usedProxy ? "代理" : "直连"}，识别 ${blocks.length} 个商品卡片`,
          );

          if (!blocks.length) {
            warnings.push(
              `${keyword} 第 ${page} 页已成功返回 HTML，但未识别到商品卡片；可能是页面结构变化、地区跳转或该关键词无结果。`,
            );
            break;
          }

          const products = blocks
            .map(({ asin, html: block }) =>
              parseSearchResultBlock(
                asin,
                block,
                marketplace.domain,
                marketplace.currency,
              ),
            )
            .filter((item): item is CommerceProductSignal => Boolean(item));

          for (const product of products) {
            if (!productMap.has(product.asin)) {
              productMap.set(product.asin, product);
            }
            if (productMap.size >= input.sampleSize) break;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          attempts.push(`${keyword} 第 ${page} 页失败：${message}`);
          warnings.push(`${keyword} 第 ${page} 页采集失败：${message}`);
          break;
        }
      }
      if (productMap.size >= input.sampleSize) break;
    }

    const baseProducts = Array.from(productMap.values()).slice(
      0,
      input.sampleSize,
    );
    if (!baseProducts.length) {
      throw new Error(
        [
          "Amazon 公开页面爬虫已执行，但没有得到可用商品样本。",
          attempts.length ? `请求诊断：${attempts.join("；")}` : "没有产生页面请求记录。",
          "请检查当前机器是否能访问目标 Amazon 站点；如使用公司代理，请确认 HTTP_PROXY/HTTPS_PROXY 可用。",
        ].join(" "),
      );
    }

    const products = await enrichProductDetails(
      baseProducts,
      marketplace.domain,
      marketplace.locale,
      marketplace.currency,
      input.signal,
    );

    return {
      provider: this.kind,
      sourceId: "amazon",
      products,
      coverage: [
        "商品",
        "价格",
        "评分",
        "评论",
        "公开购买提示",
        "品牌",
        "部分卖点",
        "部分 Sales Rank",
      ],
      warnings: [
        ...warnings,
        `Amazon 爬虫请求完成：${attempts.join("；")}`,
        "本轮无需 Amazon API Key；数据来自公开搜索页与公开商品详情页。",
        "爬虫采用固定限速、超时和短时缓存，并支持 HTTP_PROXY/HTTPS_PROXY；不会绕过验证码、登录或平台访问限制。",
        "公开页面字段可能不完整；购买提示和 Sales Rank 只能作为市场信号，不能等同于官方真实销量。",
      ],
    };
  }
}

/**
 * 仅供本地回归脚本验证页面结构解析，不参与生产请求。
 * 通过导出纯函数，可以在不访问 Amazon 的情况下测试爬虫字段是否仍能正常归一化。
 */
export const amazonCrawlerParserTestUtils = {
  extractSearchResultBlocks,
  parseProductDetail,
  parseSearchResultBlock,
  readHtmlAttribute,
};
