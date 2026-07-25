import {
  chromium,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type Page,
  type Response,
} from "playwright-core";
import { getCommerceMarketplace } from "../marketplaces";
import type {
  CommerceDataProviderKind,
  CommerceProductSignal,
} from "../types";
import {
  assertPlatformPageUsable,
  buildPlatformSearchUrl,
  mergePlatformProducts,
  parsePlatformJsonPayload,
  parsePlatformPage,
  PLATFORM_CRAWLER_DEFINITIONS,
  resolvePlatformBrowserSearchTemplates,
  resolvePlatformCrawlerKeywords,
  resolvePlatformCrawlerProxyUrl,
  resolvePlatformCrawlerUserAgent,
  type PlatformCrawlerDefinition,
} from "./platform-public-page";
import type { PlatformConfig } from "./platform-serp";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "./types";

interface BrowserPageResult {
  products: CommerceProductSignal[];
  warning: string;
}

interface BrowserLaunchResult {
  browser: Browser;
  method: string;
}

interface PlaywrightProxySettings {
  server: string;
  username?: string;
  password?: string;
}

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_TIME_MS = 2_500;
const DEFAULT_SCROLL_STEPS = 3;
const DEFAULT_MAX_JSON_RESPONSES = 100;
const DEFAULT_MAX_JSON_BYTES = 5 * 1024 * 1024;
const DEFAULT_BROWSER_CONCURRENCY = 1;

/**
 * Playwright 浏览器任务信号量。
 *
 * Commerce Orchestrator 会并行执行 TikTok Shop、Temu 和 1688。如果不限制浏览器并发，
 * 开发机或 Electron 进程可能会同时启动多个 Chromium，造成内存瞬时升高和页面互相抢占网络。
 */
class BrowserSemaphore {
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];

  async acquire(maximum: number): Promise<() => void> {
    if (this.activeCount >= maximum) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.activeCount += 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.waiters.shift()?.();
    };
  }
}

const browserSemaphore = new BrowserSemaphore();

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

function readBoolean(environmentName: string, fallback: boolean): boolean {
  const raw = process.env[environmentName]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["false", "0", "off", "no"].includes(raw)) return false;
  if (["true", "1", "on", "yes"].includes(raw)) return true;
  return fallback;
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim().slice(0, 700);
}

function safeProxyLabel(proxyUrl: string | undefined): string {
  if (!proxyUrl) return "直连";
  try {
    const parsed = new URL(proxyUrl);
    return `代理 ${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "代理（地址格式无效）";
  }
}

function parsePlaywrightProxy(
  proxyUrl: string | undefined,
): PlaywrightProxySettings | undefined {
  if (!proxyUrl) return undefined;
  const parsed = new URL(proxyUrl);
  if (!["http:", "https:", "socks5:"].includes(parsed.protocol)) {
    throw new Error("Playwright 代理仅支持 http、https 或 socks5 协议。");
  }

  return {
    server: `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  };
}

function parseJsonSafely(value: string): unknown | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;

  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    // 部分接口返回 JSONP 或在 JSON 前后附加安全前缀。这里只截取首尾明确的对象/数组，
    // 不执行任何返回脚本，避免把网络响应变成任意代码执行入口。
    const objectStart = normalized.indexOf("{");
    const arrayStart = normalized.indexOf("[");
    const start =
      objectStart < 0
        ? arrayStart
        : arrayStart < 0
          ? objectStart
          : Math.min(objectStart, arrayStart);
    const end = Math.max(
      normalized.lastIndexOf("}"),
      normalized.lastIndexOf("]"),
    );
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(normalized.slice(start, end + 1)) as unknown;
    } catch {
      return undefined;
    }
  }
}

function isInterestingJsonResponse(response: Response): boolean {
  const resourceType = response.request().resourceType();
  if (resourceType !== "xhr" && resourceType !== "fetch") return false;
  if (!response.ok()) return false;

  const headers = response.headers();
  const contentType = headers["content-type"] || "";
  if (/json|javascript/iu.test(contentType)) return true;
  return /(?:api|search|goods|product|offer|item|recommend)/iu.test(
    response.url(),
  );
}

async function collectProductsFromResponse(
  response: Response,
  definition: PlatformCrawlerDefinition,
  currency: string,
  maximumBytes: number,
): Promise<CommerceProductSignal[]> {
  const headers = response.headers();
  const length = Number(headers["content-length"] || Number.NaN);
  if (Number.isFinite(length) && length > maximumBytes) return [];

  const body = await response.text();
  if (body.length > maximumBytes) return [];
  const payload = parseJsonSafely(body);
  if (payload === undefined) return [];

  return parsePlatformJsonPayload(
    payload,
    definition,
    new URL(response.url()),
    currency,
  );
}

async function scrollForLazyContent(page: Page, steps: number): Promise<void> {
  for (let index = 0; index < steps; index += 1) {
    await page.evaluate(() => {
      const target = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      );
      window.scrollTo({ top: target, behavior: "auto" });
    });
    await page.waitForTimeout(650);
  }
}

function launchAttempts(
  baseOptions: LaunchOptions,
): Array<{ label: string; options: LaunchOptions }> {
  const attempts: Array<{ label: string; options: LaunchOptions }> = [];
  const executablePath = process.env.COMMERCE_BROWSER_EXECUTABLE_PATH?.trim();
  const configuredChannel = process.env.COMMERCE_BROWSER_CHANNEL?.trim();

  if (executablePath) {
    attempts.push({
      label: `指定浏览器 ${executablePath}`,
      options: { ...baseOptions, executablePath },
    });
  }
  if (configuredChannel) {
    attempts.push({
      label: `浏览器通道 ${configuredChannel}`,
      options: { ...baseOptions, channel: configuredChannel },
    });
  }

  // 优先使用 Playwright 自带 Chromium；未安装浏览器二进制时再尝试常见系统浏览器。
  attempts.push({ label: "Playwright Chromium", options: baseOptions });
  for (const channel of ["chrome", "msedge"] as const) {
    if (channel === configuredChannel) continue;
    attempts.push({
      label: `系统 ${channel}`,
      options: { ...baseOptions, channel },
    });
  }

  return attempts;
}

async function launchBrowser(
  proxy: PlaywrightProxySettings | undefined,
): Promise<BrowserLaunchResult> {
  const headless = readBoolean("COMMERCE_BROWSER_HEADLESS", true);
  const launchTimeout = readBoundedInteger(
    "COMMERCE_BROWSER_LAUNCH_TIMEOUT_MS",
    30_000,
    5_000,
    120_000,
  );
  const baseOptions: LaunchOptions = {
    headless,
    proxy,
    timeout: launchTimeout,
    args: ["--disable-dev-shm-usage"],
  };
  const failures: string[] = [];

  for (const attempt of launchAttempts(baseOptions)) {
    try {
      const browser = await chromium.launch(attempt.options);
      return { browser, method: attempt.label };
    } catch (error) {
      failures.push(`${attempt.label}：${compactError(error)}`);
    }
  }

  throw new Error(
    `无法启动 Playwright 浏览器。请执行“pnpm crawler:install-browser”，或设置 COMMERCE_BROWSER_EXECUTABLE_PATH / COMMERCE_BROWSER_CHANNEL。诊断：${failures.join("；")}`,
  );
}

async function createBrowserContext(
  browser: Browser,
  definition: PlatformCrawlerDefinition,
  locale: string,
): Promise<BrowserContext> {
  const normalizedLocale = locale.replace("_", "-");
  return browser.newContext({
    locale: normalizedLocale,
    userAgent: resolvePlatformCrawlerUserAgent(definition),
    viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders: {
      "Accept-Language": `${normalizedLocale},en;q=0.8,zh-CN;q=0.6`,
    },
    javaScriptEnabled: true,
  });
}

async function crawlBrowserPage(
  context: BrowserContext,
  searchUrl: URL,
  definition: PlatformCrawlerDefinition,
  currency: string,
  signal?: AbortSignal,
): Promise<BrowserPageResult> {
  if (signal?.aborted) throw new Error("浏览器爬虫请求已取消。");

  const page = await context.newPage();
  const navigationTimeout = readBoundedInteger(
    "COMMERCE_BROWSER_NAVIGATION_TIMEOUT_MS",
    DEFAULT_NAVIGATION_TIMEOUT_MS,
    5_000,
    120_000,
  );
  const settleTime = readBoundedInteger(
    "COMMERCE_BROWSER_SETTLE_MS",
    DEFAULT_SETTLE_TIME_MS,
    500,
    15_000,
  );
  const scrollSteps = readBoundedInteger(
    "COMMERCE_BROWSER_SCROLL_STEPS",
    DEFAULT_SCROLL_STEPS,
    0,
    8,
  );
  const maximumJsonResponses = readBoundedInteger(
    "COMMERCE_BROWSER_MAX_JSON_RESPONSES",
    DEFAULT_MAX_JSON_RESPONSES,
    10,
    500,
  );
  const maximumJsonBytes = readBoundedInteger(
    "COMMERCE_BROWSER_MAX_JSON_BYTES",
    DEFAULT_MAX_JSON_BYTES,
    256 * 1024,
    20 * 1024 * 1024,
  );
  const responseProducts: CommerceProductSignal[] = [];
  const responseTasks = new Set<Promise<void>>();
  let observedJsonResponses = 0;

  const abortHandler = (): void => {
    void page.close().catch(() => undefined);
  };
  signal?.addEventListener("abort", abortHandler, { once: true });

  // 字体和媒体不会影响商品 DOM/JSON，阻断它们可显著降低浏览器爬虫流量；图片请求保留，
  // 因为部分站点只有在图片进入视口后才会补充完整商品卡片属性。
  await page.route("**/*", async (route) => {
    const resourceType = route.request().resourceType();
    if (resourceType === "font" || resourceType === "media") {
      await route.abort();
      return;
    }
    await route.continue();
  });

  page.on("response", (response) => {
    if (
      observedJsonResponses >= maximumJsonResponses ||
      !isInterestingJsonResponse(response)
    ) {
      return;
    }
    observedJsonResponses += 1;
    const task = collectProductsFromResponse(
      response,
      definition,
      currency,
      maximumJsonBytes,
    )
      .then((products) => {
        responseProducts.push(...products);
      })
      .catch(() => undefined)
      .finally(() => responseTasks.delete(task));
    responseTasks.add(task);
  });

  try {
    page.setDefaultNavigationTimeout(navigationTimeout);
    page.setDefaultTimeout(navigationTimeout);
    const navigationResponse = await page.goto(searchUrl.toString(), {
      waitUntil: "domcontentloaded",
      timeout: navigationTimeout,
    });
    if (navigationResponse && !navigationResponse.ok()) {
      throw new Error(
        `${definition.label} 浏览器页面返回 HTTP ${navigationResponse.status()}。`,
      );
    }

    await page
      .waitForLoadState("networkidle", { timeout: Math.min(10_000, navigationTimeout) })
      .catch(() => undefined);
    await page.waitForTimeout(settleTime);
    await scrollForLazyContent(page, scrollSteps);
    await page.waitForTimeout(Math.min(settleTime, 2_000));
    await Promise.allSettled(Array.from(responseTasks));

    const finalUrl = page.url();
    const html = await page.content();
    assertPlatformPageUsable(html, finalUrl, definition);
    const domProducts = parsePlatformPage(
      html,
      definition,
      new URL(finalUrl),
      currency,
    );
    const products = mergePlatformProducts(
      [...responseProducts, ...domProducts],
      Number.MAX_SAFE_INTEGER,
    );

    return {
      products,
      warning: `${definition.label} 浏览器页 ${new URL(finalUrl).hostname}：XHR/Fetch 监听 ${observedJsonResponses} 个候选响应，响应 JSON 解析 ${responseProducts.length} 条，渲染后 DOM 解析 ${domProducts.length} 条。`,
    };
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    await page.close().catch(() => undefined);
  }
}

/**
 * TikTok Shop、Temu、1688 的 Playwright 浏览器爬虫。
 *
 * 它只访问无需登录即可打开的公开页面，并读取页面渲染后的 DOM、内嵌 JSON 和公开
 * XHR/Fetch 响应。不会注入账号 Cookie、不会绕过验证码、不会伪造浏览器指纹。
 */
export class PlatformBrowserPageProvider implements CommerceDataProvider {
  readonly kind: CommerceDataProviderKind;
  private readonly definition: PlatformCrawlerDefinition;

  constructor(config: PlatformConfig) {
    this.definition = PLATFORM_CRAWLER_DEFINITIONS[config.sourceId];
    this.kind = this.definition.providerKind;
  }

  isConfigured(): boolean {
    const platformEnabled = readBoolean(
      this.definition.enabledEnvironmentName,
      true,
    );
    return (
      platformEnabled &&
      readBoolean("COMMERCE_BROWSER_CRAWLER_ENABLED", true)
    );
  }

  async searchProducts(
    input: CommerceProviderSearchInput,
  ): Promise<CommerceProviderSearchResult> {
    const market = getCommerceMarketplace(input.marketplace);
    const currency = this.definition.defaultCurrency || market.currency;
    const keywords = resolvePlatformCrawlerKeywords(input, this.definition);
    const templates = resolvePlatformBrowserSearchTemplates(this.definition);
    const maxPages = readBoundedInteger(
      "COMMERCE_BROWSER_MAX_PAGES_PER_KEYWORD",
      2,
      1,
      5,
    );
    const concurrency = readBoundedInteger(
      "COMMERCE_BROWSER_CONCURRENCY",
      DEFAULT_BROWSER_CONCURRENCY,
      1,
      3,
    );
    const release = await browserSemaphore.acquire(concurrency);
    const products: CommerceProductSignal[] = [];
    const warnings: string[] = [];
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;

    try {
      const firstTemplate = templates[0] || this.definition.defaultSearchUrlTemplate;
      const firstUrl = buildPlatformSearchUrl(
        this.definition,
        keywords[0] || input.category.categoryNameEn,
        1,
        firstTemplate,
      );
      const proxyUrl = resolvePlatformCrawlerProxyUrl(
        firstUrl,
        this.definition,
      );
      const proxy = parsePlaywrightProxy(proxyUrl);
      const launched = await launchBrowser(proxy);
      browser = launched.browser;
      context = await createBrowserContext(
        browser,
        this.definition,
        market.locale,
      );
      warnings.push(
        `${this.definition.label} 浏览器爬虫已启动：${launched.method}，${safeProxyLabel(proxyUrl)}。`,
      );

      for (const keyword of keywords) {
        for (let page = 1; page <= maxPages; page += 1) {
          if (
            mergePlatformProducts(products, input.sampleSize).length >=
            input.sampleSize
          ) {
            break;
          }

          for (const template of templates) {
            const searchUrl = buildPlatformSearchUrl(
              this.definition,
              keyword,
              page,
              template,
            );
            try {
              console.info(
                `[Commerce/${this.definition.label}BrowserCrawler] 浏览器抓取“${keyword}”第 ${page} 页：${searchUrl.hostname}${searchUrl.pathname}`,
              );
              const result = await crawlBrowserPage(
                context,
                searchUrl,
                this.definition,
                currency,
                input.signal,
              );
              products.push(...result.products);
              warnings.push(result.warning);
              if (result.products.length > 0) break;
            } catch (error) {
              warnings.push(
                `${this.definition.label} 浏览器页“${keyword}”第 ${page} 页（${searchUrl.hostname}）：${compactError(error)}`,
              );
            }
          }
        }
      }

      const unique = mergePlatformProducts(products, input.sampleSize);
      if (!unique.length) {
        throw new Error(
          `${this.definition.label} Playwright 浏览器爬虫已运行，但没有解析出商品样本。可能原因包括地区不可用、登录重定向、验证码、接口加密、页面结构变化或当前出口网络无法访问。诊断：${warnings.join("；")}`,
        );
      }

      return {
        provider: this.definition.providerKind,
        sourceId: this.definition.sourceId,
        crawlerEngine: "browser",
        products: unique,
        coverage: [
          "浏览器渲染后的公开商品标题",
          "商品链接与图片",
          "公开 XHR/Fetch JSON",
          "可解析价格",
          "可解析评分/评论/销量文案",
        ],
        warnings: [
          `${this.definition.label} 当前通过 Playwright 读取无需登录即可查看的公开页面；数据只代表采集时可见信息，不代表平台完整销量、GMV 或市场份额。`,
          ...warnings,
        ],
      };
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      release();
    }
  }
}
