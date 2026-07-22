import { normalizeLlmMessages, normalizeLlmTools } from "./normalizers";
import { createLlmProvider } from "./provider-factory";
import { resolveModelRoute } from "./model-router";
import { getRequestLlmCredentials } from "./request-context";
import type {
  LlmChatResponse,
  LlmGatewayRequest,
  LlmStreamChunk,
} from "./types";

/**
 * 非流式统一入口。Agent、Planner、Reviewer 不再直接调用任何厂商 URL。
 */
export async function completeWithLlm(
  request: LlmGatewayRequest,
): Promise<LlmChatResponse> {
  const route = resolveModelRoute({
    task: request.task,
    preferredModelId: request.preferredModelId,
    credentials: request.credentials || getRequestLlmCredentials(),
  });
  const provider = createLlmProvider(route.provider);
  return provider.complete({
    route,
    messages: normalizeLlmMessages(request.messages),
    tools: normalizeLlmTools(request.tools),
    toolChoice: request.toolChoice,
    signal: request.signal,
  });
}

/** 流式统一入口，供普通聊天和最终回答复用。 */
export async function* streamWithLlm(
  request: LlmGatewayRequest,
): AsyncIterable<LlmStreamChunk> {
  const route = resolveModelRoute({
    task: request.task,
    preferredModelId: request.preferredModelId,
    credentials: request.credentials || getRequestLlmCredentials(),
  });
  const provider = createLlmProvider(route.provider);
  yield* provider.stream({
    route,
    messages: normalizeLlmMessages(request.messages),
    tools: normalizeLlmTools(request.tools),
    toolChoice: request.toolChoice,
    signal: request.signal,
  });
}
