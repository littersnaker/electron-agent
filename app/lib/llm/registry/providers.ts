import type {
  LlmProviderDefinition,
  LlmProviderId,
} from "../types";

/**
 * Provider 公共注册表。
 *
 * 新增供应商时，在此登记协议、默认地址、环境变量和请求头即可。
 * API Key 本身不会出现在注册表中。
 */
export const LLM_PROVIDER_CATALOG: readonly LlmProviderDefinition[] = [
  {
    id: "qwen",
    name: "Qwen / DashScope",
    environmentKey: "DASHSCOPE_API_KEY",
    requestHeader: "x-llm-key-qwen",
    protocol: "openai-compatible",
    defaultEndpoint:
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    placeholder: "sk-...",
  },
  {
    id: "openai",
    name: "OpenAI",
    environmentKey: "OPENAI_API_KEY",
    requestHeader: "x-llm-key-openai",
    protocol: "openai-compatible",
    defaultEndpoint: "https://api.openai.com/v1/chat/completions",
    placeholder: "sk-...",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    environmentKey: "GEMINI_API_KEY",
    requestHeader: "x-llm-key-gemini",
    protocol: "gemini",
    placeholder: "AIza...",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    environmentKey: "DEEPSEEK_API_KEY",
    requestHeader: "x-llm-key-deepseek",
    protocol: "openai-compatible",
    defaultEndpoint: "https://api.deepseek.com/chat/completions",
    placeholder: "sk-...",
  },
  {
    id: "glm",
    name: "GLM / BigModel",
    environmentKey: "GLM_API_KEY",
    requestHeader: "x-llm-key-glm",
    protocol: "openai-compatible",
    defaultEndpoint:
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    placeholder: "API Key",
  },
  {
    id: "kimi",
    name: "Kimi / Moonshot",
    environmentKey: "KIMI_API_KEY",
    requestHeader: "x-llm-key-kimi",
    protocol: "openai-compatible",
    defaultEndpoint: "https://api.moonshot.cn/v1/chat/completions",
    placeholder: "sk-...",
  },
];

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
