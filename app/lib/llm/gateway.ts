import {
  normalizeLlmMessages,
  normalizeLlmTools,
} from "./normalizers";
import { createLlmProvider } from "./provider-factory";
import { getRequestLlmCredentials } from "./request-context";
import {
  inferMessageCapabilities,
  mergeCapabilities,
} from "./router/capabilities";
import { resolveModelRoutes } from "./router/model-router";
import {
  LlmProviderError,
  type LlmChatResponse,
  type LlmGatewayRequest,
  type LlmModelRoute,
  type LlmStreamChunk,
} from "./types";

function shouldTryFallback(error: unknown): boolean {
  if (error instanceof LlmProviderError) return error.retryable;
  return error instanceof TypeError;
}

function buildFallbackError(
  routes: readonly LlmModelRoute[],
  errors: readonly string[],
): Error {
  const attempted = routes
    .map((route) => `${route.provider}/${route.model}`)
    .join(" → ");
  return new Error(
    `所有可用模型均调用失败。尝试顺序：${attempted}。详情：${errors.join(
      " | ",
    )}`,
  );
}

/** 非流式统一入口，自动模式支持多模型故障降级。 */
export async function completeWithLlm(
  request: LlmGatewayRequest,
): Promise<LlmChatResponse> {
  const messages = normalizeLlmMessages(request.messages);
  const tools = normalizeLlmTools(request.tools);
  const routing = resolveModelRoutes({
    task: request.task,
    preferredModelId: request.preferredModelId,
    credentials: request.credentials || getRequestLlmCredentials(),
    requiredCapabilities: mergeCapabilities(
      request.requiredCapabilities,
      inferMessageCapabilities(messages),
      tools?.length ? ["tool_call"] : undefined,
    ),
  });

  const errors: string[] = [];
  for (const route of routing.routes) {
    try {
      const provider = createLlmProvider(route.provider);
      return await provider.complete({
        route,
        messages,
        tools,
        toolChoice: request.toolChoice,
        signal: request.signal,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      errors.push(message);
      if (!shouldTryFallback(error) || routing.routes.length === 1) {
        throw error;
      }
    }
  }

  throw buildFallbackError(routing.routes, errors);
}

/**
 * 流式统一入口。
 *
 * 只有在尚未输出任何正文时才允许切换到下一个模型，避免用户看到两段重复
 * 或不同模型拼接的内容。
 */
export async function* streamWithLlm(
  request: LlmGatewayRequest,
): AsyncIterable<LlmStreamChunk> {
  const messages = normalizeLlmMessages(request.messages);
  const tools = normalizeLlmTools(request.tools);
  const routing = resolveModelRoutes({
    task: request.task,
    preferredModelId: request.preferredModelId,
    credentials: request.credentials || getRequestLlmCredentials(),
    requiredCapabilities: mergeCapabilities(
      request.requiredCapabilities,
      inferMessageCapabilities(messages),
      tools?.length ? ["tool_call"] : undefined,
    ),
  });

  const errors: string[] = [];
  for (const route of routing.routes) {
    let emittedContent = false;
    try {
      const provider = createLlmProvider(route.provider);
      for await (const chunk of provider.stream({
        route,
        messages,
        tools,
        toolChoice: request.toolChoice,
        signal: request.signal,
      })) {
        if (chunk.textDelta || chunk.reasoningDelta) emittedContent = true;
        yield {
          ...chunk,
          route,
        };
      }
      return;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      errors.push(message);
      if (
        emittedContent ||
        !shouldTryFallback(error) ||
        routing.routes.length === 1
      ) {
        throw error;
      }
    }
  }

  throw buildFallbackError(routing.routes, errors);
}
