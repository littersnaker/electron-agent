/**
 * 模块职责：浏览器页面抓取、滚动和响应商品提取。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { type BrowserContext } from "playwright-core";
import type { CommerceProductSignal } from "../../types";
import { assertPlatformPageUsable, mergePlatformProducts, parsePlatformPage, type PlatformCrawlerDefinition } from "../platform-public-page";
import { type BrowserPageResult, DEFAULT_MAX_JSON_BYTES, DEFAULT_MAX_JSON_RESPONSES, DEFAULT_NAVIGATION_TIMEOUT_MS, DEFAULT_SCROLL_STEPS, DEFAULT_SETTLE_TIME_MS, collectProductsFromResponse, isInterestingJsonResponse, readBoundedInteger, scrollForLazyContent } from "./browser-runtime";
export async function crawlBrowserPage(
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
