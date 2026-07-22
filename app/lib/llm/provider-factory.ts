import { getProviderDefinition } from "./registry/providers";
import { GeminiProvider } from "./providers/gemini";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible";
import type { LlmProvider, LlmProviderId } from "./types";

const ENDPOINT_ENV_KEYS: Partial<Record<LlmProviderId, string>> = {
  qwen: "DASHSCOPE_CHAT_COMPLETIONS_URL",
  openai: "OPENAI_CHAT_COMPLETIONS_URL",
  deepseek: "DEEPSEEK_CHAT_COMPLETIONS_URL",
  glm: "GLM_CHAT_COMPLETIONS_URL",
  kimi: "KIMI_CHAT_COMPLETIONS_URL",
};

/** Provider 工厂是协议实现感知厂商的唯一入口。 */
export function createLlmProvider(
  providerId: LlmProviderId,
): LlmProvider {
  const definition = getProviderDefinition(providerId);

  if (providerId === "gemini") {
    return new GeminiProvider();
  }

  const environmentKey = ENDPOINT_ENV_KEYS[providerId];
  const endpoint =
    (environmentKey ? process.env[environmentKey]?.trim() : undefined) ||
    definition.defaultEndpoint;

  if (!endpoint) {
    throw new Error(`${definition.name} 没有配置 API Endpoint`);
  }

  return new OpenAiCompatibleProvider({
    id: providerId,
    endpoint,
  });
}
