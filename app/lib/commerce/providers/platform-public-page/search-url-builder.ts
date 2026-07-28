/**
 * 模块职责：关键词解析、搜索模板和平台搜索地址构建。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import type { CommerceProductSignal } from "../../types";
import type { CommerceProviderSearchInput } from "../types";
import { DEFAULT_MAX_KEYWORDS, type PlatformCrawlerDefinition } from "./crawler-definitions";
import { readBoundedInteger } from "./product-parsers";
import { extractProductsFromAnchors, extractProductsFromJson, mergePlatformProducts } from "./payload-extraction";
export function resolvePlatformCrawlerKeywords(
  input: CommerceProviderSearchInput,
  definition: PlatformCrawlerDefinition,
): string[] {
  const candidates =
    definition.keywordMode === "localized"
      ? [
          input.category.categoryName,
          ...input.category.keywords,
          input.category.categoryNameEn,
        ]
      : [
          ...input.category.keywords,
          input.category.categoryNameEn,
          input.category.categoryName,
        ];
  const maximum = readBoundedInteger(
    "COMMERCE_CRAWLER_MAX_KEYWORDS",
    DEFAULT_MAX_KEYWORDS,
    1,
    5,
  );
  return Array.from(
    new Set(candidates.map((item) => item.trim()).filter(Boolean)),
  ).slice(0, maximum);
}

export function resolvePlatformBrowserSearchTemplates(
  definition: PlatformCrawlerDefinition,
): string[] {
  const configured =
    process.env[definition.browserSearchUrlTemplatesEnvironmentName]?.trim();
  if (!configured) return definition.defaultBrowserSearchUrlTemplates;

  return configured
    .split(/\r?\n|\|/gu)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildPlatformSearchUrl(
  definition: PlatformCrawlerDefinition,
  keyword: string,
  page: number,
  templateOverride?: string,
): URL {
  const template =
    templateOverride ||
    process.env[definition.searchUrlTemplateEnvironmentName]?.trim() ||
    definition.defaultSearchUrlTemplate;
  const encodedKeyword = encodeURIComponent(keyword);
  const value = template
    .replaceAll("{keyword}", encodedKeyword)
    .replaceAll("{page}", String(page));
  const url = new URL(value);

  // 自定义模板可能没有页码占位符。此时统一补上平台定义的分页参数。
  if (!template.includes("{page}")) {
    url.searchParams.set(definition.pageParameter, String(page));
  }
  return url;
}

export function parsePlatformPage(
  html: string,
  definition: PlatformCrawlerDefinition,
  pageUrl: URL,
  currency: string,
): CommerceProductSignal[] {
  return mergePlatformProducts(
    [
      ...extractProductsFromJson(html, definition, pageUrl, currency),
      ...extractProductsFromAnchors(html, definition, pageUrl, currency),
    ],
    Number.MAX_SAFE_INTEGER,
  );
}
