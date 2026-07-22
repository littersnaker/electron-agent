import {
  LLM_PROVIDER_CATALOG,
  LLM_PROVIDER_IDS,
} from "./registry/providers";
import type {
  LlmCredentials,
  LlmProviderId,
} from "./types";

function readSecret(
  headers: Headers,
  provider: LlmProviderId,
): string | undefined {
  const definition = LLM_PROVIDER_CATALOG.find(
    (item) => item.id === provider,
  );
  if (!definition) return undefined;

  const fromHeader = headers.get(definition.requestHeader)?.trim();
  const fromEnvironment =
    process.env[definition.environmentKey]?.trim();
  return fromHeader || fromEnvironment || undefined;
}

/** 服务端只读取请求头和环境变量，不把真实 Key 回传给浏览器。 */
export function resolveLlmCredentials(headers: Headers): LlmCredentials {
  const credentials: LlmCredentials = {};

  for (const provider of LLM_PROVIDER_IDS) {
    const value = readSecret(headers, provider);
    if (value) credentials[provider] = value;
  }

  // 保留旧版本千问请求头兼容。
  if (!credentials.qwen) {
    credentials.qwen =
      headers.get("x-dashscope-api-key")?.trim() || undefined;
  }

  return credentials;
}

export function hasProviderCredential(
  provider: LlmProviderId,
): boolean {
  const definition = LLM_PROVIDER_CATALOG.find(
    (item) => item.id === provider,
  );
  return Boolean(
    definition &&
      process.env[definition.environmentKey]?.trim(),
  );
}
