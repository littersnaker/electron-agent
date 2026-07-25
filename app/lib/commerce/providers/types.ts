import type { AuxiliaryServiceCredentials } from "../../service-credentials";
import type {
  CommerceCategoryResolution,
  CommerceCrawlerEngine,
  CommerceDataProviderKind,
  CommerceMarketplaceCode,
  CommerceMarketObservation,
  CommerceMarketSourceId,
  CommerceProductSignal,
} from "../types";

export interface CommerceProviderSearchInput {
  marketplace: CommerceMarketplaceCode;
  category: CommerceCategoryResolution;
  sampleSize: number;
  /**
   * Request-scoped local credentials from the settings UI. Every provider still has its own
   * server-side environment fallback, so packaged defaults work without user configuration.
   */
  serviceCredentials?: AuxiliaryServiceCredentials;
  /** v5-v7 compatibility alias for TalorData. */
  serpApiKey?: string;
  signal?: AbortSignal;
}

export interface CommerceProviderSearchResult {
  provider: CommerceDataProviderKind;
  sourceId?: CommerceMarketSourceId;
  products: CommerceProductSignal[];
  /** 仅爬虫 Provider 返回，供 UI 明确展示 HTTP 或浏览器链路。 */
  crawlerEngine?: CommerceCrawlerEngine;
  /** 通用公开市场结果；不要求平台商品 ID。 */
  observations?: CommerceMarketObservation[];
  warnings: string[];
  coverage?: string[];
}

export interface CommerceDataProvider {
  readonly kind: CommerceDataProviderKind;
  isConfigured(): boolean;
  searchProducts(
    input: CommerceProviderSearchInput,
  ): Promise<CommerceProviderSearchResult>;
}
