import assert from "node:assert/strict";
import { calculateMarketMetrics, enrichProductsWithEstimates } from "../app/lib/commerce/analytics";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  PlatformAutoProvider,
  PlatformDataSourceError,
  type PlatformProviderCandidate,
} from "../app/lib/commerce/providers/platform-auto";
import {
  parsePlatformJsonPayload,
  PLATFORM_CRAWLER_DEFINITIONS,
  platformCrawlerParserTestUtils,
} from "../app/lib/commerce/providers/platform-public-page";
import {
  PLATFORM_SERP_CONFIGS,
  type PlatformConfig,
} from "../app/lib/commerce/providers/platform-serp";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "../app/lib/commerce/providers/types";
import type {
  CommerceDataProviderKind,
  CommerceProductSignal,
} from "../app/lib/commerce/types";

const input: CommerceProviderSearchInput = {
  marketplace: "US",
  category: {
    categoryName: "电脑支架",
    categoryNameEn: "Laptop Stand",
    keywords: ["laptop stand"],
    subcategories: [],
    analysisDimensions: ["价格", "评分", "评论", "跨平台差异"],
    researchGoal: "验证平台 API 优先、无 API 时爬虫接管的自动路由。",
  },
  sampleSize: 12,
};

class FakeProvider implements CommerceDataProvider {
  calls = 0;

  constructor(
    readonly kind: CommerceDataProviderKind,
    private readonly configured: boolean,
    private readonly handler: () => Promise<CommerceProviderSearchResult>,
  ) {}

  isConfigured(): boolean {
    return this.configured;
  }

  async searchProducts(): Promise<CommerceProviderSearchResult> {
    this.calls += 1;
    return this.handler();
  }
}

function createProduct(
  config: PlatformConfig,
  source: CommerceDataProviderKind,
  suffix: string,
): CommerceProductSignal {
  return {
    asin: `${config.sourceId}-${suffix}`,
    platform: config.sourceId,
    title: `${config.label} test product`,
    price: config.sourceId === "1688" ? 23.8 : 19.99,
    currency: config.sourceId === "1688" ? "CNY" : "USD",
    source,
  };
}

function candidate(
  route: PlatformProviderCandidate["route"],
  label: string,
  provider: CommerceDataProvider,
): PlatformProviderCandidate {
  return { route, label, provider };
}

async function verifyRoutes(config: PlatformConfig): Promise<void> {
  const api = new FakeProvider(config.kind, true, async () => ({
    provider: config.kind,
    sourceId: config.sourceId,
    products: [createProduct(config, config.kind, "api")],
    warnings: [],
  }));
  const crawlerKind =
    config.sourceId === "tiktok-shop"
      ? "tiktok-shop-public-page"
      : config.sourceId === "temu"
        ? "temu-public-page"
        : "alibaba-1688-public-page";
  const crawler = new FakeProvider(crawlerKind, true, async () => ({
    provider: crawlerKind,
    sourceId: config.sourceId,
    products: [createProduct(config, crawlerKind, "crawler")],
    warnings: [],
  }));
  const apiFirst = new PlatformAutoProvider(config, undefined, {
    candidates: [
      candidate("api", `${config.label} API`, api),
      candidate("crawler", `${config.label} crawler`, crawler),
    ],
  });
  const apiResult = await apiFirst.searchProducts(input);
  assert.equal(apiResult.provider, config.kind);
  assert.equal(api.calls, 1);
  assert.equal(crawler.calls, 0, `${config.label} API 有数据时不应请求爬虫`);

  const disabledApi = new FakeProvider(config.kind, false, async () => ({
    provider: config.kind,
    products: [],
    warnings: [],
  }));
  const crawlerOnly = new FakeProvider(crawlerKind, true, async () => ({
    provider: crawlerKind,
    sourceId: config.sourceId,
    products: [createProduct(config, crawlerKind, "no-api")],
    warnings: [],
  }));
  const noApi = new PlatformAutoProvider(config, undefined, {
    candidates: [
      candidate("api", `${config.label} API`, disabledApi),
      candidate("crawler", `${config.label} crawler`, crawlerOnly),
    ],
  });
  const crawlerResult = await noApi.searchProducts(input);
  assert.equal(crawlerResult.provider, crawlerKind);
  assert.equal(disabledApi.calls, 0);
  assert.equal(crawlerOnly.calls, 1);
  assert.match(crawlerResult.warnings.join("\n"), /未检测到可用 API/u);

  const failedApi = new FakeProvider(config.kind, true, async () => {
    throw new Error(`${config.label} API timeout`);
  });
  const fallbackCrawler = new FakeProvider(crawlerKind, true, async () => ({
    provider: crawlerKind,
    sourceId: config.sourceId,
    products: [createProduct(config, crawlerKind, "fallback")],
    warnings: [],
  }));
  const fallback = new PlatformAutoProvider(config, undefined, {
    candidates: [
      candidate("api", `${config.label} API`, failedApi),
      candidate("crawler", `${config.label} crawler`, fallbackCrawler),
    ],
  });
  const fallbackResult = await fallback.searchProducts(input);
  assert.equal(fallbackResult.provider, crawlerKind);
  assert.equal(failedApi.calls, 1);
  assert.equal(fallbackCrawler.calls, 1);
  assert.match(fallbackResult.warnings.join("\n"), /API timeout/u);

  const failedCrawler = new FakeProvider(crawlerKind, true, async () => {
    throw new Error(`${config.label} crawler unavailable`);
  });
  const allFailed = new PlatformAutoProvider(config, undefined, {
    candidates: [
      candidate("api", `${config.label} API`, failedApi),
      candidate("crawler", `${config.label} crawler`, failedCrawler),
    ],
  });
  await assert.rejects(
    () => allFailed.searchProducts(input),
    (error: unknown) => {
      if (!(error instanceof PlatformDataSourceError)) return false;
      assert.deepEqual(error.attemptedRoutes, ["api", "crawler"]);
      assert.match(error.message, /crawler unavailable/u);
      return true;
    },
  );
}

async function verifyParsers(): Promise<void> {
  const fixtureRoot = path.join(process.cwd(), "scripts", "fixtures");
  const cases = [
    {
      sourceId: "tiktok-shop" as const,
      file: "tiktok-shop-search.html",
      url: "https://shop.tiktok.com/us/search?q=lamp",
      currency: "USD",
      expectedTitle: /Portable LED Desk Lamp/u,
      expectedPrice: 18.99,
      expectedSold: 1_200,
    },
    {
      sourceId: "temu" as const,
      file: "temu-search.html",
      url: "https://www.temu.com/search_result.html?search_key=laptop+stand",
      currency: "USD",
      expectedTitle: /Adjustable Laptop Stand/u,
      expectedPrice: 12.49,
      expectedSold: 8_600,
    },
    {
      sourceId: "1688" as const,
      file: "1688-search.html",
      url: "https://s.1688.com/selloffer/offer_search.htm?keywords=电脑支架",
      currency: "CNY",
      expectedTitle: /电脑支架/u,
      expectedPrice: 23.8,
      expectedSold: 5_600,
    },
  ];

  for (const item of cases) {
    const html = await readFile(path.join(fixtureRoot, item.file), "utf8");
    const products = platformCrawlerParserTestUtils.parsePage(
      item.sourceId,
      html,
      item.url,
      item.currency,
    );
    assert.equal(products.length, 1, `${item.sourceId} fixture 应解析一个商品`);
    assert.match(products[0].title, item.expectedTitle);
    assert.equal(products[0].price, item.expectedPrice);
    assert.equal(products[0].recentPurchaseLowerBound, item.expectedSold);
    assert.equal(products[0].platform, item.sourceId);
  }
}

function verifyBrowserJsonPayloads(): void {
  const cases = [
    {
      sourceId: "tiktok-shop" as const,
      baseUrl: "https://www.tiktok.com/shop/search?q=lamp",
      payload: {
        data: {
          products: [
            {
              product_id: "17293847561029384",
              product_name: "Portable LED Desk Lamp",
              sale_price: "18.99",
              sold_count: "1.2K",
            },
          ],
        },
      },
      expectedUrl: /shop\.tiktok\.com\/us\/view\/product\/17293847561029384/u,
    },
    {
      sourceId: "temu" as const,
      baseUrl: "https://www.temu.com/search_result.html?search_key=laptop+stand",
      payload: {
        result: {
          goods_list: [
            {
              goods_id: "601099659839035",
              goods_name: "Adjustable Laptop Stand",
              sale_price: "12.49",
              sales: "8.6K",
            },
          ],
        },
      },
      expectedUrl: /temu\.com\/goods\.html\?goods_id=601099659839035/u,
    },
    {
      sourceId: "1688" as const,
      baseUrl: "https://s.1688.com/selloffer/offer_search.htm?keywords=电脑支架",
      payload: {
        data: {
          offers: [
            {
              offerId: "735001122334",
              subject: "铝合金电脑支架",
              price: "23.80",
              soldCount: "5600",
            },
          ],
        },
      },
      expectedUrl: /detail\.1688\.com\/offer\/735001122334\.html/u,
    },
  ];

  for (const item of cases) {
    const products = parsePlatformJsonPayload(
      item.payload,
      PLATFORM_CRAWLER_DEFINITIONS[item.sourceId],
      new URL(item.baseUrl),
      item.sourceId === "1688" ? "CNY" : "USD",
    );
    assert.equal(products.length, 1, `${item.sourceId} XHR JSON 应解析一个商品`);
    assert.match(products[0].productUrl || "", item.expectedUrl);
  }
}


function verifyCrossPlatformMetrics(): void {
  const products: CommerceProductSignal[] = [
    { asin: "A1", platform: "amazon", title: "Amazon 1", price: 20, currency: "USD", source: "amazon-public-page" },
    { asin: "A2", platform: "amazon", title: "Amazon 2", price: 30, currency: "USD", source: "amazon-public-page" },
    { asin: "S1", platform: "1688", title: "1688 1", price: 100, currency: "CNY", recentPurchaseLowerBound: 5000, source: "alibaba-1688-public-page" },
    { asin: "S2", platform: "1688", title: "1688 2", price: 200, currency: "CNY", source: "alibaba-1688-public-page" },
  ];
  const metrics = calculateMarketMetrics(products);
  assert.equal(metrics.currency, "USD");
  assert.equal(metrics.medianPrice, 25, "总览价格不得把 CNY 与 USD 直接混算");
  const supplier = metrics.platformComparisons?.find((item) => item.platform === "1688");
  assert.equal(supplier?.currency, "CNY");
  assert.equal(supplier?.medianPrice, 150);
  const enriched = enrichProductsWithEstimates(products);
  assert.equal(
    enriched.find((item) => item.platform === "1688")?.estimatedMonthlyUnits,
    undefined,
    "1688 已售数量不能套用 Amazon 月销量模型",
  );
}

async function main(): Promise<void> {
  for (const config of PLATFORM_SERP_CONFIGS) {
    await verifyRoutes(config);
  }
  await verifyParsers();
  verifyBrowserJsonPayloads();
  verifyCrossPlatformMetrics();
  console.log("TikTok Shop / Temu / 1688 API-crawler routing tests passed.");
}

void main();
