import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { NextResponse } from "next/server";
import { resolveLlmCredentials } from "@/app/lib/llm/credentials";
import { AUTO_MODEL_ID } from "@/app/lib/llm/model-catalog";
import { resolveChatWorkspace } from "./server/resolve-chat-workspace";
import { runAgentGraph } from "./server/run-agent-graph";
import { sendSse, sendSseComment, sendUsage } from "./server/sse";
import { streamFinalAnswer } from "./server/stream-final-answer";
import type {
  ChatRequestBody,
  FrontendAttachment,
  FrontendMessage,
} from "./server/types";

export const runtime = "nodejs";

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

function normalizeFrontendAttachment(
  attachment: FrontendAttachment,
): Record<string, unknown> {
  const legacyDataUrl = attachment.dataUrl?.trim();
  const parsedLegacy = legacyDataUrl ? parseDataUrl(legacyDataUrl) : null;
  const mimeType = parsedLegacy?.mimeType || attachment.mimeType?.trim();
  const data = (parsedLegacy?.data || attachment.data?.trim() || "").replace(
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

/**
 * 将前端附件转换为 Provider 无关的 LangChain 内容块。
 * OpenAI image_url / Gemini inlineData 的差异只在 Provider 层处理。
 */
function toMultimodalParts(
  content: string,
  attachments: readonly FrontendAttachment[],
): Array<
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image_url";
      image_url: {
        url: string;
      };
    }
> {
  return [
    {
      type: "text",
      text: content,
    },
    ...attachments.map((attachment) => {
      const normalized = normalizeFrontendAttachment(attachment);

      return {
        type: "image_url" as const,
        image_url: {
          url: `data:${normalized.mimeType};base64,${normalized.data}`,
        },
      };
    }),
  ];
}

function toLangChainMessage(
  message: FrontendMessage,
  attachments: readonly FrontendAttachment[] = [],
): BaseMessage {
  switch (message.role) {
    case "user":
      if (attachments.length) {
        return new HumanMessage({
          content: toMultimodalParts(message.content, attachments) as never,
        });
      }

      return new HumanMessage(message.content);

    case "assistant":
      return new AIMessage(message.content);

    default:
      return new SystemMessage(message.content);
  }
}

/**
 * Code Agent 请求入口。
 *
 * V7 变化：
 * 1. 工作目录以数据库中的项目记录为准，不再允许空路径回退 process.cwd()；
 * 2. workspace_info/read_only 请求在图内短路，不再强行生成任务报告；
 * 3. 模型编排层按能力、凭证和任务评分选择模型，并支持故障降级；
 * 4. SSE、图运行和最终回答拆分到独立模块，保持 Route 可维护。
 */
export async function POST(request: Request): Promise<Response> {
  const credentials = resolveLlmCredentials(request.headers);
  const preferredModelId =
    request.headers.get("x-llm-model-id")?.trim() ||
    request.headers.get("x-dashscope-model")?.trim() ||
    AUTO_MODEL_ID;

  try {
    const body = (await request.json()) as ChatRequestBody;
    const workspace = resolveChatWorkspace(body.projectId, body.workingDir);
    const sourceMessages = body.messages || [];
    const inputMessages = sourceMessages.map((message, index) =>
      toLangChainMessage(
        message,
        index === sourceMessages.length - 1 ? body.attachments || [] : [],
      ),
    );
    const sessionId = body.sessionId?.trim() || "default-code-thread";
    const encoder = new TextEncoder();

    const outputStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        sendSseComment(controller, encoder, "connected");
        sendSse(controller, encoder, {
          type: "STATUS",
          content: "🤖 Agent 已接收请求，正在识别任务类型…",
        });

        const startedAt = performance.now();

        try {
          const finalState = await runAgentGraph({
            inputMessages,
            sessionId,
            model: preferredModelId,
            workingDir: workspace.workingDir,
            projectId: workspace.projectId,
            llmCredentials: credentials,
            controller,
            encoder,
          });

          if (finalState.interactiveRequest) {
            sendSse(controller, encoder, {
              type: "INTERACTIVE_REQUEST",
              payload: finalState.interactiveRequest,
            });
            sendSse(controller, encoder, {
              type: "STATUS",
              content: "⏸ 终端正在等待用户输入，已保留当前进程现场。",
            });
            sendUsage(
              controller,
              encoder,
              finalState.tokenUsage || {
                prompt: 0,
                completion: 0,
                total: 0,
              },
            );
            controller.close();
            return;
          }

          if (finalState.directAnswer?.trim()) {
            sendSse(controller, encoder, {
              type: "TEXT",
              content: finalState.directAnswer.trim(),
            });
            sendUsage(
              controller,
              encoder,
              finalState.tokenUsage || {
                prompt: 0,
                completion: 0,
                total: 0,
              },
            );
            controller.close();
            return;
          }

          const graphSeconds = ((performance.now() - startedAt) / 1000).toFixed(
            1,
          );
          sendSse(controller, encoder, {
            type: "STATUS",
            content: `✨ Code Agent 工作流已完成（${graphSeconds}s），正在整理最终回答…`,
          });

          await streamFinalAnswer({
            finalState,
            credentials,
            preferredModelId,
            controller,
            encoder,
          });
          controller.close();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Code Agent 执行失败";
          console.error("Code Agent 运行异常:", error);
          sendSse(controller, encoder, {
            type: "TEXT",
            content: `⚠️ ${message}`,
          });
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
      error instanceof Error ? error.message : "无效的 Code Agent 请求";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
