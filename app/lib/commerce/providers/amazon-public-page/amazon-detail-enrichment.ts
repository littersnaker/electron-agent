/**
 * 模块职责：商品详情并发补全。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import type { CommerceProductSignal } from "../../types";
import { DEFAULT_DETAIL_CONCURRENCY, DEFAULT_MAX_DETAIL_ENRICHMENT, parseProductDetail, readBoundedInteger } from "./amazon-page-parser";
import { fetchHtml } from "./amazon-network-client";
export async function enrichProductDetails(
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
