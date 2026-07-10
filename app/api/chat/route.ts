import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { NextResponse } from "next/server";
import { graph } from "./agent/graph";
import { ToolNameMap } from "@/app/const/pageConst";

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
      reasoning_content?: string; // 👈 必须加上这个，否则 TS 会报错
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
    const decoder = new TextDecoder("utf-8");

    const outputStream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));

        const totalGraphStart = performance.now();
        let lastNodeTimestamp = performance.now();

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "STATUS", content: "🤖 Agent 收到指令，开始激活工作流拓扑网..." })}\n\n`,
          ),
        );

        let finalState: AgentStateValues | null = null;

        try {
          // 检查 MemorySaver 中是否已有该会话的状态
          const graphSnapshot = await graph.getState({
            configurable: { thread_id: sessionId },
          });
          const hasExistingState =
            (graphSnapshot.values?.messages?.length || 0) > 0;

          // 如果 MemorySaver 已有状态，只传入新消息（最后一条），避免消息重复
          // 如果服务器重启后状态丢失，传入前端发送的所有消息恢复上下文
          let messagesToGraph = inputMessages;
          if (hasExistingState) {
            messagesToGraph = [inputMessages[inputMessages.length - 1]]; // 默认取最新一条 User 消息
            if (inputMessages.length >= 2) {
              // 将上一条 Assistant 的回复也塞进图里，补全上下文闭环
              messagesToGraph.unshift(inputMessages[inputMessages.length - 2]);
            }
          }

          const graphStream = await graph.stream(
            { messages: messagesToGraph },
            {
              configurable: { thread_id: sessionId },
              recursionLimit: 50,
              streamMode: "updates",
            },
          );

          for await (const chunk of graphStream) {
            console.log("🔍 当前图流转节点:", Object.keys(chunk));
            const now = performance.now();
            const nodeElapsed = ((now - lastNodeTimestamp) / 1000).toFixed(1);
            lastNodeTimestamp = now;

            const updates = chunk as Record<string, Record<string, unknown>>;

            if ("router" in updates) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `🔍 意图路由分析完成 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("execute_tools" in updates) {
              const messages = updates.execute_tools.messages as
                | Array<{ name?: string }>
                | undefined;
              const firstMessageName = messages?.[0]?.name ?? "Unknown";
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "TOOL_STATUS", content: `${ToolNameMap[firstMessageName] || "Unknown Tool"}` })}\n\n`,
                ),
              );

              const toolPayload = updates.execute_tools as ToolPayload;
              if (toolPayload?.pendingDiffResult) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "TEXT", content: toolPayload.pendingDiffResult })}\n\n`,
                  ),
                );
              }
            }

            if ("summarize" in updates) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `📦 历史上下文压缩精炼完成 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }
          }

          // const graphSnapshot = await graph.getState({
          //   configurable: { thread_id: sessionId },
          // });
          const finalSnapshot = await graph.getState({
            configurable: { thread_id: sessionId },
          });
          finalState = finalSnapshot.values as AgentStateValues;
          if (finalState.summary) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "TEXT",
                  content: `### \n${finalState.summary}\n\n`,
                })}\n\n`,
              ),
            );
          }
        } catch (graphErr) {
          console.error("LangGraph 运行期异常:", graphErr);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "ERROR", content: "Agent 思考流中断" })}\n\n`,
            ),
          );
          controller.close();
          return;
        }

        const totalGraphElapsed = (
          (performance.now() - totalGraphStart) /
          1000
        ).toFixed(1);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "STATUS", content: `✨ 拓扑网络演算完毕，总耗时: ${totalGraphElapsed}s。开始接入大模型深度推理...` })}\n\n`,
          ),
        );

        const memorySummaryText = finalState?.summary
          ? `\n\n[此前久远的对话背景历史摘要]:\n${finalState.summary}`
          : "";

        // 系统提示词：禁止模型在最终回复阶段输出任何内部 XML，并明确要求模型必须输出最终正文
        const systemPrompt = {
          role: "system",
          content: `You are an expert AI software architect and coding agent. Respond in Chinese.
⚠️ CRITICAL OUTPUT PROTOCOL:
1. Before writing any final response, you MUST perform deep reasoning and planning.
2. The API will automatically separate your reasoning into 'reasoning_content' and your final answer into 'content'. You do NOT need to manually wrap your thinking in any tags.
3. After reading files or analyzing code, you MUST provide a comprehensive response in the final content, including key findings, file structure analysis, and actionable suggestions.
4. 🚫 STRICT RULE: The tool execution phase is OVER. DO NOT output ANY raw XML tool calls (like <function_calls>, <invoke>, <tool_call>). Provide your answer directly using standard Markdown!${memorySummaryText}`,
        };

        const recentMessages = (finalState?.messages || [])
          .filter((m) => m._getType() !== "system")
          .map((m) => {
            const type = m._getType();
            if (type === "human")
              return { role: "user" as const, content: m.content };
            if (type === "ai") {
              const aiM = m as AIMessage;
              return {
                role: "assistant" as const,
                content: aiM.content as string,
                tool_calls:
                  aiM.tool_calls && aiM.tool_calls.length > 0
                    ? aiM.tool_calls.map((tc) => ({
                        id: tc.id,
                        type: "function" as const,
                        function: {
                          name: tc.name,
                          arguments: JSON.stringify(tc.args),
                        },
                      }))
                    : undefined,
              };
            }
            if (type === "tool") {
              const toolM = m as ToolMessage;
              return {
                role: "tool" as const,
                content: toolM.content as string,
                tool_call_id: toolM.tool_call_id,
              };
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
              model: "qwen3.7-plus-2026-05-26",
              messages: [systemPrompt, ...recentMessages],
              stream: true,
            }),
          });

          if (!streamResponse.ok) {
            const errorText = await streamResponse.text();
            console.error("千问报错详情:", errorText);

            const errorPayload = {
              type: "STATUS",
              content: "❌ 大模型调用失败，请检查账户余额或上下文长度。",
            };
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(errorPayload)}\n\n`,
              ),
            );
            throw new Error(`Qwen API return status ${streamResponse.status}`);
          }

          const reader = streamResponse.body!.getReader();
          let buffer = "";
          let isThinkingPhase = false;
          let hasFinishedThinking = false;

          // ⚡ 实例化高级过滤器

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              console.log("✅ 流式传输正常结束");
              // 处理残留 buffer 中最后不完整的一行
              if (buffer) {
                const trimmed = buffer.trim();
                if (trimmed && trimmed.startsWith("data:")) {
                  const dataJson = trimmed.slice("data:".length).trim();
                  if (dataJson !== "[DONE]") {
                    try {
                      const parsed = JSON.parse(
                        dataJson,
                      ) as StreamDeltaResponse;
                      const delta = parsed.choices?.[0]?.delta;
                      const reasoning = delta?.reasoning_content || "";
                      const content = delta?.content || "";
                      let chunkToFrontend = "";
                      if (reasoning) {
                        if (!isThinkingPhase) {
                          isThinkingPhase = true;
                          chunkToFrontend += "<INTERNAL_THINK_START>";
                        }
                        chunkToFrontend += reasoning;
                      }
                      if (content) {
                        if (isThinkingPhase && !hasFinishedThinking) {
                          hasFinishedThinking = true;
                          chunkToFrontend += "<INTERNAL_THINK_END>";
                        }
                        chunkToFrontend += content;
                      }
                      if (chunkToFrontend) {
                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify({ type: "TEXT", content: chunkToFrontend })}\n\n`,
                          ),
                        );
                      }
                    } catch {}
                  }
                }
              }
              // 如果流结束时 thinking 还没有关闭，自动关闭标签
              if (isThinkingPhase && !hasFinishedThinking) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "TEXT", content: "<INTERNAL_THINK_END>" })}\n\n`,
                  ),
                );
              }
              break;
            }

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
                const delta = parsed.choices?.[0]?.delta;

                const reasoning = delta?.reasoning_content || "";
                const content = delta?.content || "";

                let chunkToFrontend = "";

                // 1. 处理推理阶段 (思考中)
                if (reasoning) {
                  if (!isThinkingPhase) {
                    isThinkingPhase = true;
                    chunkToFrontend += "<INTERNAL_THINK_START>"; // 首次收到推理内容，添加思考标签
                  }
                  chunkToFrontend += reasoning;
                }

                // 2. 处理正文阶段 (思考结束闭合)
                if (content) {
                  if (isThinkingPhase && !hasFinishedThinking) {
                    hasFinishedThinking = true;
                    chunkToFrontend += "<INTERNAL_THINK_END>";
                  }
                  chunkToFrontend += content;
                }

                // 3. 将拼接好的流推给前端
                if (chunkToFrontend) {
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ type: "TEXT", content: chunkToFrontend })}\n\n`,
                    ),
                  );
                }
              } catch {
                // 忽略残缺流数据
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
    return NextResponse.json(
      { error: "SERVER_INTERNAL_FATAL" },
      { status: 500 },
    );
  }
}
