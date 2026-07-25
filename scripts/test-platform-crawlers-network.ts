import { PlatformAutoProvider } from "../app/lib/commerce/providers/platform-auto";
import { PlatformBrowserPageProvider } from "../app/lib/commerce/providers/platform-browser-page";
import { PlatformPublicPageProvider } from "../app/lib/commerce/providers/platform-public-page";
import { PLATFORM_SERP_CONFIGS } from "../app/lib/commerce/providers/platform-serp";
import type { CommerceProviderSearchInput } from "../app/lib/commerce/providers/types";

/**
 * TikTok Shop、Temu、1688 爬虫真实网络冒烟测试。
 *
 * 测试顺序与生产链路一致：HTTP 公开页 → Playwright 浏览器。
 * 默认模式只输出每个平台的真实诊断，不会因为目标站点风控、地区限制或当前网络不可达而
 * 把“环境不可用”误判成“代码回归失败”。需要 CI 严格要求至少一个平台拿到样本时，设置：
 * COMMERCE_CRAWLER_NETWORK_TEST_STRICT=true。
 */
async function main(): Promise<void> {
  const input: CommerceProviderSearchInput = {
    marketplace: "US",
    category: {
      categoryName: "电脑支架",
      categoryNameEn: "Laptop Stand",
      keywords: ["laptop stand"],
      subcategories: [],
      analysisDimensions: ["价格", "评分", "评论"],
      researchGoal: "验证多平台 HTTP 与 Playwright 浏览器爬虫网络及解析链路。",
    },
    sampleSize: 3,
  };

  let successCount = 0;
  const failures: string[] = [];

  for (const config of PLATFORM_SERP_CONFIGS) {
    const httpProvider = new PlatformPublicPageProvider(config);
    const browserProvider = new PlatformBrowserPageProvider(config);
    const provider = new PlatformAutoProvider(config, undefined, {
      candidates: [
        {
          route: "crawler",
          label: `${config.label} HTTP 公开页爬虫`,
          provider: httpProvider,
        },
        {
          route: "crawler",
          label: `${config.label} Playwright 浏览器爬虫`,
          provider: browserProvider,
        },
      ],
    });

    if (!provider.isConfigured()) {
      console.warn(`${config.label} crawler disabled, skipped.`);
      continue;
    }

    try {
      const result = await provider.searchProducts(input);
      successCount += 1;
      console.log(
        `${config.label} crawler passed: ${result.products.length} products, engine=${result.crawlerEngine || "unknown"}, provider=${result.provider}.`,
      );
      for (const warning of result.warnings) console.log(`  - ${warning}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${config.label}: ${message}`);
      console.error(`${config.label} crawler unavailable in current environment: ${message}`);
    }
  }

  console.log(
    `Crawler network diagnostics completed: ${successCount} platform(s) returned samples, ${failures.length} platform(s) unavailable.`,
  );

  const strict = process.env.COMMERCE_CRAWLER_NETWORK_TEST_STRICT === "true";
  if (strict && !successCount) {
    throw new Error(
      `严格模式要求至少一个平台取得样本。诊断：${failures.join("；")}`,
    );
  }
}

void main();
