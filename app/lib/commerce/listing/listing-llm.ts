/** 使用统一 LLM Gateway 生成 Listing Demo 文案和可审阅的推断事实。 */
import { z } from "zod";
import { completeWithLlm } from "../../llm/gateway";
import type { LlmCredentials, LlmTokenUsage } from "../../llm/types";
import type { CommerceCategoryResolution, CommerceProductSignal } from "../types";
import type {
  AmazonListingDraft,
  AmazonListingFact,
  AmazonListingKeyword,
  AmazonMockErpProduct,
} from "./types";
import { normalizeAmazonListingDraft } from "./normalization";

const listingSchema = z.object({
  suggestedFacts: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        value: z.string().min(1).max(160),
      }),
    )
    .max(8)
    .default([]),
  title: z.string().min(1),
  bulletPoints: z.array(z.string().min(1)).min(3).max(5),
  productDescription: z.string().min(1),
  searchTerms: z.string().min(1),
});

function extractJsonObject(value: string): unknown {
  const cleaned = value
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Listing LLM 未返回 JSON 对象");
  return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
}

function compactCompetitor(product: CommerceProductSignal): Record<string, unknown> {
  return {
    title: product.title,
    brand: product.brand,
    price: product.price,
    currency: product.currency,
    rating: product.rating,
    reviewCount: product.reviewCount,
    bulletPoints: product.bulletPoints?.slice(0, 5),
  };
}

export async function generateAmazonListingWithLlm(input: {
  query: string;
  category: CommerceCategoryResolution;
  mockErp: AmazonMockErpProduct;
  keywords: AmazonListingKeyword[];
  competitors: CommerceProductSignal[];
  locale: string;
  credentials: LlmCredentials;
  preferredModelId?: string;
  signal?: AbortSignal;
}): Promise<{
  draft: AmazonListingDraft;
  suggestedFacts: AmazonListingFact[];
  usage: LlmTokenUsage;
}> {
  const response = await completeWithLlm({
    task: "commerce_analysis",
    preferredModelId: input.preferredModelId,
    credentials: input.credentials,
    signal: input.signal,
    requiredCapabilities: ["reasoning", "structured_output"],
    messages: [
      {
        role: "system",
        content: [
          "You are an Amazon Listing Demo copywriter.",
          `Write in the marketplace locale ${input.locale}.`,
          "Return JSON only with suggestedFacts, title, bulletPoints, productDescription, searchTerms.",
          "This is a demo using a mock ERP profile. Never claim the draft is ready to publish.",
          "Use Amazon competitor samples only for language patterns and keyword discovery.",
          "Never copy competitor brands, model numbers, certifications, dimensions, materials, package quantities, warranties, medical claims, performance numbers, or compatibility claims.",
          "Any useful feature not explicitly present in the mock ERP must be listed in suggestedFacts so the UI can mark it as unconfirmed.",
          "Title must be at most 75 characters. Produce 5 concise bullets. Do not use promotional claims, prices, URLs, contact details, emojis, refund promises, or unsupported superlatives.",
          "Search terms must be a space-separated phrase list without competitor brands or punctuation stuffing.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            userBrief: input.query,
            category: input.category,
            mockErp: input.mockErp,
            keywordPlan: input.keywords,
            amazonCompetitorReferences: input.competitors.slice(0, 10).map(compactCompetitor),
          },
          null,
          2,
        ),
      },
    ],
  });

  const parsed = listingSchema.parse(
    extractJsonObject(response.choices[0]?.message.content || ""),
  );
  const suggestedFacts = parsed.suggestedFacts.map(
    (item: { label: string; value: string }, index: number) => ({
      id: `suggested-${index + 1}`,
      label: item.label,
      value: item.value,
      source: "amazon-competitor-inference" as const,
      confidence: 0.35,
      requiresConfirmation: true,
    }),
  );

  return {
    draft: normalizeAmazonListingDraft({
      title: parsed.title,
      bulletPoints: parsed.bulletPoints,
      productDescription: parsed.productDescription,
      searchTerms: parsed.searchTerms,
    }),
    suggestedFacts,
    usage: {
      prompt: response.usage?.prompt_tokens || 0,
      completion: response.usage?.completion_tokens || 0,
      total: response.usage?.total_tokens || 0,
    },
  };
}
