/**
 * Amazon Listing Demo 编排器。
 *
 * 流程：类目解析 → Amazon 数据采集 → 模拟 ERP → 关键词 → 文案 → 本地校验。
 * 不包含 Seller Central 写入、Feed 上传或真实 ERP 请求。
 */
import type { LlmCredentials, LlmTokenUsage } from "../../llm/types";
import type { AuxiliaryServiceCredentials } from "../../service-credentials";
import { resolveCommerceCategory } from "../llm";
import { getCommerceMarketplace } from "../marketplaces";
import { AmazonAutoProvider, getAmazonRouteFromProvider } from "../providers/amazon-auto";
import { DemoMarketProvider } from "../providers/demo-market";
import type {
  CommerceCategoryResolution,
  CommerceProductSignal,
  CommerceProgressEvent,
} from "../types";
import { validateAmazonListing } from "./compliance";
import { buildFallbackListingDraft } from "./fallback";
import { extractAmazonListingKeywords } from "./keywords";
import { generateAmazonListingWithLlm } from "./listing-llm";
import { createMockErpProduct } from "./mock-erp";
import type {
  AmazonListingDemoReport,
  AmazonListingDemoRequest,
  AmazonListingSourceSummary,
} from "./types";

interface ListingOrchestrationResult {
  report: AmazonListingDemoReport;
  usage: LlmTokenUsage;
}

function addUsage(total: LlmTokenUsage, current: LlmTokenUsage): void {
  total.prompt += current.prompt;
  total.completion += current.completion;
  total.total += current.total;
}

function fallbackCategory(query: string): CommerceCategoryResolution {
  const compact = query.replace(/\s+/gu, " ").trim();
  const productName = compact.slice(0, 56) || "Amazon Product";
  return {
    categoryName: productName,
    categoryNameEn: /^[\x00-\x7F]+$/u.test(productName) ? productName : "Amazon Product",
    keywords: [productName],
    subcategories: [],
    analysisDimensions: ["title", "bullet points", "keywords", "compliance"],
    researchGoal: "Generate an editable Amazon Listing Demo from the current product brief.",
  };
}

async function collectAmazonCompetitors(input: {
  request: AmazonListingDemoRequest;
  category: CommerceCategoryResolution;
  serviceCredentials: AuxiliaryServiceCredentials;
  signal?: AbortSignal;
}): Promise<{
  products: CommerceProductSignal[];
  source: AmazonListingSourceSummary;
}> {
  const talorDataToken =
    input.serviceCredentials.talorDataToken || input.serviceCredentials.serpApi;
  const provider = new AmazonAutoProvider(talorDataToken);

  try {
    const result = await provider.searchProducts({
      marketplace: input.request.marketplace,
      category: input.category,
      sampleSize: input.request.sampleSize || 16,
      serviceCredentials: input.serviceCredentials,
      signal: input.signal,
    });
    return {
      products: result.products.slice(0, 16),
      source: {
        provider: result.provider,
        dataRoute: getAmazonRouteFromProvider(result.provider),
        sampleSize: result.products.length,
        isDemo: false,
        description:
          getAmazonRouteFromProvider(result.provider) === "crawler"
            ? "本轮使用 Amazon 公开页面爬虫样本生成关键词和表达参考。"
            : "本轮使用已配置的 Amazon 数据接口样本生成关键词和表达参考。",
        warnings: result.warnings,
      },
    };
  } catch (error) {
    const demo = await new DemoMarketProvider().searchProducts({
      marketplace: input.request.marketplace,
      category: input.category,
      sampleSize: Math.max(8, input.request.sampleSize || 12),
      serviceCredentials: input.serviceCredentials,
      signal: input.signal,
    });
    return {
      products: demo.products.map((product) => ({
        ...product,
        platform: "amazon" as const,
      })),
      source: {
        provider: "demo-market",
        sampleSize: demo.products.length,
        isDemo: true,
        description:
          "Amazon API 与公开页面爬虫未返回可用样本，已使用明确标记的模拟竞品数据演示 Listing 流程。",
        warnings: [
          error instanceof Error ? error.message : String(error),
          ...demo.warnings,
        ],
      },
    };
  }
}

export async function buildAmazonListingDemo(input: {
  request: AmazonListingDemoRequest;
  credentials: LlmCredentials;
  serviceCredentials: AuxiliaryServiceCredentials;
  preferredModelId?: string;
  signal?: AbortSignal;
  onProgress?: (
    stage: CommerceProgressEvent["stage"],
    progress: number,
    detail: string,
  ) => void;
}): Promise<ListingOrchestrationResult> {
  const usage: LlmTokenUsage = { prompt: 0, completion: 0, total: 0 };
  const warnings: string[] = [];
  input.onProgress?.("category", 18, "正在识别商品类目和目标站点语言…");

  let category: CommerceCategoryResolution;
  try {
    const result = await resolveCommerceCategory({
      query: input.request.query,
      marketplace: input.request.marketplace,
      recentContext: input.request.messages,
      credentials: input.credentials,
      preferredModelId: input.preferredModelId,
      signal: input.signal,
    });
    category = result.value;
    addUsage(usage, result.usage);
  } catch (error) {
    category = fallbackCategory(input.request.query);
    warnings.push(
      `类目 LLM 解析失败，已使用本地降级类目：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  input.onProgress?.("collect", 34, "正在采集 Amazon 竞品标题、Bullet、价格和评价信号…");
  const competitorResult = await collectAmazonCompetitors({
    request: input.request,
    category,
    serviceCredentials: input.serviceCredentials,
    signal: input.signal,
  });

  input.onProgress?.("erp", 50, "正在构建模拟 ERP 商品档案并标记待确认字段…");
  let mockErp = createMockErpProduct({
    query: input.request.query,
    category,
    marketplace: input.request.marketplace,
  });

  input.onProgress?.("keywords", 64, "正在从商品需求和 Amazon 竞品中提取并分配关键词…");
  const keywords = extractAmazonListingKeywords({
    query: input.request.query,
    category,
    products: competitorResult.products,
  });

  input.onProgress?.("draft", 78, "正在生成标题、五点描述、产品描述和后台搜索词…");
  let draft = buildFallbackListingDraft({ category, mockErp, keywords });
  try {
    const marketplace = getCommerceMarketplace(input.request.marketplace);
    const generated = await generateAmazonListingWithLlm({
      query: input.request.query,
      category,
      mockErp,
      keywords,
      competitors: competitorResult.products,
      locale: marketplace.locale,
      credentials: input.credentials,
      preferredModelId: input.preferredModelId,
      signal: input.signal,
    });
    draft = generated.draft;
    mockErp = {
      ...mockErp,
      facts: [...mockErp.facts, ...generated.suggestedFacts],
    };
    addUsage(usage, generated.usage);
  } catch (error) {
    warnings.push(
      `Listing LLM 生成失败，已使用确定性 Demo 文案：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  input.onProgress?.("validate", 90, "正在执行标题、Bullet、Search Terms 和事实安全检查…");
  const validation = validateAmazonListing({
    draft,
    keywords,
    mockErp,
    competitorBrands: competitorResult.products
      .map((product) => product.brand || "")
      .filter(Boolean),
  });
  const marketplace = getCommerceMarketplace(input.request.marketplace);
  const report: AmazonListingDemoReport = {
    version: 1,
    mode: "listing-demo",
    generatedAt: new Date().toISOString(),
    query: input.request.query,
    marketplace: input.request.marketplace,
    marketplaceLabel: marketplace.label,
    locale: marketplace.locale,
    category,
    mockErp,
    keywords,
    draft,
    validation,
    competitors: competitorResult.products,
    source: competitorResult.source,
    warnings: Array.from(
      new Set([
        "当前为 Listing Demo：模拟 ERP 未连接真实商品主数据，禁止直接发布。",
        ...warnings,
        ...competitorResult.source.warnings,
      ]),
    ),
  };
  return { report, usage };
}
