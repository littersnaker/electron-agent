/**
 * 模块职责：亚马逊公开页面数据源及测试工具。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { getCommerceMarketplace } from "../../marketplaces";
import type { CommerceProductSignal } from "../../types";
import type { CommerceDataProvider, CommerceProviderSearchInput, CommerceProviderSearchResult } from "../types";
import { DEFAULT_MAX_SEARCH_KEYWORDS, DEFAULT_MAX_SEARCH_PAGES_PER_KEYWORD, extractSearchResultBlocks, parseProductDetail, parseSearchResultBlock, readBoundedInteger, readHtmlAttribute } from "./amazon-page-parser";
import { fetchHtml } from "./amazon-network-client";
import { enrichProductDetails } from "./amazon-detail-enrichment";
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
