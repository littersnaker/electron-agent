import { getCommerceMarketplace } from "../marketplaces";
import type {
  CommerceMarketObservation,
  CommerceProductSignal,
} from "../types";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "./types";

/**
 * 使用纯 JavaScript 生成稳定的无符号 32 位种子。
 *
 * 演示 Provider 不需要密码学哈希；使用轻量稳定哈希既能让同一查询每次生成相同样本，
 * 也能避免为了演示数据额外引入 Node.js `crypto` 依赖，方便在服务端测试和静态校验。
 */
function createDeterministicSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 无真实数据演示 Provider。
 *
 * 该 Provider 只在所有真实数据源均未取得结果时由 Orchestrator 主动调用，绝不会与真实
 * 数据混合后冒充市场事实。所有 observation / product 均带 `isDemo: true`，报告层还会
 * 设置 runMode=demo，并在 UI、文本和 PDF 中显示醒目的“模拟数据”声明。
 */
export class DemoMarketProvider implements CommerceDataProvider {
  readonly kind = "demo-market" as const;

  isConfigured(): boolean {
    return true;
  }

  searchProducts(
    input: CommerceProviderSearchInput,
  ): Promise<CommerceProviderSearchResult> {
    const market = getCommerceMarketplace(input.marketplace);
    const seedNumber = createDeterministicSeed(
      `${input.marketplace}:${input.category.categoryNameEn}`,
    );
    const seed = seedNumber.toString(16).padStart(8, "0");
    const basePrice = market.currency === "JPY" ? 3200 : 24;
    const priceStep = market.currency === "JPY" ? 700 : 6;
    const observationCount = Math.min(12, Math.max(8, input.sampleSize));

    const observations: CommerceMarketObservation[] = Array.from(
      { length: observationCount },
      (_, index) => {
        const resultTypes: CommerceMarketObservation["resultType"][] = [
          "organic",
          "shopping",
          "organic",
          "related",
          "shopping",
          "ad",
        ];
        const resultType = resultTypes[index % resultTypes.length];
        const hasPrice = resultType === "shopping" || index % 4 === 0;
        return {
          id: `DEMO-OBS-${seed.slice(0, 6)}-${index + 1}`,
          title: `【演示】${input.category.categoryName} 示例市场结果 ${index + 1}`,
          snippet:
            "这是用于验证 Commerce Agent 完整流程的模拟结果，不代表任何真实品牌、销量或市场表现。",
          resultType,
          position: index + 1,
          price: hasPrice
            ? basePrice + ((seedNumber + index * 7) % 8) * priceStep
            : undefined,
          currency: hasPrice ? market.currency : undefined,
          rating: resultType === "shopping" ? 4 + (index % 8) / 10 : undefined,
          reviewCount:
            resultType === "shopping"
              ? 30 + ((seedNumber + index * 19) % 420)
              : undefined,
          merchant: `示例来源 ${String.fromCharCode(65 + (index % 6))}`,
          provider: this.kind,
          isDemo: true,
        };
      },
    );

    const products: CommerceProductSignal[] = observations
      .filter((item) => item.resultType === "shopping")
      .slice(0, 4)
      .map((item, index) => ({
        asin: `DEMO-${seed.slice(0, 8).toUpperCase()}-${index + 1}`,
        title: item.title,
        platform: "market-search",
        brand: item.merchant,
        price: item.price,
        currency: item.currency,
        rating: item.rating,
        reviewCount: item.reviewCount,
        source: this.kind,
        isDemo: true,
      }));

    return Promise.resolve({
      provider: this.kind,
      sourceId: "market-search",
      products,
      observations,
      coverage: ["模拟 Web 结果", "模拟 Shopping 结果", "演示价格字段"],
      warnings: [
        "当前为无真实数据演示模式：所有样本均为模拟数据，仅用于验证交互、报告和 PDF 流程。",
      ],
    });
  }
}
