/**
 * 模块职责：Lib Commerce Providers Platform Public Page 对外兼容入口。
 * 说明：内部实现已按企业级单一职责拆分；保留原导入路径，避免影响调用方。
 */
export { PLATFORM_CRAWLER_DEFINITIONS } from "./platform-public-page/crawler-definitions";
export { PlatformCrawlerDefinition } from "./platform-public-page/crawler-definitions";
export { PlatformPublicPageProvider } from "./platform-public-page/public-page-provider";
export { SupportedPlatformSource } from "./platform-public-page/crawler-definitions";
export { assertPlatformPageUsable } from "./platform-public-page/network-client";
export { buildPlatformSearchUrl } from "./platform-public-page/search-url-builder";
export { mergePlatformProducts } from "./platform-public-page/payload-extraction";
export { parsePlatformJsonPayload } from "./platform-public-page/payload-extraction";
export { parsePlatformPage } from "./platform-public-page/search-url-builder";
export { platformCrawlerParserTestUtils } from "./platform-public-page/public-page-provider";
export { resolvePlatformBrowserSearchTemplates } from "./platform-public-page/search-url-builder";
export { resolvePlatformCrawlerKeywords } from "./platform-public-page/search-url-builder";
export { resolvePlatformCrawlerProxyUrl } from "./platform-public-page/network-client";
export { resolvePlatformCrawlerUserAgent } from "./platform-public-page/network-client";
