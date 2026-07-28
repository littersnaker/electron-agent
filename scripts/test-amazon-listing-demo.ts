/** Amazon Listing Demo 纯本地核心逻辑测试，不访问网络或模型。 */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}
import { validateAmazonListing } from "../app/lib/commerce/listing/compliance";
import { buildFallbackListingDraft } from "../app/lib/commerce/listing/fallback";
import { extractAmazonListingKeywords } from "../app/lib/commerce/listing/keywords";
import { createMockErpProduct } from "../app/lib/commerce/listing/mock-erp";
import type {
  CommerceCategoryResolution,
  CommerceProductSignal,
} from "../app/lib/commerce/types";

const category: CommerceCategoryResolution = {
  categoryName: "桌面夹式扶手",
  categoryNameEn: "Clamp-on Desk Arm Rest",
  keywords: ["desk arm rest", "ergonomic desk accessory", "forearm support"],
  subcategories: ["office accessories"],
  analysisDimensions: ["title", "bullet points", "keywords"],
  researchGoal: "Generate an Amazon Listing Demo.",
};

const competitors: CommerceProductSignal[] = [
  {
    asin: "TEST-ASIN-1",
    title: "Acme Adjustable Desk Arm Rest Forearm Support for Office Workstation",
    brand: "Acme",
    bulletPoints: [
      "Clamp-on desktop installation for home office desks",
      "Padded forearm support with adjustable positioning",
    ],
    source: "amazon-public-page",
  },
  {
    asin: "TEST-ASIN-2",
    title: "Northstar Ergonomic Forearm Support Clamp for Computer Desk",
    brand: "Northstar",
    source: "amazon-public-page",
  },
];

const mockErp = createMockErpProduct({
  query:
    "品牌: WorkEase，产品名: Clamp-on Desk Arm Rest，材质: steel and foam，颜色: black",
  category,
  marketplace: "US",
});
assertEqual(mockErp.brand, "WorkEase", "Mock ERP should parse brand");
assertEqual(mockErp.readyForPublish, false, "Mock ERP must not be publish-ready");
assert(
  mockErp.facts.some((fact) => fact.label === "Material" && !fact.requiresConfirmation),
  "User-provided material should be confirmed",
);

const keywords = extractAmazonListingKeywords({
  query: "clamp-on desk arm rest for office workstation",
  category,
  products: competitors,
});
assert(keywords.length >= 8, "Keyword extractor should return enough candidates");
assertEqual(
  keywords.some((keyword) => ["acme", "northstar"].includes(keyword.normalized)),
  false,
  "Competitor brands must be excluded from keywords",
);

const draft = buildFallbackListingDraft({ category, mockErp, keywords });
assert(draft.title.length <= 75, "Title should respect the 75-character guardrail");
assertEqual(draft.bulletPoints.length, 5, "Fallback should produce five bullets");
assert(
  new TextEncoder().encode(draft.searchTerms).length <= 240,
  "Search terms should respect the byte guardrail",
);

const validation = validateAmazonListing({
  draft,
  keywords,
  mockErp,
  competitorBrands: competitors.map((product) => product.brand || ""),
});
assertEqual(
  validation.issues.some((issue) => issue.code === "TITLE_TOO_LONG"),
  false,
  "Normalized fallback title should pass length validation",
);

const leakedBrandValidation = validateAmazonListing({
  draft: { ...draft, title: `Acme ${draft.title}`.slice(0, 75) },
  keywords,
  mockErp,
  competitorBrands: ["Acme"],
});
assert(
  leakedBrandValidation.issues.some((issue) => issue.code === "COMPETITOR_BRAND"),
  "Validator should detect competitor brand leakage",
);

console.log("Amazon Listing Demo core tests passed.");
