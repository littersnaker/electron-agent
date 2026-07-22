import { NextResponse } from "next/server";
import { resolveLlmCredentials } from "@/app/lib/llm/credentials";
import { AUTO_MODEL_ID } from "@/app/lib/llm/model-catalog";
import { streamWithLlm } from "@/app/lib/llm/gateway";
import type { LlmMessage } from "@/app/lib/llm/types";
import { QaPromptText } from "../chat/prompt";
import {
  sendSse,
  sendSseComment,
  sendUsage,
} from "../chat/server/sse";
import type { ChatRequestBody, FrontendMessage } from "../chat/server/types";

export const runtime = "nodejs";

function toLlmMessage(message: FrontendMessage): LlmMessage {
  return {
    role: message.role === "assistant" ? "assistant" : message.role,
    content: message.content,
  };
}

/** 普通问答也复用同一 LLM Gateway 与 Model Router。 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as ChatRequestBody;
    const credentials = resolveLlmCredentials(request.headers);
    const preferredModelId =
      request.headers.get("x-llm-model-id")?.trim() ||
      request.headers.get("x-dashscope-model")?.trim() ||
      AUTO_MODEL_ID;
    const messages: LlmMessage[] = [
      { role: "system", content: QaPromptText },
      ...(body.messages || []).map(toLlmMessage),
    ];
    const encoder = new TextEncoder();

    const outputStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        sendSseComment(controller, encoder, "connected");
        try {
          for await (const chunk of streamWithLlm({
            task: "chat",
            preferredModelId,
            credentials,
            messages,
            signal: request.signal,
          })) {
            if (chunk.textDelta) {
              sendSse(controller, encoder, {
                type: "TEXT",
                content: chunk.textDelta,
              });
            }
            if (chunk.usage) {
              sendUsage(controller, encoder, chunk.usage);
            }
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "普通问答模型调用失败";
          sendSse(controller, encoder, {
            type: "TEXT",
            content: `⚠️ ${message}`,
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(outputStream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "无效的问答请求";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
