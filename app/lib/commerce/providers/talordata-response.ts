/**
 * TalorData SERP 响应结构兼容层。
 *
 * TalorData 的不同搜索引擎、垂直搜索和版本可能采用不同字段名，例如：
 * - 普通 Google 搜索常见 `organic`；
 * - 部分兼容响应使用 `organic_results`；
 * - 广告可能位于 `sponsored_results`、`ads` 或 `paid_results`；
 * - Shopping 结果可能位于 `shopping`、`shopping_results`、`products`；
 * - 某些 SDK / 网关还会把真实结果包装在 `data`、`result`、`response` 中，
 *   甚至将内部 JSON 再编码成字符串。
 *
 * 这里不直接做业务字段归一化，只负责把所有“看起来像搜索结果”的对象提取出来，
 * 避免上层 Provider 因为只识别某一个固定 schema 而把有效响应误判为空数据。
 */

export type TalorDataJsonRecord = Record<string, unknown>;

export interface TalorDataResultRow {
  /** 原始结果所在的容器名，用于判断 organic / shopping / ad / related。 */
  container: string;
  /** TalorData 返回的单条原始结果对象。 */
  item: TalorDataJsonRecord;
}

/**
 * 已知结果容器。全部转为小写比较，兼容不同命名风格。
 * `results` / `items` 属于通用容器，仍需通过结果对象特征做二次判断。
 */
const RESULT_CONTAINER_KEYS = new Set([
  "organic",
  "organic_results",
  "web_results",
  "results",
  "items",
  "shopping",
  "shopping_results",
  "inline_shopping_results",
  "product_results",
  "products",
  "sponsored_results",
  "ads",
  "ad_results",
  "paid_results",
  "related",
  "related_searches",
  "people_also_ask",
  "people_are_saying",
  "questions",
]);

/** 这些字段通常意味着对象本身就是一条可展示的搜索结果。 */
const RESULT_IDENTITY_KEYS = new Set([
  "title",
  "name",
  "product_title",
  "question",
  "query",
  "text",
]);

/** 这些字段用于辅助确认对象不是单纯的元数据。 */
const RESULT_DETAIL_KEYS = new Set([
  "link",
  "url",
  "product_link",
  "redirect_link",
  "description",
  "snippet",
  "answer",
  "price",
  "extracted_price",
  "position",
  "rank",
  "source",
  "merchant",
]);

export function isTalorDataRecord(
  value: unknown,
): value is TalorDataJsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * 部分中间层会把 JSON 放在字符串字段中返回。只有明显以 `{` 或 `[` 开头时才尝试解析，
 * 避免把普通标题、摘要误当成 JSON。
 */
function parseNestedJson(value: string): unknown {
  const normalized = value.trim();
  if (!normalized.startsWith("{") && !normalized.startsWith("[")) {
    return undefined;
  }

  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return undefined;
  }
}

function looksLikeResultItem(value: TalorDataJsonRecord): boolean {
  const keys = new Set(Object.keys(value).map((key) => key.toLowerCase()));
  const hasIdentity = Array.from(RESULT_IDENTITY_KEYS).some((key) => keys.has(key));
  const hasDetail = Array.from(RESULT_DETAIL_KEYS).some((key) => keys.has(key));

  // related / people-also-ask 有时只有 question/text，没有链接，因此“身份字段”本身即可成立；
  // 对通用 results/items 容器，详情字段可以进一步排除纯配置对象。
  return hasIdentity && (hasDetail || keys.size <= 8);
}

function normalizedContainerName(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized || "results";
}

/**
 * 从任意 TalorData JSON 中递归提取结果对象。
 *
 * 兼容能力：
 * 1. 顶层或嵌套数组；
 * 2. `data/result/response/payload` 等任意对象包装；
 * 3. JSON 字符串二次包装；
 * 4. `organic`、`organic_results`、`sponsored_results`、`related` 等字段别名；
 * 5. 未知容器中只要对象具备搜索结果特征，也会作为 best-effort 结果保留。
 */
export function collectTalorDataResultRows(
  payload: unknown,
): TalorDataResultRow[] {
  const rows: TalorDataResultRow[] = [];
  const visited = new WeakSet<object>();
  const seenItems = new WeakSet<object>();

  const append = (container: string, item: TalorDataJsonRecord): void => {
    if (seenItems.has(item)) return;
    seenItems.add(item);
    rows.push({ container: normalizedContainerName(container), item });
  };

  const visit = (
    value: unknown,
    depth: number,
    inheritedContainer?: string,
  ): void => {
    if (depth > 8 || value === null || value === undefined) return;

    if (typeof value === "string") {
      const nested = parseNestedJson(value);
      if (nested !== undefined) {
        visit(nested, depth + 1, inheritedContainer);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (isTalorDataRecord(item) && looksLikeResultItem(item)) {
          append(inheritedContainer || "results", item);
        }
        visit(item, depth + 1, inheritedContainer);
      }
      return;
    }

    if (!isTalorDataRecord(value)) return;
    if (visited.has(value)) return;
    visited.add(value);

    if (looksLikeResultItem(value) && inheritedContainer) {
      append(inheritedContainer, value);
    }

    for (const [rawKey, child] of Object.entries(value)) {
      const key = rawKey.toLowerCase();
      const isKnownContainer = RESULT_CONTAINER_KEYS.has(key);
      const nextContainer = isKnownContainer ? key : inheritedContainer;

      if (Array.isArray(child)) {
        for (const item of child) {
          if (
            isTalorDataRecord(item) &&
            (isKnownContainer || looksLikeResultItem(item))
          ) {
            append(isKnownContainer ? key : nextContainer || rawKey, item);
          }
          visit(item, depth + 1, nextContainer || rawKey);
        }
        continue;
      }

      if (isTalorDataRecord(child)) {
        if (isKnownContainer && looksLikeResultItem(child)) {
          append(key, child);
        }
        visit(child, depth + 1, nextContainer || rawKey);
        continue;
      }

      if (typeof child === "string") {
        const nested = parseNestedJson(child);
        if (nested !== undefined) {
          visit(nested, depth + 1, nextContainer || rawKey);
        }
      }
    }
  };

  visit(payload, 0);
  return rows;
}

/**
 * 生成不包含具体数据内容的响应结构摘要，用于错误诊断。
 * 只输出顶层类型、字段名与数组长度，不会把标题、URL 或潜在敏感信息写入日志。
 */
export function describeTalorDataPayload(payload: unknown): string {
  if (payload === undefined) return "empty-response";
  if (payload === null) return "null-response";

  if (typeof payload === "string") {
    const nested = parseNestedJson(payload);
    return nested === undefined
      ? `text(len=${payload.length})`
      : `json-string -> ${describeTalorDataPayload(nested)}`;
  }

  if (Array.isArray(payload)) {
    return `array(len=${payload.length})`;
  }

  if (!isTalorDataRecord(payload)) {
    return typeof payload;
  }

  const parts = Object.entries(payload)
    .slice(0, 20)
    .map(([key, value]) => {
      if (Array.isArray(value)) return `${key}[${value.length}]`;
      if (isTalorDataRecord(value)) return `${key}{${Object.keys(value).length}}`;
      if (typeof value === "string") return `${key}:text`;
      return `${key}:${typeof value}`;
    });

  return parts.length ? parts.join(", ") : "object(empty)";
}
