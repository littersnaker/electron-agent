// 模块说明：负责 index 核心服务与领域逻辑。
import { AmazonAutoProvider } from "./amazon-auto";
import type {
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "./types";

/**
 * 兼容旧调用点的 Amazon 单源入口。
 *
 * 旧代码仍可继续调用 `collectAmazonMarketData`，但内部已经升级为自动双链路：
 * - 有 Amazon SP-API 或 TalorData Token 时优先使用 API；
 * - 没有 API，或 API 本轮失败/返回空数据时，自动使用 Amazon 公开页面爬虫。
 */
export async function collectAmazonMarketData(
  input: CommerceProviderSearchInput,
): Promise<CommerceProviderSearchResult> {
  const token =
    input.serviceCredentials?.talorDataToken ||
    input.serviceCredentials?.serpApi ||
    input.serpApiKey;
  return new AmazonAutoProvider(token).searchProducts(input);
}
