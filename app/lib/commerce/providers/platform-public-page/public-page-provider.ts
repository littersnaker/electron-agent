/**
 * 模块职责：公开页面数据源实现与解析测试工具。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { getCommerceMarketplace } from "../../marketplaces";
import type { CommerceDataProviderKind, CommerceProductSignal } from "../../types";
import type { PlatformConfig } from "../platform-serp";
import type { CommerceDataProvider, CommerceProviderSearchInput, CommerceProviderSearchResult } from "../types";
import { DEFAULT_MAX_PAGES_PER_KEYWORD, PLATFORM_CRAWLER_DEFINITIONS, PlatformCrawlerDefinition, SupportedPlatformSource } from "./crawler-definitions";
import { isEnabled, readBoundedInteger } from "./product-parsers";
import { buildPlatformSearchUrl, parsePlatformPage, resolvePlatformCrawlerKeywords } from "./search-url-builder";
import { extractJsonScriptPayloads, extractProductsFromAnchors, extractProductsFromJson, mergePlatformProducts } from "./payload-extraction";
import { fetchPlatformPage } from "./network-client";
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
