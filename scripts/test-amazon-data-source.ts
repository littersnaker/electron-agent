import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AmazonAutoProvider,
  AmazonDataSourceError,
  type AmazonProviderCandidate,
} from "../app/lib/commerce/providers/amazon-auto";
import { amazonCrawlerParserTestUtils } from "../app/lib/commerce/providers/amazon-public-page";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "../app/lib/commerce/providers/types";
import type {
  CommerceCategoryResolution,
  CommerceDataProviderKind,
  CommerceProductSignal,
} from "../app/lib/commerce/types";

const category: CommerceCategoryResolution = {
  categoryName: "空气炸锅配件",
  categoryNameEn: "Air Fryer Accessories",
  keywords: ["air fryer accessories"],
  subcategories: [],
  analysisDimensions: ["价格", "评论"],
  researchGoal: "验证 Amazon API 与爬虫自动切换链路。",
};

const input: CommerceProviderSearchInput = {
  marketplace: "US",
  category,
  sampleSize: 12,
};

function product(
  source: CommerceDataProviderKind,
  asin: string,
): CommerceProductSignal {
  return {
    asin,
    platform: "amazon",
    title: `Test product ${asin}`,
    source,
  };
}

class FakeProvider implements CommerceDataProvider {
  public calls = 0;

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

function candidate(
  route: AmazonProviderCandidate["route"],
  label: string,
  provider: CommerceDataProvider,
): AmazonProviderCandidate {
  return { route, label, provider };
}

async function verifyApiFirstRoute(): Promise<void> {
  const api = new FakeProvider("amazon-sp-api", true, async () => ({
    provider: "amazon-sp-api",
    products: [product("amazon-sp-api", "B0API00001")],
    warnings: [],
  }));
  const crawler = new FakeProvider("amazon-public-page", true, async () => ({
    provider: "amazon-public-page",
    products: [product("amazon-public-page", "B0CRAWL001")],
    warnings: [],
  }));
  const provider = new AmazonAutoProvider(undefined, {
    candidates: [
      candidate("api", "Fake API", api),
      candidate("crawler", "Fake crawler", crawler),
    ],
  });

  const result = await provider.searchProducts(input);
  assert.equal(result.provider, "amazon-sp-api");
  assert.equal(api.calls, 1);
  assert.equal(crawler.calls, 0, "API 有数据时不应继续请求爬虫");
}

async function verifyCrawlerWithoutApiRoute(): Promise<void> {
  const api = new FakeProvider("amazon-sp-api", false, async () => ({
    provider: "amazon-sp-api",
    products: [],
    warnings: [],
  }));
  const crawler = new FakeProvider("amazon-public-page", true, async () => ({
    provider: "amazon-public-page",
    products: [product("amazon-public-page", "B0CRAWL002")],
    warnings: [],
  }));
  const provider = new AmazonAutoProvider(undefined, {
    candidates: [
      candidate("api", "Fake API", api),
      candidate("crawler", "Fake crawler", crawler),
    ],
  });

  const result = await provider.searchProducts(input);
  assert.equal(result.provider, "amazon-public-page");
  assert.equal(api.calls, 0, "未配置 API 时不应发起 API 请求");
  assert.equal(crawler.calls, 1);
  assert.match(result.warnings[0] || "", /未检测到可用 API/u);
}

async function verifyCrawlerAfterApiFailure(): Promise<void> {
  const api = new FakeProvider("talordata-amazon", true, async () => {
    throw new Error("API timeout");
  });
  const crawler = new FakeProvider("amazon-public-page", true, async () => ({
    provider: "amazon-public-page",
    products: [product("amazon-public-page", "B0CRAWL003")],
    warnings: [],
  }));
  const provider = new AmazonAutoProvider(undefined, {
    candidates: [
      candidate("api", "Fake API", api),
      candidate("crawler", "Fake crawler", crawler),
    ],
  });

  const result = await provider.searchProducts(input);
  assert.equal(result.provider, "amazon-public-page");
  assert.equal(api.calls, 1);
  assert.equal(crawler.calls, 1);
  assert.match(result.warnings.join("\n"), /API timeout/u);
}


async function verifyStructuredFailureDiagnostics(): Promise<void> {
  const api = new FakeProvider("amazon-sp-api", false, async () => ({
    provider: "amazon-sp-api",
    products: [],
    warnings: [],
  }));
  const crawler = new FakeProvider("amazon-public-page", true, async () => {
    throw new Error("crawler network unavailable");
  });
  const provider = new AmazonAutoProvider(undefined, {
    candidates: [
      candidate("api", "Fake API", api),
      candidate("crawler", "Fake crawler", crawler),
    ],
  });

  await assert.rejects(
    () => provider.searchProducts(input),
    (error: unknown) => {
      assert.ok(error instanceof AmazonDataSourceError);
      assert.deepEqual(error.attemptedRoutes, ["crawler"]);
      assert.match(error.message, /crawler network unavailable/u);
      return true;
    },
  );
}

async function verifyCrawlerParsers(): Promise<void> {
  const fixtureRoot = path.join(process.cwd(), "scripts", "fixtures");
  const searchHtml = await readFile(
    path.join(fixtureRoot, "amazon-search.html"),
    "utf8",
  );
  const detailHtml = await readFile(
    path.join(fixtureRoot, "amazon-detail.html"),
    "utf8",
  );

  const blocks = amazonCrawlerParserTestUtils.extractSearchResultBlocks(searchHtml);
  assert.equal(blocks.length, 2, "属性顺序和单双引号变化不应影响商品卡片识别");
  assert.equal(
    amazonCrawlerParserTestUtils.readHtmlAttribute(
      '<div data-asin="B0TEST0001" data-component-type="s-search-result">',
      "data-asin",
    ),
    "B0TEST0001",
  );
  const first = amazonCrawlerParserTestUtils.parseSearchResultBlock(
    blocks[0].asin,
    blocks[0].html,
    "www.amazon.com",
    "USD",
  );
  assert.ok(first);
  assert.equal(first.price, 19.99);
  assert.equal(first.rating, 4.6);
  assert.equal(first.reviewCount, 1_234);
  assert.equal(first.recentPurchaseLowerBound, 500);
  assert.ok(first.badges?.some((badge) => /Best Seller/iu.test(badge)));

  const detail = amazonCrawlerParserTestUtils.parseProductDetail(detailHtml);
  assert.equal(detail.brand, "DemoBrand");
  assert.equal(detail.salesRank, 1_234);
  assert.equal(detail.bulletPoints?.length, 3);
}

async function main(): Promise<void> {
  await verifyApiFirstRoute();
  await verifyCrawlerWithoutApiRoute();
  await verifyCrawlerAfterApiFailure();
  await verifyStructuredFailureDiagnostics();
  await verifyCrawlerParsers();
  console.log("Amazon API / crawler routing tests passed.");
}

void main();
