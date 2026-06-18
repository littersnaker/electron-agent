import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { NextResponse } from "next/server";
import { graph } from "./agent/graph";

const QWEN_STREAM_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

interface FrontendMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface StreamDeltaResponse {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
}

interface AgentStateValues extends Record<string, unknown> {
  messages?: BaseMessage[];
  summary?: string;
}

interface ToolPayload extends Record<string, unknown> {
  pendingDiffResult?: string;
}

export async function POST(req: Request): Promise<Response> {
  if (!process.env.DASHSCOPE_API_KEY) {
    return NextResponse.json(
      { error: "Missing DASHSCOPE_API_KEY" },
      { status: 500 },
    );
  }

  try {
    const body = (await req.json()) as {
      messages?: FrontendMessage[];
      sessionId?: string;
    };
    const messages = body.messages || [];
    const sessionId = body.sessionId || "default-global-thread";

    const inputMessages: BaseMessage[] = messages.map((m) => {
      if (m.role === "user") return new HumanMessage(m.content);
      if (m.role === "assistant") return new AIMessage(m.content);
      return new SystemMessage(m.content);
    });

    const encoder = new TextEncoder();

    const outputStream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        
        // ==========================================
        // ⏱️ 开启总计时器与流水节点计时器
        // ==========================================
        const totalGraphStart = performance.now();
        let lastNodeTimestamp = performance.now();

        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "STATUS", content: "🤖 Agent 收到指令，开始激活工作流拓扑网..." })}\n\n`)
        );

        let finalState: AgentStateValues | null = null;

        try {
          const graphStream = await graph.stream(
            { messages: inputMessages },
            { configurable: { thread_id: sessionId }, recursionLimit: 10, streamMode: "updates" }
          );

          for await (const chunk of graphStream) {
            const now = performance.now();
            // 计算当前节点跑了多少秒
            const nodeElapsed = ((now - lastNodeTimestamp) / 1000).toFixed(1);
            lastNodeTimestamp = now; // 重置锚点给下一个节点用

            const updates = chunk as Record<string, Record<string, unknown>>;
            
            if ("router" in updates) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "STATUS", content: `🔍 意图路由分析完成 (耗时: ${nodeElapsed}s)` })}\n\n`)
              );
            }
            
            if ("execute_tools" in updates) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "TOOL_STATUS", content: `propose_file_change (耗时: ${nodeElapsed}s)` })}\n\n`)
              );
              
              const toolPayload = updates.execute_tools as ToolPayload;
              if (toolPayload?.pendingDiffResult) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: "TEXT", content: toolPayload.pendingDiffResult })}\n\n`)
                );
              }
            }

            if ("summarize" in updates) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "STATUS", content: `📦 历史上下文压缩精炼完成 (耗时: ${nodeElapsed}s)` })}\n\n`)
              );
            }
          }

          const graphSnapshot = await graph.getState({ configurable: { thread_id: sessionId } });
          finalState = graphSnapshot.values as AgentStateValues;

        } catch (graphErr) {
          console.error("LangGraph 运行期异常:", graphErr);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "ERROR", content: "Agent 思考流中断" })}\n\n`));
          controller.close();
          return;
        }

        // 计算 LangGraph 核心图处理完毕的总耗时
        const totalGraphElapsed = ((performance.now() - totalGraphStart) / 1000).toFixed(1);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "STATUS", content: `✨ 拓扑网络演算完毕，总耗时: ${totalGraphElapsed}s。开始接入大模型深度推理...` })}\n\n`)
        );

        const memorySummaryText = finalState?.summary
          ? `\n\n[此前久远的对话背景历史摘要]:\n${finalState.summary}`
          : "";

        const systemPrompt = {
          role: "system",
          content: `You are an expert AI software architect and coding agent. Respond in Chinese.
⚠️ CRITICAL OUTPUT PROTOCOL:
Before writing any final response, you MUST perform deep reasoning and planning. 
You MUST output your internal chain of thought wrapped inside <think> and </think> tags.${memorySummaryText}`,
        };

        const recentMessages = (finalState?.messages || [])
          .filter((m) => m._getType() !== "system")
          .map((m) => {
            const type = m._getType();
            if (type === "human") return { role: "user" as const, content: m.content as string };
            if (type === "ai") {
              const aiM = m as AIMessage;
              return {
                role: "assistant" as const,
                content: aiM.content as string,
                tool_calls: aiM.tool_calls && aiM.tool_calls.length > 0
                  ? aiM.tool_calls.map((tc) => ({
                      id: tc.id,
                      type: "function" as const,
                      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                    }))
                  : undefined,
              };
            }
            if (type === "tool") {
              const toolM = m as ToolMessage;
              return { role: "tool" as const, content: toolM.content as string, tool_call_id: toolM.tool_call_id };
            }
            return { role: "user" as const, content: String(m.content) };
          });

        try {
          const streamResponse = await fetch(QWEN_STREAM_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
            },
            body: JSON.stringify({
              model: "qwen3.7-plus",
              messages: [systemPrompt, ...recentMessages],
              stream: true,
            }),
          });

          if (!streamResponse.ok) {
            throw new Error(`Qwen API return status ${streamResponse.status}`);
          }

          const reader = streamResponse.body!.getReader();
          let buffer = "";
          let isThinking = false;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith("data:")) continue;
              const dataJson = trimmed.slice("data:".length).trim();
              if (dataJson === "[DONE]") break;

              try {
                const parsed = JSON.parse(dataJson) as StreamDeltaResponse;
                const text = parsed.choices?.[0]?.delta?.content || "";
                if (text) {
                  if (text.includes("<think>")) {
                    isThinking = true;
                  }

                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ type: "TEXT", content: text })}\n\n`)
                  );

                  if (text.includes("</think>")) {
                    isThinking = false;
                    console.log(`模型思考完毕，转入正式回答，状态锁定为: ${String(isThinking)}`);
                  }
                }
              } catch {
                // 忽略残缺流行
              }
            }
          }
        } catch (qwenErr) {
          console.error("千问流读取异常:", qwenErr);
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

  } catch (error: unknown) {
    console.error("❌ [Fatal Error]:", error);
    return NextResponse.json({ error: "SERVER_INTERNAL_FATAL" }, { status: 500 });
  }
}

const decoder = new TextDecoder("utf-8");