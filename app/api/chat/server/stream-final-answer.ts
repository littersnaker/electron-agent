import {
  AIMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { systemPromptText } from "../prompt";
import { sendSse, sendUsage } from "./sse";
import type { SseController } from "./sse";
import type { AgentStateValues, StreamDeltaResponse } from "./types";

const QWEN_STREAM_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

interface StreamFinalAnswerOptions {
  finalState: AgentStateValues;
  apiKey: string;
  model: string;
  controller: SseController;
  encoder: TextEncoder;
}

function buildModelMessages(finalState: AgentStateValues) {
  const memorySummary = finalState.summary
    ? `\n\n[此前久远的对话背景历史摘要]\n${finalState.summary}`
    : "";
  const systemMessage = {
    role: "system" as const,
    content: `${systemPromptText}${memorySummary}\n\n最终回答必须以 Agent Final Report 为唯一执行事实依据，不得猜测未发生的文件修改或验证结果。`,
  };

  const recentMessages = (finalState.messages || [])
    .filter((message) => message._getType() !== "system")
    .map((message) => {
      const type = message._getType();
      if (type === "human") {
        return { role: "user" as const, content: String(message.content) };
      }
      if (type === "ai") {
        const aiMessage = message as AIMessage;
        return {
          role: "assistant" as const,
          content: String(aiMessage.content),
          tool_calls: aiMessage.tool_calls?.length
            ? aiMessage.tool_calls.map((toolCall) => ({
                id: toolCall.id,
                type: "function" as const,
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.args),
                },
              }))
            : undefined,
        };
      }
      if (type === "tool") {
        const toolMessage = message as ToolMessage;
        return {
          role: "tool" as const,
          content: String(toolMessage.content),
          tool_call_id: toolMessage.tool_call_id,
        };
      }
      return { role: "user" as const, content: String(message.content) };
    });

  return [
    systemMessage,
    ...recentMessages,
    {
      role: "user" as const,
      content: `以下是本轮 LangGraph 生成的 Agent Final Report。请只做自然、准确的最终表达，不要增加未发生的操作：\n\n${
        finalState.finalReportSummary || "本轮没有生成 Final Report。"
      }`,
    },
  ];
}

function emitDelta(
  payload: StreamDeltaResponse,
  state: { thinking: boolean; thinkingClosed: boolean },
  controller: SseController,
  encoder: TextEncoder,
): void {
  const delta = payload.choices?.[0]?.delta;
  const reasoning = delta?.reasoning_content || "";
  const content = delta?.content || "";
  let frontendChunk = "";

  if (reasoning) {
    if (!state.thinking) {
      state.thinking = true;
      frontendChunk += "<INTERNAL_THINK_START>";
    }
    frontendChunk += reasoning;
  }

  if (content) {
    if (state.thinking && !state.thinkingClosed) {
      state.thinkingClosed = true;
      frontendChunk += "<INTERNAL_THINK_END>";
    }
    frontendChunk += content;
  }

  if (frontendChunk) {
    sendSse(controller, encoder, {
      type: "TEXT",
      content: frontendChunk,
    });
  }
}

function emitCombinedUsage(
  payload: StreamDeltaResponse,
  backgroundUsage: { prompt: number; completion: number; total: number },
  controller: SseController,
  encoder: TextEncoder,
): void {
  if (!payload.usage) return;
  sendUsage(controller, encoder, {
    prompt: backgroundUsage.prompt + (payload.usage.prompt_tokens ?? 0),
    completion:
      backgroundUsage.completion + (payload.usage.completion_tokens ?? 0),
    total: backgroundUsage.total + (payload.usage.total_tokens ?? 0),
  });
}

/** 把 Code Agent 的 Final Report 流式整理成面向用户的最终回答。 */
export async function streamFinalAnswer({
  finalState,
  apiKey,
  model,
  controller,
  encoder,
}: StreamFinalAnswerOptions): Promise<void> {
  const response = await fetch(QWEN_STREAM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: buildModelMessages(finalState),
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!response.ok || !response.body) {
    const detail = await response.text();
    throw new Error(`最终回答模型调用失败: ${detail || response.status}`);
  }

  const backgroundUsage = finalState.tokenUsage || {
    prompt: 0,
    completion: 0,
    total: 0,
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const thinkingState = { thinking: false, thinkingClosed: false };
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      try {
        const payload = JSON.parse(data) as StreamDeltaResponse;
        emitCombinedUsage(
          payload,
          backgroundUsage,
          controller,
          encoder,
        );
        emitDelta(payload, thinkingState, controller, encoder);
      } catch {
        // 流式 JSON 可能在网络边界处不完整，残片由下一轮 buffer 继续拼接。
      }
    }
  }

  if (thinkingState.thinking && !thinkingState.thinkingClosed) {
    sendSse(controller, encoder, {
      type: "TEXT",
      content: "<INTERNAL_THINK_END>",
    });
  }
}
