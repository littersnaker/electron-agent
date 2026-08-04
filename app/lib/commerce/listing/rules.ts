/**
 * Listing Demo 使用的保守规则集。
 *
 * 这里不是 Product Type Definitions API 的替代品。正式发布前仍需按站点和
 * productType 拉取动态 Schema。Demo 仅提供稳定、可解释的本地质量门禁。
 */
export const AMAZON_LISTING_DEMO_RULES = {
  policyVersion: "amazon-demo-2026-07-27" as const,
  titleMaxCharacters: 75 as const,
  bulletMinimumCount: 3 as const,
  bulletMaximumCount: 5 as const,
  bulletMinimumCharacters: 10 as const,
  bulletMaximumCharacters: 255 as const,
  backendSearchTermMaximumBytes: 240 as const,
  productDescriptionMaximumCharacters: 2000,
  forbiddenTitleCharacters: /[!$?_{}^¬¦]/u,
  forbiddenContactPattern:
    /(?:https?:\/\/|www\.|@[a-z0-9.-]+\.[a-z]{2,}|\b(?:email|e-mail|phone|whatsapp|wechat)\b)/iu,
  promotionalPattern:
    /\b(?:best seller|best-selling|free shipping|limited time|lowest price|sale|discount|coupon|buy now|money back|full refund|guaranteed results?)\b/iu,
} as const;

/** Amazon 标题重复词检查中不计入的常见功能词。 */
export const AMAZON_TITLE_REPEAT_EXEMPTIONS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);
