import { getCommerceMarketplace } from "../marketplaces";
import type { CommerceProductSignal } from "../types";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "./types";

const MAX_SEARCH_KEYWORDS = 3;
const MAX_SEARCH_PAGES_PER_KEYWORD = 2;
const MAX_DETAIL_ENRICHMENT = 10;
const DETAIL_CONCURRENCY = 3;

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&nbsp;/gu, " ")
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
  const multiplier = match[2]?.toLowerCase() === "m"
    ? 1_000_000
    : match[2]?.toLowerCase() === "k"
      ? 1_000
      : 1;
  return Math.round(number * multiplier);
}

function parseRecentPurchaseSignal(html: string): {
  lowerBound?: number;
  label?: string;
} {
  const label = readFirstMatch(
    html,
    /([0-9]+(?:[.,][0-9]+)?\s*[KkMm]?\+?\s+bought in past month)/iu,
  );
  if (!label) return {};

  const amount = /^([0-9]+(?:[.,][0-9]+)?\s*[KkMm]?\+?)/iu.exec(label)?.[1];
  return {
    lowerBound: readCompactNumber(amount?.replace(/\s+/gu, "")),
    label,
  };
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
      /<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/iu,
    ) ||
    readFirstMatch(
      html,
      /class="[^"]*a-size-(?:medium|base-plus)[^"]*"[^>]*>([\s\S]*?)<\//iu,
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
  const price = readNumber(
    whole ? `${whole}.${fraction || "00"}` : undefined,
  );
  const rating = readNumber(
    readFirstMatch(
      html,
      /(?:aria-label|title)="([0-9.,]+)\s*(?:out of 5 stars|von 5 Sternen|sur 5 étoiles|su 5 stelle|de 5 estrellas|5つ星のうち)/iu,
    ),
  );
  const reviewCount = readNumber(
    readFirstMatch(
      html,
      /class="[^"]*s-underline-text[^"]*"[^>]*>([0-9.,]+)<\/span>/iu,
    ),
  );
  const imageUrl = /<img[^>]+src="([^"]+)"/iu.exec(html)?.[1];
  const purchaseSignal = parseRecentPurchaseSignal(html);

  return {
    asin,
    title,
    price,
    currency: price !== undefined ? currency : undefined,
    rating,
    reviewCount,
    imageUrl,
    recentPurchaseLowerBound: purchaseSignal.lowerBound,
    recentPurchaseLabel: purchaseSignal.label,
    productUrl: `https://${marketplaceDomain}/dp/${asin}`,
    source: "amazon-public-page",
  };
}

function extractSearchResultBlocks(html: string): Array<{
  asin: string;
  html: string;
}> {
  const marker = /<div[^>]+data-component-type="s-search-result"[^>]+data-asin="([A-Z0-9]{10})"[^>]*>/giu;
  const matches = Array.from(html.matchAll(marker));

  return matches.map((match, index) => {
    const start = match.index || 0;
    const end = matches[index + 1]?.index || html.length;
    return { asin: match[1], html: html.slice(start, end) };
  });
}

function assertNotRobotPage(html: string): void {
  if (/robot check|enter the characters you see below|captcha/iu.test(html)) {
    throw new Error(
      "Amazon 返回了机器人校验页。公开研究模块不会绕过验证码，请稍后重试或配置第三方市场数据源。",
    );
  }
}

function parseProductDetail(
  html: string,
): Partial<CommerceProductSignal> {
  const rankMatch = /Best Sellers Rank[\s\S]{0,900}?#([0-9,]+)\s+in\s+([^<(]{2,120})/iu.exec(
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
      />\s*Brand\s*<[^>]*>[\s\S]{0,180}?<[^>]*>([\s\S]*?)<\//iu,
    );
  const purchaseSignal = parseRecentPurchaseSignal(html);

  return {
    brand,
    salesRank,
    salesRankCategory,
    recentPurchaseLowerBound: purchaseSignal.lowerBound,
    recentPurchaseLabel: purchaseSignal.label,
  };
}

async function fetchHtml(url: URL, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.8",
      // 明确标识应用，不包含代理池、浏览器指纹伪装或验证码绕过。
      "User-Agent":
        process.env.AMAZON_PUBLIC_RESEARCH_USER_AGENT?.trim() ||
        "AgentWorkspace-CommerceResearch/2.0",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Amazon 公开页面请求失败（HTTP ${response.status}）`);
  }

  const html = await response.text();
  assertNotRobotPage(html);
  return html;
}

async function enrichProductDetails(
  products: CommerceProductSignal[],
  marketplaceDomain: string,
  signal?: AbortSignal,
): Promise<CommerceProductSignal[]> {
  const targets = products.slice(0, MAX_DETAIL_ENRICHMENT);
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
        const html = await fetchHtml(url, signal);
        const detail = parseProductDetail(html);
        enriched.set(product.asin, {
          ...product,
          ...Object.fromEntries(
            Object.entries(detail).filter(([, value]) => value !== undefined),
          ),
        });
      } catch {
        // 单个详情页被限流时保留搜索页样本；不能因为一个 ASIN 失败丢掉整轮研究。
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DETAIL_CONCURRENCY, targets.length) }, () =>
      worker(),
    ),
  );

  return products.map((product) => enriched.get(product.asin) || product);
}

/**
 * 无 Seller Central 账号也可使用的公开市场研究 Provider。
 *
 * 数据来自 Amazon 对普通访客公开的搜索结果与少量商品详情页，不依赖 SP-API、
 * Seller 授权或店铺 Refresh Token。模块不会绕过验证码或反爬限制；Amazon 拒绝
 * 自动访问时会明确报错，因此它适合作为“无需店铺的基础研究”，而不是稳定 SLA 数据源。
 */
export class AmazonPublicPageProvider implements CommerceDataProvider {
  readonly kind = "amazon-public-page" as const;

  isConfigured(): boolean {
    // 默认开启，只有显式设为 false 才关闭，确保没有 Amazon 店铺时也能直接研究。
    return process.env.AMAZON_PUBLIC_RESEARCH_ENABLED?.trim() !== "false";
  }

  async searchProducts(
    input: CommerceProviderSearchInput,
  ): Promise<CommerceProviderSearchResult> {
    const marketplace = getCommerceMarketplace(input.marketplace);
    const keywords = Array.from(
      new Set(
        [
          ...input.category.keywords,
          input.category.categoryNameEn,
        ]
          .map((keyword) => keyword.trim())
          .filter(Boolean),
      ),
    ).slice(0, MAX_SEARCH_KEYWORDS);
    const productMap = new Map<string, CommerceProductSignal>();
    const warnings: string[] = [];

    for (const keyword of keywords) {
      for (
        let page = 1;
        page <= MAX_SEARCH_PAGES_PER_KEYWORD && productMap.size < input.sampleSize;
        page += 1
      ) {
        const url = new URL(`https://${marketplace.domain}/s`);
        url.searchParams.set("k", keyword);
        if (page > 1) url.searchParams.set("page", String(page));

        try {
          const html = await fetchHtml(url, input.signal);
          const products = extractSearchResultBlocks(html)
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
            if (!productMap.has(product.asin)) productMap.set(product.asin, product);
            if (productMap.size >= input.sampleSize) break;
          }
        } catch (error) {
          warnings.push(
            `${keyword} 第 ${page} 页采集失败：${error instanceof Error ? error.message : String(error)}`,
          );
          break;
        }
      }
      if (productMap.size >= input.sampleSize) break;
    }

    const baseProducts = Array.from(productMap.values()).slice(0, input.sampleSize);
    if (!baseProducts.length) {
      throw new Error(
        "Amazon 公开页面没有返回可用商品样本。可能遇到访问限制或页面结构变化，请稍后重试。",
      );
    }

    const products = await enrichProductDetails(
      baseProducts,
      marketplace.domain,
      input.signal,
    );

    return {
      provider: this.kind,
      products,
      warnings: [
        ...warnings,
        "本轮无需 Amazon 店铺或 Seller Central 授权；数据来自公开搜索页与公开商品详情页。",
        "公开页面结构与访问策略可能变化；模块不会绕过验证码、代理限制或机器人校验。",
        "销量字段为公开购买提示或 Sales Rank 的估算区间，不代表 Amazon 官方真实订单量。",
      ],
    };
  }
}
