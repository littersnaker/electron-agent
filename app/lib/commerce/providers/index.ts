import { TalorDataMarketProvider } from "./talordata-market";
import type {
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "./types";

/**
 * 兼容旧调用点的 Amazon 单源入口。
 * 新的跨境市场研究主流程已经迁移到 Data Source Orchestrator；新代码应优先调用
 * `collectMultiSourceMarketData`，这里仅保留以避免已有扩展直接断裂。
 */
export async function collectAmazonMarketData(
  input: CommerceProviderSearchInput,
): Promise<CommerceProviderSearchResult> {
  const token =
    input.serviceCredentials?.talorDataToken ||
    input.serviceCredentials?.serpApi ||
    input.serpApiKey;
  return new TalorDataMarketProvider(token).searchProducts(input);
}
