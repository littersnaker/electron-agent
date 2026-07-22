import type { LlmProvider, LlmProviderId } from "./types";
import { GeminiProvider } from "./providers/gemini";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible";

const DEFAULT_QWEN_ENDPOINT =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const DEFAULT_OPENAI_ENDPOINT =
  "https://api.openai.com/v1/chat/completions";

/** Provider 工厂是业务层唯一感知厂商的位置。 */
export function createLlmProvider(provider: LlmProviderId): LlmProvider {
  if (provider === "gemini") return new GeminiProvider();

  if (provider === "openai") {
    return new OpenAiCompatibleProvider({
      id: "openai",
      endpoint:
        process.env.OPENAI_CHAT_COMPLETIONS_URL || DEFAULT_OPENAI_ENDPOINT,
    });
  }

  return new OpenAiCompatibleProvider({
    id: "qwen",
    endpoint:
      process.env.DASHSCOPE_CHAT_COMPLETIONS_URL || DEFAULT_QWEN_ENDPOINT,
  });
}
