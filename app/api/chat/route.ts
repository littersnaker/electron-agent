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
import {
  sendSse,
  sendSseComment,
  sendUsage,
} from "./server/sse";
import { streamFinalAnswer } from "./server/stream-final-answer";
import type { ChatRequestBody, FrontendMessage } from "./server/types";

export const runtime = "nodejs";

/** 将前端消息转换成 LangGraph 使用的 BaseMessage。 */
function toLangChainMessage(message: FrontendMessage): BaseMessage {
  if (message.role === "user") return new HumanMessage(message.content);
  if (message.role === "assistant") return new AIMessage(message.content);
  return new SystemMessage(message.content);
}

/**
 * Code Agent 请求入口。
 *
 * V6 变化：
 * 1. 工作目录以数据库中的项目记录为准，不再允许空路径回退 process.cwd()；
 * 2. workspace_info/read_only 请求在图内短路，不再强行生成任务报告；
 * 3. LLM Provider、Prompt Registry 与 Model Router 已从业务节点解耦；
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
    const workspace = resolveChatWorkspace(
      body.projectId,
      body.workingDir,
    );
    const inputMessages = (body.messages || []).map(toLangChainMessage);
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

          const graphSeconds = (
            (performance.now() - startedAt) /
            1000
          ).toFixed(1);
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
