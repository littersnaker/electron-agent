/**
 * Amazon Listing Demo 的确定性校验器。
 *
 * 字符数、UTF-8 字节、重复词和禁用表达都由代码计算，避免让 LLM 自己判断。
 * 本文件不依赖 Node.js API，因此服务端生成和浏览器端编辑预览可复用同一套规则。
 */
import type {
  AmazonListingDraft,
  AmazonListingIssue,
  AmazonListingKeyword,
  AmazonListingValidation,
  AmazonMockErpProduct,
} from "./types";
import {
  AMAZON_LISTING_DEMO_RULES,
  AMAZON_TITLE_REPEAT_EXEMPTIONS,
} from "./rules";

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function repeatedTitleWords(title: string): string[] {
  const counts = new Map<string, number>();
  for (const word of normalizeText(title).split(/\s+/u)) {
    if (!word || AMAZON_TITLE_REPEAT_EXEMPTIONS.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 2)
    .map(([word]) => word);
}

function addTextPolicyIssues(
  issues: AmazonListingIssue[],
  field: AmazonListingIssue["field"],
  value: string,
): void {
  if (AMAZON_LISTING_DEMO_RULES.forbiddenContactPattern.test(value)) {
    issues.push({
      field,
      severity: "error",
      code: "CONTACT_OR_URL",
      message: "内容包含联系方式、邮箱或站外链接。",
      suggestedFix: "删除所有联系方式、网址和引流表达。",
    });
  }
  if (AMAZON_LISTING_DEMO_RULES.promotionalPattern.test(value)) {
    issues.push({
      field,
      severity: "warning",
      code: "PROMOTIONAL_CLAIM",
      message: "内容包含促销、排名或退款保证类表达。",
      suggestedFix: "改为客观的产品事实和使用价值描述。",
    });
  }
}

function calculateKeywordCoverage(
  draft: AmazonListingDraft,
  keywords: AmazonListingKeyword[],
): { covered: string[]; missing: string[]; score: number } {
  const searchable = normalizeText(
    [draft.title, ...draft.bulletPoints, draft.productDescription, draft.searchTerms].join(" "),
  );
  const unique = [...new Map(keywords.map((item) => [item.normalized, item])).values()];
  const covered = unique
    .filter((item) => searchable.includes(item.normalized))
    .map((item) => item.phrase);
  const missing = unique
    .filter((item) => !searchable.includes(item.normalized))
    .map((item) => item.phrase);
  const weightedTotal = unique.reduce((sum, item) => sum + item.score, 0);
  const weightedCovered = unique
    .filter((item) => searchable.includes(item.normalized))
    .reduce((sum, item) => sum + item.score, 0);
  return {
    covered,
    missing,
    score: weightedTotal ? clampScore((weightedCovered / weightedTotal) * 100) : 0,
  };
}

function calculateReadability(draft: AmazonListingDraft): number {
  let score = 100;
  if (draft.title.length < 35) score -= 12;
  if (draft.title.length > 70) score -= 8;
  for (const bullet of draft.bulletPoints) {
    if (bullet.length > 220) score -= 8;
    if (bullet.split(/[.!?。！？]/u).length > 4) score -= 5;
  }
  if (draft.productDescription.length > 1500) score -= 8;
  return clampScore(score);
}

export function validateAmazonListing(input: {
  draft: AmazonListingDraft;
  keywords: AmazonListingKeyword[];
  mockErp: AmazonMockErpProduct;
  competitorBrands?: string[];
}): AmazonListingValidation {
  const { draft, keywords, mockErp } = input;
  const rules = AMAZON_LISTING_DEMO_RULES;
  const issues: AmazonListingIssue[] = [];

  if (!draft.title.trim()) {
    issues.push({ field: "title", severity: "error", code: "TITLE_EMPTY", message: "标题不能为空。" });
  } else if (draft.title.length > rules.titleMaxCharacters) {
    issues.push({
      field: "title",
      severity: "error",
      code: "TITLE_TOO_LONG",
      message: `标题为 ${draft.title.length} 个字符，超过 Demo 上限 ${rules.titleMaxCharacters}。`,
      suggestedFix: "保留品牌、核心品类词和最重要的差异化属性。",
    });
  }
  if (rules.forbiddenTitleCharacters.test(draft.title)) {
    issues.push({
      field: "title",
      severity: "error",
      code: "TITLE_FORBIDDEN_CHARACTER",
      message: "标题包含 Demo 规则禁止的特殊字符。",
    });
  }
  const repeatedWords = repeatedTitleWords(draft.title);
  if (repeatedWords.length) {
    issues.push({
      field: "title",
      severity: "warning",
      code: "TITLE_REPEATED_WORD",
      message: `标题中的词重复超过两次：${repeatedWords.join("、")}。`,
    });
  }
  addTextPolicyIssues(issues, "title", draft.title);

  if (
    draft.bulletPoints.length < rules.bulletMinimumCount ||
    draft.bulletPoints.length > rules.bulletMaximumCount
  ) {
    issues.push({
      field: "bulletPoints",
      severity: "error",
      code: "BULLET_COUNT",
      message: `Bullet 应保持 ${rules.bulletMinimumCount}-${rules.bulletMaximumCount} 条。`,
    });
  }
  draft.bulletPoints.forEach((bullet, index) => {
    if (
      bullet.length < rules.bulletMinimumCharacters ||
      bullet.length > rules.bulletMaximumCharacters
    ) {
      issues.push({
        field: "bulletPoints",
        severity: "warning",
        code: "BULLET_LENGTH",
        message: `第 ${index + 1} 条 Bullet 为 ${bullet.length} 个字符，建议控制在 ${rules.bulletMinimumCharacters}-${rules.bulletMaximumCharacters}。`,
      });
    }
    addTextPolicyIssues(issues, "bulletPoints", bullet);
  });

  if (draft.productDescription.length > rules.productDescriptionMaximumCharacters) {
    issues.push({
      field: "productDescription",
      severity: "warning",
      code: "DESCRIPTION_TOO_LONG",
      message: `描述超过 Demo 建议长度 ${rules.productDescriptionMaximumCharacters}。`,
    });
  }
  addTextPolicyIssues(issues, "productDescription", draft.productDescription);

  const searchTermBytes = utf8Bytes(draft.searchTerms);
  if (searchTermBytes > rules.backendSearchTermMaximumBytes) {
    issues.push({
      field: "searchTerms",
      severity: "error",
      code: "SEARCH_TERMS_TOO_LONG",
      message: `后台 Search Terms 为 ${searchTermBytes} UTF-8 字节，超过 Demo 安全上限 ${rules.backendSearchTermMaximumBytes}。`,
    });
  }
  addTextPolicyIssues(issues, "searchTerms", draft.searchTerms);

  const listingText = normalizeText(
    [draft.title, ...draft.bulletPoints, draft.productDescription, draft.searchTerms].join(" "),
  );
  const ownBrand = normalizeText(mockErp.brand);
  const competitorBrands = Array.from(
    new Set((input.competitorBrands || []).map(normalizeText).filter(Boolean)),
  ).filter((brand) => brand !== ownBrand && brand.length >= 3);
  const leakedBrands = competitorBrands.filter((brand) => listingText.includes(brand));
  if (leakedBrands.length) {
    issues.push({
      field: "facts",
      severity: "error",
      code: "COMPETITOR_BRAND",
      message: `Listing 中疑似出现竞品品牌：${leakedBrands.join("、")}。`,
      suggestedFix: "删除竞品品牌并改用通用品类词或本品牌名称。",
    });
  }

  const unconfirmedFacts = mockErp.facts.filter((fact) => fact.requiresConfirmation);
  if (unconfirmedFacts.length) {
    issues.push({
      field: "facts",
      severity: "warning",
      code: "MOCK_ERP_UNCONFIRMED",
      message: `${unconfirmedFacts.length} 个商品字段来自模拟 ERP 或竞品推断，正式使用前必须确认。`,
    });
  }

  const keywordCoverage = calculateKeywordCoverage(draft, keywords);
  const errorCount = issues.filter((item) => item.severity === "error").length;
  const warningCount = issues.filter((item) => item.severity === "warning").length;
  const compliance = clampScore(100 - errorCount * 24 - warningCount * 7);
  const completeness = clampScore(
    35 + draft.bulletPoints.length * 9 + (draft.productDescription ? 12 : 0) + (draft.searchTerms ? 8 : 0),
  );
  const factualSafety = clampScore(100 - Math.min(55, unconfirmedFacts.length * 7));
  const readability = calculateReadability(draft);
  const overall = clampScore(
    compliance * 0.35 +
      keywordCoverage.score * 0.25 +
      completeness * 0.15 +
      readability * 0.15 +
      factualSafety * 0.1,
  );

  return {
    policyVersion: rules.policyVersion,
    titleMaxCharacters: rules.titleMaxCharacters,
    bulletMinimumCount: rules.bulletMinimumCount,
    bulletMaximumCount: rules.bulletMaximumCount,
    bulletMinimumCharacters: rules.bulletMinimumCharacters,
    bulletMaximumCharacters: rules.bulletMaximumCharacters,
    backendSearchTermMaximumBytes: rules.backendSearchTermMaximumBytes,
    issues,
    score: {
      overall,
      compliance,
      keywordCoverage: keywordCoverage.score,
      completeness,
      readability,
      factualSafety,
    },
    keywordCoverage: {
      covered: keywordCoverage.covered,
      missing: keywordCoverage.missing,
    },
  };
}
