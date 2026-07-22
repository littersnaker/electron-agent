import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { streamWithLlm } from "@/app/lib/llm/gateway";
import type { LlmCredentials, LlmMessage } from "@/app/lib/llm/types";
import { systemPromptText } from "../prompt";
import { sendSse, sendUsage } from "./sse";
import type { SseController } from "./sse";
import type { AgentStateValues } from "./types";

interface StreamFinalAnswerOptions {
  finalState: AgentStateValues;
  credentials: LlmCredentials;
  preferredModelId: string;
  controller: SseController;
  encoder: TextEncoder;
}

function buildModelMessages(finalState: AgentStateValues): LlmMessage[] {
  const memorySummary = finalState.summary
    ? `\n\n[此前久远的对话背景历史摘要]\n${finalState.summary}`
    : "";
  const messages: LlmMessage[] = [
    {
      role: "system",
      content: `${systemPromptText}${memorySummary}\n\n最终回答必须以 Agent Final Report 为唯一执行事实依据，不得猜测未发生的文件修改或验证结果。`,
    },
  ];

  for (const message of finalState.messages || []) {
    const type = message._getType();
    if (type === "system") continue;

    if (type === "human") {
      messages.push({ role: "user", content: String(message.content) });
      continue;
    }

    if (type === "ai") {
      const aiMessage = message as AIMessage;
      messages.push({
        role: "assistant",
        content: String(aiMessage.content),
        toolCalls: aiMessage.tool_calls?.map((toolCall) => ({
          id: toolCall.id || `tool_${toolCall.name}`,
          type: "function",
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.args),
          },
        })),
      });
      continue;
    }

    if (type === "tool") {
      const toolMessage = message as ToolMessage;
      messages.push({
        role: "tool",
        content: String(toolMessage.content),
        toolCallId: toolMessage.tool_call_id,
        name: toolMessage.name,
      });
      continue;
    }

    messages.push({ role: "user", content: String(message.content) });
  }

  messages.push({
    role: "user",
    content: `以下是本轮 LangGraph 生成的 Agent Final Report。请只做自然、准确的最终表达，不要增加未发生的操作：\n\n${
      finalState.finalReportSummary || "本轮没有生成 Final Report。"
    }`,
  });

  return messages;
}

/** 把 Code Agent 的 Final Report 流式整理成面向用户的最终回答。 */
export async function streamFinalAnswer({
  finalState,
  credentials,
  preferredModelId,
  controller,
  encoder,
}: StreamFinalAnswerOptions): Promise<void> {
  const backgroundUsage = finalState.tokenUsage || {
    prompt: 0,
    completion: 0,
    total: 0,
  };
  let thinking = false;
  let thinkingClosed = false;

  for await (const chunk of streamWithLlm({
    task: "final_answer",
    preferredModelId,
    credentials,
    messages: buildModelMessages(finalState),
  })) {
    let frontendChunk = "";

    if (chunk.reasoningDelta) {
      if (!thinking) {
        thinking = true;
        frontendChunk += "<INTERNAL_THINK_START>";
      }
      frontendChunk += chunk.reasoningDelta;
    }

    if (chunk.textDelta) {
      if (thinking && !thinkingClosed) {
        thinkingClosed = true;
        frontendChunk += "<INTERNAL_THINK_END>";
      }
      frontendChunk += chunk.textDelta;
    }

    if (frontendChunk) {
      sendSse(controller, encoder, {
        type: "TEXT",
        content: frontendChunk,
      });
    }

    if (chunk.usage) {
      sendUsage(controller, encoder, {
        prompt: backgroundUsage.prompt + chunk.usage.prompt,
        completion: backgroundUsage.completion + chunk.usage.completion,
        total: backgroundUsage.total + chunk.usage.total,
      });
    }
  }

  if (thinking && !thinkingClosed) {
    sendSse(controller, encoder, {
      type: "TEXT",
      content: "<INTERNAL_THINK_END>",
    });
  }
}
