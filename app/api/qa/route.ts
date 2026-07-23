import { NextResponse } from "next/server";
import { resolveLlmCredentials } from "@/app/lib/llm/credentials";
import { streamWithLlm } from "@/app/lib/llm/gateway";
import { AUTO_MODEL_ID } from "@/app/lib/llm/model-catalog";
import { QaPromptText } from "@/app/api/chat/prompt";
import type { LlmContentPart, LlmMessage } from "@/app/lib/llm/types";

export const runtime = "nodejs";

type FrontendMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type FrontendAttachment = {
  name: string;
  mimeType: string;
  /** 新格式：纯 Base64。 */
  data?: string;
  /** 兼容旧客户端：完整 Data URL。 */
  dataUrl?: string;
};

type QaRequestBody = {
  messages?: FrontendMessage[];
  attachments?: FrontendAttachment[];
};

function sendSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  payload: Record<string, unknown>,
): void {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

function parseDataUrl(
  value: string,
): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/iu.exec(
    value.trim(),
  );
  if (!match) return null;

  return {
    mimeType: match[1] || "image/png",
    data: match[2].replace(/\s+/gu, ""),
  };
}

function toImagePart(attachment: FrontendAttachment): LlmContentPart {
  const legacy = attachment.dataUrl?.trim();
  const parsed = legacy ? parseDataUrl(legacy) : null;
  const mimeType = parsed?.mimeType || attachment.mimeType?.trim();
  const data = (parsed?.data || attachment.data?.trim() || "").replace(
    /\s+/gu,
    "",
  );

  if (!mimeType?.startsWith("image/")) {
    throw new Error(`附件 ${attachment.name || "未命名图片"} 的 MIME 类型无效`);
  }
  if (!data) {
    throw new Error(`附件 ${attachment.name || "未命名图片"} 缺少图片数据`);
  }

  return {
    type: "image",
    mimeType,
    data,
    name: attachment.name,
  };
}

function buildMessages(body: QaRequestBody): LlmMessage[] {
  const source = body.messages || [];
  const lastUserIndex = source.reduce(
    (result, message, index) => (message.role === "user" ? index : result),
    -1,
  );

  return [
    { role: "system", content: QaPromptText },
    ...source.map((message, index): LlmMessage => {
      const role =
        message.role === "assistant" || message.role === "system"
          ? message.role
          : "user";

      if (
        role === "user" &&
        index === lastUserIndex &&
        body.attachments?.length
      ) {
        return {
          role,
          content: message.content,
          parts: [
            { type: "text", text: message.content || "请分析这张图片" },
            ...body.attachments.map(toImagePart),
          ],
        };
      }

      return { role, content: message.content };
    }),
  ];
}

export async function POST(request: Request): Promise<Response> {
  const credentials = resolveLlmCredentials(request.headers);
  const preferredModelId =
    request.headers.get("x-llm-model-id")?.trim() ||
    request.headers.get("x-dashscope-model")?.trim() ||
    AUTO_MODEL_ID;

  try {
    const body = (await request.json()) as QaRequestBody;
    const messages = buildMessages(body);
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        let thinkingStarted = false;
        let thinkingClosed = false;

        try {
          for await (const chunk of streamWithLlm({
            task: "chat",
            preferredModelId,
            credentials,
            messages,
          })) {
            let content = "";

            if (chunk.reasoningDelta) {
              if (!thinkingStarted) {
                thinkingStarted = true;
                content += "<INTERNAL_THINK_START>";
              }
              content += chunk.reasoningDelta;
            }

            if (chunk.textDelta) {
              if (thinkingStarted && !thinkingClosed) {
                thinkingClosed = true;
                content += "<INTERNAL_THINK_END>";
              }
              content += chunk.textDelta;
            }

            if (content) {
              sendSse(controller, encoder, { type: "TEXT", content });
            }

            if (chunk.usage) {
              sendSse(controller, encoder, {
                type: "USAGE",
                content: chunk.usage,
              });
            }
          }

          if (thinkingStarted && !thinkingClosed) {
            sendSse(controller, encoder, {
              type: "TEXT",
              content: "<INTERNAL_THINK_END>",
            });
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "模型请求失败";
          sendSse(controller, encoder, {
            type: "TEXT",
            content: `⚠️ ${message}`,
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "无效的 QA 请求",
      },
      { status: 400 },
    );
  }
}
