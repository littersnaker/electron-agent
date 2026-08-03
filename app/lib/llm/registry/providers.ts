// 模块说明：前端 LLM 供应商注册表直接读取 config/providers.json。
import type {
  LlmProviderDefinition,
  LlmProviderId,
} from "../types";
import providerConfig from "../../../../config/providers.json";

/**
 * Provider 公共注册表（唯一源文件：config/providers.json）。
 *
 * 新增供应商时只改 JSON，前后端后端 catalog.py 同步读取同一文件。
 * API Key 本身不会出现在注册表中。
 */
export const LLM_PROVIDER_CATALOG: readonly LlmProviderDefinition[] =
  providerConfig.providers.map((entry) => ({
    id: entry.id as LlmProviderId,
    name: entry.name,
    environmentKey: entry.environmentKeys[0] ?? "",
    requestHeader: entry.requestHeader,
    endpointRequestHeader: entry.endpointRequestHeader,
    endpointEnvironmentKey: entry.endpointEnvironmentKey,
    protocol: (entry.protocol ?? "openai-compatible") as LlmProviderDefinition["protocol"],
    defaultEndpoint: entry.defaultEndpoint,
    placeholder: entry.placeholder ?? "",
  }));

export const LLM_PROVIDER_IDS = LLM_PROVIDER_CATALOG.map(
  (provider) => provider.id,
) as readonly LlmProviderId[];

export function getProviderDefinition(
  providerId: LlmProviderId,
): LlmProviderDefinition {
  const provider = LLM_PROVIDER_CATALOG.find(
    (item) => item.id === providerId,
  );
  if (!provider) {
    throw new Error(`未注册的模型供应商: ${providerId}`);
  }
  return provider;
}
