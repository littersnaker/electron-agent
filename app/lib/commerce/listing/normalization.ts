/** Listing 文案归一化工具，确保 Demo 输出在本地规则范围内。 */
import type { AmazonListingDraft } from "./types";
import { AMAZON_LISTING_DEMO_RULES } from "./rules";

function compactWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateAtWord(value: string, maximum: number): string {
  const compact = compactWhitespace(value);
  if (compact.length <= maximum) return compact;
  const candidate = compact.slice(0, maximum + 1);
  const boundary = candidate.lastIndexOf(" ");
  return (boundary >= maximum * 0.65 ? candidate.slice(0, boundary) : candidate.slice(0, maximum))
    .replace(/[,:;\-–—]+$/u, "")
    .trim();
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const compact = compactWhitespace(value);
  const encoder = new TextEncoder();
  if (encoder.encode(compact).length <= maximumBytes) return compact;
  let output = "";
  for (const character of compact) {
    if (encoder.encode(output + character).length > maximumBytes) break;
    output += character;
  }
  return output.trim();
}

export function normalizeAmazonListingDraft(draft: AmazonListingDraft): AmazonListingDraft {
  const rules = AMAZON_LISTING_DEMO_RULES;
  const bullets = draft.bulletPoints
    .map((bullet) => truncateAtWord(bullet, rules.bulletMaximumCharacters))
    .filter(Boolean)
    .slice(0, rules.bulletMaximumCount);

  while (bullets.length < rules.bulletMinimumCount) {
    bullets.push(
      "DEMO DATA REQUIRED – Connect the real ERP record to replace this placeholder with a verified product benefit.",
    );
  }

  return {
    title: truncateAtWord(draft.title, rules.titleMaxCharacters),
    bulletPoints: bullets,
    productDescription: truncateAtWord(
      draft.productDescription,
      rules.productDescriptionMaximumCharacters,
    ),
    searchTerms: truncateUtf8(
      draft.searchTerms,
      rules.backendSearchTermMaximumBytes,
    ),
  };
}
