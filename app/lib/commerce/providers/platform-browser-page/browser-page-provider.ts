/**
 * 模块职责：浏览器页面数据源实现。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { type Browser, type BrowserContext } from "playwright-core";
import { getCommerceMarketplace } from "../../marketplaces";
import type { CommerceDataProviderKind, CommerceProductSignal } from "../../types";
import { buildPlatformSearchUrl, mergePlatformProducts, PLATFORM_CRAWLER_DEFINITIONS, resolvePlatformBrowserSearchTemplates, resolvePlatformCrawlerKeywords, resolvePlatformCrawlerProxyUrl, type PlatformCrawlerDefinition } from "../platform-public-page";
import type { PlatformConfig } from "../platform-serp";
import type { CommerceDataProvider, CommerceProviderSearchInput, CommerceProviderSearchResult } from "../types";
import { DEFAULT_BROWSER_CONCURRENCY, browserSemaphore, compactError, createBrowserContext, launchBrowser, parsePlaywrightProxy, readBoolean, readBoundedInteger, safeProxyLabel } from "./browser-runtime";
import { crawlBrowserPage } from "./browser-crawler";
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
