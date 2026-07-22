import { NextResponse } from "next/server";
import { resolveLlmCredentials } from "@/app/lib/llm/credentials";
import { AUTO_MODEL_ID } from "@/app/lib/llm/model-catalog";
import { streamWithLlm } from "@/app/lib/llm/gateway";
import type { LlmContentPart, LlmMessage } from "@/app/lib/llm/types";
import { QaPromptText } from "../chat/prompt";
import {
  sendSse,
  sendSseComment,
  sendUsage,
} from "../chat/server/sse";
import type { ChatRequestBody, FrontendMessage } from "../chat/server/types";

export const runtime = "nodejs";

function parseAttachmentDataUrl(
  value: string,
): { mimeType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(value);
  if (!match) return undefined;
  return {
    mimeType: match[1] || "image/png",
    data: match[2],
  };
}

function toLlmMessage(
  message: FrontendMessage,
  imageParts?: readonly LlmContentPart[],
): LlmMessage {
  return {
    role: message.role === "assistant" ? "assistant" : message.role,
    content: message.content,
    parts:
      message.role === "user" && imageParts?.length
        ? [{ type: "text", text: message.content }, ...imageParts]
        : undefined,
  };
}

/** 普通问答复用 V7 模型编排层，并支持图片输入触发视觉模型。 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as ChatRequestBody;
    const credentials = resolveLlmCredentials(request.headers);
    const preferredModelId =
      request.headers.get("x-llm-model-id")?.trim() ||
      request.headers.get("x-dashscope-model")?.trim() ||
      AUTO_MODEL_ID;
    const imageParts: LlmContentPart[] = (body.attachments || []).flatMap(
      (attachment): LlmContentPart[] => {
        const parsed = parseAttachmentDataUrl(attachment.dataUrl);
        return parsed
          ? [
              {
                type: "image",
                mimeType: parsed.mimeType,
                data: parsed.data,
                name: attachment.name,
              },
            ]
          : [];
      },
    );
    const sourceMessages = body.messages || [];
    const messages: LlmMessage[] = [
      { role: "system", content: QaPromptText },
      ...sourceMessages.map((message, index) =>
        toLlmMessage(
          message,
          index === sourceMessages.length - 1 ? imageParts : undefined,
        ),
      ),
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
