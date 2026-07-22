import type { LlmCredentials, LlmProviderId } from "./types";

const ENV_KEYS: Record<LlmProviderId, string> = {
  qwen: "DASHSCOPE_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const HEADER_KEYS: Record<LlmProviderId, string> = {
  qwen: "x-llm-key-qwen",
  openai: "x-llm-key-openai",
  gemini: "x-llm-key-gemini",
};

function readSecret(
  headers: Headers,
  provider: LlmProviderId,
): string | undefined {
  const fromHeader = headers.get(HEADER_KEYS[provider])?.trim();
  const fromEnvironment = process.env[ENV_KEYS[provider]]?.trim();
  return fromHeader || fromEnvironment || undefined;
}

/** 服务端只读取请求头和环境变量，不把默认 Key 回传给浏览器。 */
export function resolveLlmCredentials(headers: Headers): LlmCredentials {
  return {
    qwen:
      readSecret(headers, "qwen") ||
      headers.get("x-dashscope-api-key")?.trim() ||
      undefined,
    openai: readSecret(headers, "openai"),
    gemini: readSecret(headers, "gemini"),
  };
}

export function hasProviderCredential(provider: LlmProviderId): boolean {
  return Boolean(process.env[ENV_KEYS[provider]]?.trim());
}
