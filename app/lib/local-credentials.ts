// 模块说明：在 Renderer 中转换 LLM/数据源凭证，并兼容旧 localStorage。
import {
  LLM_PROVIDER_CATALOG,
  LLM_PROVIDER_IDS,
} from "./llm/registry/providers";
import type { LlmCredentials, LlmEndpointOverrides } from "./llm/types";
import {
  COMMERCE_STORAGE_KEYS,
  type AuxiliaryServiceCredentials,
} from "./service-credentials";

export type PersistedCredentialStore = Record<string, string>;

export interface CredentialSnapshot {
  llm: LlmCredentials;
  endpoints: LlmEndpointOverrides;
  services: AuxiliaryServiceCredentials;
}

/** 从当前网页 Origin 的旧 localStorage 读取凭证，供升级时迁移。 */
export function readLegacyLocalCredentialStore(): PersistedCredentialStore {
  if (typeof window === "undefined") return {};
  const result: PersistedCredentialStore = {};
  const keys = [
    ...LLM_PROVIDER_CATALOG.flatMap((provider) => [
      provider.environmentKey,
      provider.endpointEnvironmentKey,
    ]).filter((key): key is string => Boolean(key)),
    ...Object.values(COMMERCE_STORAGE_KEYS),
  ];
  for (const key of keys) {
    const value = window.localStorage.getItem(key)?.trim();
    if (value) result[key] = value;
  }
  return result;
}

/** 把平面持久化记录转换成业务 Hook 使用的三个强类型对象。 */
export function credentialStoreToSnapshot(
  store: PersistedCredentialStore,
): CredentialSnapshot {
  const llm: LlmCredentials = {};
  const endpoints: LlmEndpointOverrides = {};
  for (const provider of LLM_PROVIDER_CATALOG) {
    const value = store[provider.environmentKey]?.trim();
    if (value) llm[provider.id] = value;
    const endpointKey = provider.endpointEnvironmentKey;
    const endpoint = endpointKey ? store[endpointKey]?.trim() : "";
    if (endpoint) endpoints[provider.id] = endpoint;
  }

  // v5-v7 曾把 TalorData Token 写入 SERPAPI_API_KEY，升级时继续兼容读取。
  const services: AuxiliaryServiceCredentials = {
    talorDataToken:
      store[COMMERCE_STORAGE_KEYS.talorDataToken] ||
      store[COMMERCE_STORAGE_KEYS.legacySerpApi],
    keepaApiKey: store[COMMERCE_STORAGE_KEYS.keepaApiKey],
    tiktokClientKey: store[COMMERCE_STORAGE_KEYS.tiktokClientKey],
    tiktokClientSecret: store[COMMERCE_STORAGE_KEYS.tiktokClientSecret],
    tiktokMerchantId: store[COMMERCE_STORAGE_KEYS.tiktokMerchantId],
    temuAppKey: store[COMMERCE_STORAGE_KEYS.temuAppKey],
    temuAppSecret: store[COMMERCE_STORAGE_KEYS.temuAppSecret],
    temuAccessToken: store[COMMERCE_STORAGE_KEYS.temuAccessToken],
    alibaba1688AppKey: store[COMMERCE_STORAGE_KEYS.alibaba1688AppKey],
    alibaba1688AppSecret: store[COMMERCE_STORAGE_KEYS.alibaba1688AppSecret],
    alibaba1688AccessToken:
      store[COMMERCE_STORAGE_KEYS.alibaba1688AccessToken],
  };
  return { llm, endpoints, services };
}

/** 把业务凭证转换为主进程白名单接受的平面记录。 */
export function snapshotToCredentialStore(
  llm: LlmCredentials,
  endpoints: LlmEndpointOverrides,
  services: AuxiliaryServiceCredentials,
): PersistedCredentialStore {
  const result: PersistedCredentialStore = {};
  for (const providerId of LLM_PROVIDER_IDS) {
    const provider = LLM_PROVIDER_CATALOG.find(
      (item) => item.id === providerId,
    );
    const value = llm[providerId]?.trim();
    if (provider && value) result[provider.environmentKey] = value;
    const endpoint = endpoints[providerId]?.trim();
    if (provider?.endpointEnvironmentKey && endpoint) {
      result[provider.endpointEnvironmentKey] = endpoint;
    }
  }

  const entries: Array<[string, string | undefined]> = [
    [COMMERCE_STORAGE_KEYS.talorDataToken, services.talorDataToken],
    [COMMERCE_STORAGE_KEYS.keepaApiKey, services.keepaApiKey],
    [COMMERCE_STORAGE_KEYS.tiktokClientKey, services.tiktokClientKey],
    [COMMERCE_STORAGE_KEYS.tiktokClientSecret, services.tiktokClientSecret],
    [COMMERCE_STORAGE_KEYS.tiktokMerchantId, services.tiktokMerchantId],
    [COMMERCE_STORAGE_KEYS.temuAppKey, services.temuAppKey],
    [COMMERCE_STORAGE_KEYS.temuAppSecret, services.temuAppSecret],
    [COMMERCE_STORAGE_KEYS.temuAccessToken, services.temuAccessToken],
    [COMMERCE_STORAGE_KEYS.alibaba1688AppKey, services.alibaba1688AppKey],
    [COMMERCE_STORAGE_KEYS.alibaba1688AppSecret, services.alibaba1688AppSecret],
    [COMMERCE_STORAGE_KEYS.alibaba1688AccessToken, services.alibaba1688AccessToken],
  ];
  for (const [key, rawValue] of entries) {
    const value = rawValue?.trim();
    if (value) result[key] = value;
  }
  return result;
}

/**
 * 保留 localStorage 作为纯浏览器开发模式后备，同时删除用户已清空的字段。
 * Electron 运行时的主存储是主进程凭证文件，不再依赖页面 Origin。
 */
export function writeLegacyLocalCredentialStore(
  store: PersistedCredentialStore,
): void {
  if (typeof window === "undefined") return;
  const allowedKeys = [
    ...LLM_PROVIDER_CATALOG.flatMap((provider) => [
      provider.environmentKey,
      provider.endpointEnvironmentKey,
    ]).filter((key): key is string => Boolean(key)),
    ...Object.values(COMMERCE_STORAGE_KEYS),
  ];
  for (const key of allowedKeys) {
    const value = store[key]?.trim();
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  }
  // 新版只写准确的 TalorData 字段，旧别名读取完成后即删除。
  window.localStorage.removeItem(COMMERCE_STORAGE_KEYS.legacySerpApi);
}
