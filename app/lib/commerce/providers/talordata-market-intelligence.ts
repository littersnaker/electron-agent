// 模块说明：负责 talordata market intelligence 核心服务与领域逻辑。
import { createHash } from "node:crypto";
import { getCommerceMarketplace } from "../marketplaces";
import type {
  CommerceMarketObservation,
  CommerceProductSignal,
} from "../types";
import {
  getTalorDataTokenCandidates,
  requestTalorData,
} from "./talordata-client";
import {
  collectTalorDataResultRows,
  describeTalorDataPayload,
  type TalorDataJsonRecord,
  type TalorDataResultRow,
} from "./talordata-response";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "./types";

const MAX_KEYWORDS = 3;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/,/gu, "").replace(/[^0-9.-]/gu, "");
  const parsed = Number(normalized);
  return normalized && Number.isFinite(parsed) ? parsed : undefined;
}

function price(value: unknown): number | undefined {
  if (typeof value === "number") return numeric(value);
  const raw = text(value);
  if (!raw) return undefined;
  const match =
    /(?:US\$|CA\$|AU\$|£|€|￥|¥|\$)?\s*([0-9][0-9,.]*(?:\.[0-9]{1,2})?)/u.exec(
      raw,
    );
  return match ? numeric(match[1]) : undefined;
}

function domainFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./u, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function stableId(seed: string): string {
  return `SERP-${createHash("sha1").update(seed).digest("hex").slice(0, 12)}`;
}

function firstText(
  item: TalorDataJsonRecord,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = text(item[key]);
    if (value) return value;
  }
  return undefined;
}

function firstNumber(
  item: TalorDataJsonRecord,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = numeric(item[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * 根据响应容器名判断结果类型。
 *
 * TalorData 普通搜索的广告字段通常叫 `sponsored_results`，相关搜索可能叫 `related`；
 * 旧实现没有覆盖这些字段，导致真实响应虽然连接成功，却无法形成可用 observation。
 */
function classifyResultType(
  container: string,
): CommerceMarketObservation["resultType"] {
  const normalized = container.toLowerCase();
  if (
    normalized.includes("shop") ||
    normalized.includes("product")
  ) {
    return "shopping";
  }
  if (
    normalized.includes("ad") ||
    normalized.includes("paid") ||
    normalized.includes("sponsor")
  ) {
    return "ad";
  }
  if (
    normalized.includes("related") ||
    normalized.includes("question") ||
    normalized.includes("people")
  ) {
    return "related";
  }
  if (
    normalized.includes("organic") ||
    normalized.includes("web")
  ) {
    return "organic";
  }
  return "other";
}

/**
 * 把 TalorData 单条原始结果转换为项目统一的公开市场观察结构。
 *
 * 字段别名以 TalorData 当前常见结构为主，同时保留旧版兼容：
 * - 普通结果：title / link / description / source；
 * - Shopping：product_title / product_link / price / merchant；
 * - Related / PAA：query / question / text / answer。
 */
function normalizeObservation(
  row: TalorDataResultRow,
  currency: string,
): CommerceMarketObservation | null {
  const item = row.item;
  const title = firstText(item, [
    "title",
    "name",
    "product_title",
    "question",
    "query",
    "text",
  ]);
  const url = firstText(item, [
    "link",
    "url",
    "product_link",
    "redirect_link",
  ]);
  const snippet = firstText(item, [
    "snippet",
    "description",
    "answer",
    "content",
  ]);
  const displayTitle = title || snippet;
  if (!displayTitle) return null;

  const resolvedPrice =
    firstNumber(item, [
      "extracted_price",
      "price_value",
      "price_numeric",
      "min_price",
    ]) ??
    price(item.price) ??
    price(item.current_price) ??
    price(snippet);
  const displayLink = firstText(item, [
    "display_link",
    "displayed_link",
    "displayed_url",
    "source",
  ]);
  const merchant =
    firstText(item, ["merchant", "seller", "source", "store", "domain"]) ||
    domainFromUrl(url) ||
    displayLink;
  const seed = [row.container, displayTitle, url || snippet || ""].join("|");

  return {
    id: stableId(seed),
    title: displayTitle,
    url,
    domain: domainFromUrl(url),
    snippet,
    resultType: classifyResultType(row.container),
    position: firstNumber(item, ["position", "rank", "index"]),
    price: resolvedPrice,
    currency: resolvedPrice !== undefined ? currency : undefined,
    rating: firstNumber(item, ["rating", "stars", "score"]),
    reviewCount: firstNumber(item, [
      "reviews",
      "review_count",
      "reviews_count",
      "ratings",
      "rating_count",
    ]),
    merchant,
    provider: "talordata-market",
  };
}

/**
 * Shopping 结果如果具备足够商品字段，会同时转换成 `CommerceProductSignal`。
 * 这是额外增强，不是流程完成的必要条件；即使一个商品也转不出来，SERP observations
 * 仍然足以完成基础市场洞察模式。
 */
function observationToProduct(
  observation: CommerceMarketObservation,
): CommerceProductSignal | null {
  if (observation.resultType !== "shopping" || !observation.url) return null;
  return {
    asin: stableId(observation.url),
    title: observation.title,
    platform: "market-search",
    brand: observation.merchant,
    productUrl: observation.url,
    price: observation.price,
    currency: observation.currency,
    rating: observation.rating,
    reviewCount: observation.reviewCount,
    source: "talordata-market",
  };
}

function searchContext(code: CommerceProviderSearchInput["marketplace"]): {
  gl: string;
  hl: string;
  location: string;
} {
  const market = getCommerceMarketplace(code);
  const [language = "en", country = "US"] = market.locale.split("_");
  const locations: Partial<Record<typeof code, string>> = {
    US: "United States",
    CA: "Canada",
    UK: "United Kingdom",
    DE: "Germany",
    FR: "France",
    IT: "Italy",
    ES: "Spain",
    JP: "Japan",
  };
  return {
    gl: country.toLowerCase(),
    hl: language.toLowerCase(),
    location: locations[code] || market.label,
  };
}

interface TalorDataQueryPlan {
  label: "Web" | "Shopping";
  engine: "google" | "google_shopping";
  q: string;
}

/**
 * v10 核心 Provider：只依赖 TalorData SERP，不依赖 Amazon / Keepa / Seller Central。
 *
 * 修复重点：
 * 1. 普通 Google 搜索按 TalorData 当前 `organic` 响应解析；
 * 2. Shopping 使用文档支持的 `google_shopping` engine，而不是只依赖 `tbm=shop`；
 * 3. 通过共享响应兼容层解析嵌套对象、顶层数组和 JSON 字符串包装；
 * 4. 无结果时输出响应结构摘要，便于后续定位账号或接口版本差异。
 */
export class TalorDataMarketIntelligenceProvider
  implements CommerceDataProvider
{
  readonly kind = "talordata-market" as const;

  constructor(private readonly requestToken?: string) {}

  isConfigured(): boolean {
    return getTalorDataTokenCandidates(this.requestToken).length > 0;
  }

  async searchProducts(
    input: CommerceProviderSearchInput,
  ): Promise<CommerceProviderSearchResult> {
    const market = getCommerceMarketplace(input.marketplace);
    const context = searchContext(input.marketplace);
    const keywords = Array.from(
      new Set([...input.category.keywords, input.category.categoryNameEn]),
    )
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, MAX_KEYWORDS);

    const observations = new Map<string, CommerceMarketObservation>();
    const warnings: string[] = [];
    const responseShapes: string[] = [];

    for (const keyword of keywords) {
      const requests: TalorDataQueryPlan[] = [
        { q: keyword, label: "Web", engine: "google" },
        { q: keyword, label: "Shopping", engine: "google_shopping" },
      ];

      for (const query of requests) {
        try {
          const { payload, credentialSource } = await requestTalorData(
            {
              ...context,
              engine: query.engine,
              q: query.q,
              num: Math.min(20, input.sampleSize),
              json: 1,
            },
            this.requestToken,
            input.signal,
          );

          const rows = collectTalorDataResultRows(payload);
          responseShapes.push(
            `${query.label}:${describeTalorDataPayload(payload)} -> ${rows.length}`,
          );
          for (const row of rows) {
            const observation = normalizeObservation(row, market.currency);
            if (observation) observations.set(observation.id, observation);
          }
          warnings.push(
            `TalorData ${query.label} 使用${
              credentialSource === "environment"
                ? "应用默认 Token"
                : "本机 Token"
            }，解析到 ${rows.length} 条候选结果。`,
          );
        } catch (error) {
          warnings.push(
            `${keyword} ${query.label}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    const observationList = Array.from(observations.values()).slice(
      0,
      Math.max(input.sampleSize, 30),
    );
    if (!observationList.length) {
      throw new Error(
        [
          "TalorData 已连接，但本轮没有解析到可用公开市场结果。",
          responseShapes.length
            ? `响应结构：${responseShapes.join("；")}`
            : "没有取得可诊断的成功响应结构。",
          warnings.length ? `诊断：${warnings.join("；")}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    }

    const products = observationList
      .map(observationToProduct)
      .filter((item): item is CommerceProductSignal => Boolean(item))
      .slice(0, input.sampleSize);

    return {
      provider: this.kind,
      sourceId: "market-search",
      products,
      observations: observationList,
      coverage: [
        "公开 Web 搜索结果",
        "Shopping 可见度",
        "竞品/品牌域名",
        "可解析价格",
        "可解析评分与评论",
      ],
      warnings: [
        ...warnings,
        "TalorData 提供的是公开 SERP 市场信号，不代表平台官方销量、GMV 或搜索量。",
      ],
    };
  }
}
