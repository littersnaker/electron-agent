/** LLM 不可用时的确定性 Listing Demo 降级输出。 */
import type { CommerceCategoryResolution } from "../types";
import type {
  AmazonListingDraft,
  AmazonListingKeyword,
  AmazonMockErpProduct,
} from "./types";
import { normalizeAmazonListingDraft } from "./normalization";

export function buildFallbackListingDraft(input: {
  category: CommerceCategoryResolution;
  mockErp: AmazonMockErpProduct;
  keywords: AmazonListingKeyword[];
}): AmazonListingDraft {
  const titleKeywords = input.keywords
    .filter((keyword) => keyword.placement === "title")
    .slice(0, 2)
    .map((keyword) => keyword.phrase);
  const title = [input.mockErp.brand, input.category.categoryNameEn, ...titleKeywords]
    .filter(Boolean)
    .join(" ");
  const bulletKeywords = input.keywords
    .filter((keyword) => keyword.placement === "bullet")
    .slice(0, 5);
  const bullets = [
    `DEMO PRODUCT PROFILE – ${input.mockErp.productName} is generated from the current brief and must be verified against the real ERP record.`,
    `KEYWORD DIRECTION – The draft prioritizes ${bulletKeywords.slice(0, 2).map((item) => item.phrase).join(" and ") || "category-relevant search phrases"} without copying competitor brands.`,
    "FACT SAFETY – Material, dimensions, package contents, compatibility, and compliance claims remain placeholders until confirmed by the product team.",
    "MARKET REFERENCE – Amazon crawler samples are used only to identify common wording and customer-facing use cases, not as facts about this product.",
    "DEMO WORKFLOW – Edit the fields in the Listing card, review local compliance warnings, and export JSON for later ERP integration.",
  ];
  const backend = input.keywords
    .filter((keyword) => keyword.placement !== "title")
    .map((keyword) => keyword.phrase)
    .join(" ");

  return normalizeAmazonListingDraft({
    title,
    bulletPoints: bullets,
    productDescription:
      `This is a demonstration Amazon listing for ${input.mockErp.productName}. ` +
      "It shows the complete workflow from a mock ERP profile and Amazon competitor signals to keyword allocation, copy generation, compliance checks, and editable preview. Replace all placeholder facts before commercial use.",
    searchTerms: backend,
  });
}
