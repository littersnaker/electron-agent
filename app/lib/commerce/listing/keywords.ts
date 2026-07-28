/**
 * 从用户需求、类目词和 Amazon 竞品标题/Bullet 中提取 Listing 关键词。
 *
 * 该实现不依赖搜索量 API，只做 Demo 级“相关性 + 竞品出现频次”排序；
 * 结果用于帮助生成文案，不会被描述为真实搜索量或流量数据。
 */
import type { CommerceCategoryResolution, CommerceProductSignal } from "../types";
import type {
  AmazonKeywordCluster,
  AmazonKeywordPlacement,
  AmazonListingKeyword,
} from "./types";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "your",
  "new",
  "pack",
]);

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[’']/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function phraseCandidates(value: string): string[] {
  const words = tokenize(value);
  const phrases = [...words];
  for (let index = 0; index < words.length - 1; index += 1) {
    phrases.push(`${words[index]} ${words[index + 1]}`);
  }
  for (let index = 0; index < words.length - 2; index += 1) {
    phrases.push(`${words[index]} ${words[index + 1]} ${words[index + 2]}`);
  }
  return phrases;
}

function inferCluster(phrase: string): AmazonKeywordCluster {
  if (/\b(?:for|use|home|office|travel|outdoor|indoor|kitchen|bedroom|car)\b/iu.test(phrase)) {
    return "use-case";
  }
  if (/\b(?:women|men|kids|children|adult|pet|dog|cat|baby|student)\b/iu.test(phrase)) {
    return "audience";
  }
  if (/\b(?:size|inch|cm|mm|black|white|blue|red|steel|wood|plastic|cotton)\b/iu.test(phrase)) {
    return "attribute";
  }
  if (phrase.split(" ").length >= 3) return "long-tail";
  if (/\b(?:portable|adjustable|reusable|waterproof|lightweight|durable|compact|soft|heavy duty)\b/iu.test(phrase)) {
    return "feature";
  }
  return "core";
}

function placementFor(index: number): AmazonKeywordPlacement {
  if (index < 4) return "title";
  if (index < 11) return "bullet";
  return "backend";
}

interface Candidate {
  phrase: string;
  normalized: string;
  source: AmazonListingKeyword["source"];
  score: number;
}

function addCandidate(
  map: Map<string, Candidate>,
  phrase: string,
  source: Candidate["source"],
  score: number,
  forbiddenBrands: Set<string>,
): void {
  const normalized = normalize(phrase);
  if (!normalized || normalized.length < 3 || normalized.length > 64) return;
  if ([...forbiddenBrands].some((brand) => brand.length >= 2 && normalized.includes(brand))) {
    return;
  }
  const existing = map.get(normalized);
  if (!existing) {
    map.set(normalized, { phrase: phrase.trim(), normalized, source, score });
    return;
  }
  existing.score += score;
  if (source === "query" || (source === "category" && existing.source === "amazon-competitor")) {
    existing.source = source;
    existing.phrase = phrase.trim();
  }
}

export function extractAmazonListingKeywords(input: {
  query: string;
  category: CommerceCategoryResolution;
  products: CommerceProductSignal[];
  maximum?: number;
}): AmazonListingKeyword[] {
  const maximum = Math.max(8, Math.min(24, input.maximum || 18));
  const candidates = new Map<string, Candidate>();
  const forbiddenBrands = new Set(
    input.products
      .map((product) => normalize(product.brand || ""))
      .filter(Boolean),
  );

  phraseCandidates(input.query).forEach((phrase) =>
    addCandidate(candidates, phrase, "query", 18, forbiddenBrands),
  );
  [input.category.categoryNameEn, ...input.category.keywords].forEach((keyword) =>
    addCandidate(candidates, keyword, "category", 24, forbiddenBrands),
  );

  input.products.slice(0, 16).forEach((product, productIndex) => {
    const weight = Math.max(2, 10 - Math.floor(productIndex / 3));
    [product.title, ...(product.bulletPoints || []).slice(0, 5)].forEach((text) => {
      phraseCandidates(text).forEach((phrase) =>
        addCandidate(candidates, phrase, "amazon-competitor", weight, forbiddenBrands),
      );
    });
  });

  const sorted = [...candidates.values()]
    .filter((candidate) => {
      const words = candidate.normalized.split(" ");
      return words.length > 1 || candidate.source !== "amazon-competitor";
    })
    .sort((left, right) => right.score - left.score || left.phrase.length - right.phrase.length)
    .slice(0, maximum);

  const maximumScore = sorted[0]?.score || 1;
  return sorted.map((candidate, index) => ({
    phrase: candidate.phrase,
    normalized: candidate.normalized,
    cluster: inferCluster(candidate.normalized),
    source: candidate.source,
    score: Math.max(10, Math.round((candidate.score / maximumScore) * 100)),
    placement: placementFor(index),
  }));
}
