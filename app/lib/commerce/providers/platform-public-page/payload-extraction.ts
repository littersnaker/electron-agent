/**
 * 模块职责：JSON 脚本、HTML 链接与商品集合提取。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import type { CommerceProductSignal } from "../../types";
import { type JsonRecord, MAX_ANCHOR_MATCHES, MAX_JSON_OBJECTS, type PlatformCrawlerDefinition } from "./crawler-definitions";
import { createStableId, isRecord, matchesProductUrl, normalizeUrl, parsePriceFromText, parseRatingFromText, parseReviewCountFromText, parseSoldSignalFromText, productFromJsonRecord, readHtmlAttribute, stripTags } from "./product-parsers";
export function collectJsonObjects(value: unknown): JsonRecord[] {
  const objects: JsonRecord[] = [];
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new Set<object>();

  while (stack.length && objects.length < MAX_JSON_OBJECTS) {
    const current = stack.pop();
    if (!current || current.depth > 14) continue;
    const item = current.value;

    if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isRecord(item) || visited.has(item)) continue;
    visited.add(item);
    objects.push(item);

    for (const child of Object.values(item)) {
      if (child && typeof child === "object") {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }

  return objects;
}

export function extractJsonScriptPayloads(html: string): unknown[] {
  const payloads: unknown[] = [];
  const scripts = html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/giu,
  );

  for (const match of scripts) {
    const attributes = match[1] || "";
    const body = (match[2] || "").trim();
    if (!body || body.length > 15_000_000) continue;

    const type = readHtmlAttribute(`<script ${attributes}>`, "type") || "";
    const id = readHtmlAttribute(`<script ${attributes}>`, "id") || "";
    const looksLikeJson =
      /application\/(?:ld\+)?json/iu.test(type) ||
      /__NEXT_DATA__|__NUXT_DATA__|SIGI_STATE|INIT_DATA|SSR_DATA/iu.test(id);
    if (!looksLikeJson && !/^[\[{]/u.test(body)) continue;

    try {
      payloads.push(JSON.parse(body) as unknown);
    } catch {
      // 部分站点把 JSON 包在 JavaScript 赋值语句中。这里只解析首尾明确的对象/数组，
      // 不执行页面脚本，避免把爬虫变成任意代码执行器。
      const objectStart = body.indexOf("{");
      const arrayStart = body.indexOf("[");
      const start =
        objectStart < 0
          ? arrayStart
          : arrayStart < 0
            ? objectStart
            : Math.min(objectStart, arrayStart);
      const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
      if (start < 0 || end <= start) continue;
      try {
        payloads.push(JSON.parse(body.slice(start, end + 1)) as unknown);
      } catch {
        // 无法安全解析的脚本直接跳过；后续仍会使用 HTML 卡片解析。
      }
    }
  }

  return payloads;
}

export function parsePlatformJsonPayload(
  payload: unknown,
  definition: PlatformCrawlerDefinition,
  baseUrl: URL,
  currency: string,
): CommerceProductSignal[] {
  const products: CommerceProductSignal[] = [];
  for (const record of collectJsonObjects(payload)) {
    const product = productFromJsonRecord(
      record,
      definition,
      baseUrl,
      currency,
    );
    if (product) products.push(product);
  }
  return products;
}

export function extractProductsFromJson(
  html: string,
  definition: PlatformCrawlerDefinition,
  baseUrl: URL,
  currency: string,
): CommerceProductSignal[] {
  return extractJsonScriptPayloads(html).flatMap((payload) =>
    parsePlatformJsonPayload(payload, definition, baseUrl, currency),
  );
}

export function extractProductsFromAnchors(
  html: string,
  definition: PlatformCrawlerDefinition,
  baseUrl: URL,
  currency: string,
): CommerceProductSignal[] {
  const products: CommerceProductSignal[] = [];
  const anchorPattern = /<a\b([^>]*\bhref\s*=\s*(?:"[^"]+"|'[^']+')[^>]*)>([\s\S]*?)<\/a>/giu;
  let matchCount = 0;

  for (const match of html.matchAll(anchorPattern)) {
    matchCount += 1;
    if (matchCount > MAX_ANCHOR_MATCHES) break;

    const openingTag = `<a ${match[1] || ""}>`;
    const href = readHtmlAttribute(openingTag, "href");
    const productUrl = normalizeUrl(href, baseUrl);
    if (!productUrl || !matchesProductUrl(productUrl, definition)) continue;

    const body = match[2] || "";
    const title =
      readHtmlAttribute(openingTag, "aria-label") ||
      readHtmlAttribute(openingTag, "title") ||
      stripTags(body);
    if (!title || title.length < 3 || title.length > 500) continue;

    const index = match.index || 0;
    const context = html.slice(
      Math.max(0, index - 800),
      Math.min(html.length, index + match[0].length + 2_000),
    );
    const contextText = stripTags(context);
    const imageTag = /<img\b[^>]*>/iu.exec(body)?.[0] ||
      /<img\b[^>]*>/iu.exec(context)?.[0];
    const imageUrl = imageTag
      ? normalizeUrl(
          readHtmlAttribute(imageTag, "src") ||
            readHtmlAttribute(imageTag, "data-src") ||
            readHtmlAttribute(imageTag, "data-original"),
          baseUrl,
        )
      : undefined;
    const reviewCount = parseReviewCountFromText(contextText);
    const soldSignal = parseSoldSignalFromText(contextText);

    products.push({
      asin: createStableId(definition.sourceId, productUrl),
      title,
      platform: definition.sourceId,
      imageUrl,
      productUrl,
      price: parsePriceFromText(contextText),
      currency,
      rating: parseRatingFromText(contextText),
      reviewCount,
      recentPurchaseLowerBound: soldSignal.count,
      recentPurchaseLabel: soldSignal.label,
      source: definition.providerKind,
    });
  }

  return products;
}

export function mergePlatformProducts(
  products: CommerceProductSignal[],
  sampleSize: number,
): CommerceProductSignal[] {
  const map = new Map<string, CommerceProductSignal>();
  for (const product of products) {
    const key = product.productUrl || product.asin;
    const current = map.get(key);
    map.set(
      key,
      current
        ? {
            ...current,
            ...product,
            brand: product.brand ?? current.brand,
            imageUrl: product.imageUrl ?? current.imageUrl,
            price: product.price ?? current.price,
            rating: product.rating ?? current.rating,
            reviewCount: product.reviewCount ?? current.reviewCount,
            recentPurchaseLowerBound:
              product.recentPurchaseLowerBound ??
              current.recentPurchaseLowerBound,
            recentPurchaseLabel:
              product.recentPurchaseLabel ?? current.recentPurchaseLabel,
          }
        : product,
    );
  }
  return Array.from(map.values()).slice(0, sampleSize);
}
