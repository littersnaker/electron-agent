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

/*
 * 这个文件是“前端聊天界面”和“后端多 Agent 图”之间的桥。
 *
 * 它主要做三件事：
 * 1. 把前端消息转成 LangChain / LangGraph 能理解的消息对象；
 * 2. 驱动 graph 运行，并把每个节点的进度实时以 SSE 推给前端；
 * 3. 在图跑完之后，再把最终状态拼进大模型流式回答里返回给前端。
 *
 * 换句话说：
 * - `graph.ts` 负责内部状态机怎么跑；
 * - 这个文件负责“怎么把状态机过程展示给用户看”。
 */
interface FrontendMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// 这是阿里云 DashScope 流式返回增量片段的最小类型定义。
// 这里不追求把整份协议写全，只保留当前项目真正会用到的字段。
interface StreamDeltaResponse {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string; 
    };
  }>;
  // 👇 补充流式响应中的 Usage 字段类型
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface AgentStateValues extends Record<string, unknown> {
  messages?: BaseMessage[];
  summary?: string;
  finalReportSummary?: string;
  tokenUsage?: { prompt: number; completion: number; total: number };
  interactiveRequest?: Record<string, unknown> | null;
}

/*
 * POST 是整条聊天请求的主入口。
 *
 * 可以把它理解成一个“两阶段处理器”：
 * 第一阶段：先跑 LangGraph，多 Agent 完成规划 / 修改 / 审查 / 校验；
 * 第二阶段：再把图里沉淀出来的结果交给流式大模型，生成最终自然语言回答。
 *
 * 这样做的好处是：
 * - 图负责流程控制，结构稳定；
 * - 大模型负责最后表达，用户体验更自然。
 */
export async function POST(req: Request): Promise<Response> {
  const customApiKey = req.headers.get("x-dashscope-api-key");
  const customApiModel = req.headers.get("x-dashscope-model") as string;
  const apiKey = customApiKey || process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing DASHSCOPE_API_KEY" },
      { status: 500 },
    );
  }

  try {
    const body = (await req.json()) as {
      messages?: FrontendMessage[];
      sessionId?: string;
      workingDir?: string; 
      projectId?: string;
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
        // 先发一个 SSE 注释包，确保前端尽快建立连接。
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
          /*
           * 先查看当前 thread_id 是否已有历史状态。
           *
           * 这里的设计是：
           * - 新线程：把整段 messages 都送进图；
           * - 老线程：只补最近几条，避免每轮都把全历史重放一遍。
           */
          const graphSnapshot = await graph.getState({
            configurable: { thread_id: sessionId },
          });
          const hasExistingState =
            (graphSnapshot.values?.messages?.length || 0) > 0;

          let messagesToGraph = inputMessages;
          if (hasExistingState) {
            messagesToGraph = [inputMessages[inputMessages.length - 1]];
            if (inputMessages.length >= 2) {
              messagesToGraph.unshift(inputMessages[inputMessages.length - 2]);
            }
          }
          const workingDir = body.workingDir || "";
          const projectId = body.projectId || "";

          /*
           * streamMode: "updates" 的意思是：
           * 图每跑完一个节点，就把这个节点刚写入状态的增量吐出来。
           * 这样前端才能看到“Router -> Planner -> Modify -> Reviewer ...”的实时过程。
           */
          const graphStream = await graph.stream(
            {
              messages: messagesToGraph,
              model: customApiModel,
              workingDir: workingDir,
              projectId,
              apiKey,
            },
            {
              configurable: {
                thread_id: sessionId,
                working_dir: workingDir, 
              },
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

            // 下面这一大段 if，其实就是“节点名 -> 前端状态文案”的映射层。
            // 图内部状态很技术化，但前端要展示成用户更容易理解的中文进度。
            if ("router" in updates) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `🎯 Router 已接收任务 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("search_agent" in updates) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `🔎 SearchAgent 已完成代码检索 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("memory_agent" in updates) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `🧠 MemoryAgent 已整理历史记忆 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("file_agent" in updates) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `📂 FileAgent 已抽取文件上下文 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("merge_context" in updates) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `🧩 上下文合并完成 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("planning_agent" in updates) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `📝 Planner 已生成执行计划 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("planner_schema_validation" in updates) {
              const message =
                (updates.planner_schema_validation.plannerValidationMessage as string | undefined) ||
                "Planner JSON Schema 校验完成。";
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `📐 ${message} (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("file_uniqueness_check" in updates) {
              const message =
                (updates.file_uniqueness_check.plannerValidationMessage as string | undefined) ||
                "文件唯一性检查完成。";
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `🧾 ${message} (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("retry_planner" in updates) {
              const retryCount = (updates.retry_planner.plannerRetryCount as number | undefined) || 0;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `🔄 Planner 准备重试，第 ${retryCount} 次重规划 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("rules_repair" in updates) {
              const message =
                (updates.rules_repair.plannerValidationMessage as string | undefined) ||
                "规则修复完成。";
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `🛠️ ${message} (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("single_agent_degrade" in updates) {
              const message =
                (updates.single_agent_degrade.plannerValidationMessage as string | undefined) ||
                "已降级为单 Agent 执行。";
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `⬇️ ${message} (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("structured_task_list" in updates) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `📋 Structured Task List 已生成 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("retry_dispatch" in updates) {
              const retryTasks = (updates.retry_dispatch.retryTaskSlots as number[] | undefined) || [];
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `🔁 Reviewer 要求返工，目标槽位: ${retryTasks.length ? retryTasks.map((slot) => `Task ${slot + 1}`).join(", ") : "未指定"} (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            const modifyNodeName = ["modify_agent_a", "modify_agent_b", "modify_agent_c"].find(
              (nodeName) => nodeName in updates,
            );
            if (modifyNodeName) {
              const messages = updates[modifyNodeName].messages as
                | Array<{ name?: string }>
                | undefined;
              const firstMessageName = messages?.[0]?.name ?? "Unknown";
              if (ToolNameMap[firstMessageName]) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "TOOL_STATUS", content: `${ToolNameMap[firstMessageName]}` })}\n\n`,
                  ),
                );
              } else {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "STATUS", content: `✍️ ${modifyNodeName.replace(/_/g, " ")} 正在执行修改 (耗时: ${nodeElapsed}s)` })}\n\n`,
                  ),
                );
              }

              const interactiveRequest = updates[modifyNodeName]
                .interactiveRequest as Record<string, unknown> | null | undefined;
              if (interactiveRequest) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      type: "INTERACTIVE_REQUEST",
                      payload: interactiveRequest,
                    })}\n\n`,
                  ),
                );
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      type: "STATUS",
                      content: "🧭 终端命令需要交互，请使用下方按钮选择自动回答、LLM 回答或用户回答后继续。",
                    })}\n\n`,
                  ),
                );
              }
            }

            if ("merge_patch" in updates) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `🧷 Merge Patch 已汇总三路修改摘要，不做同文件自动合并 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("reviewer_agent" in updates) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `🕵️ Reviewer 已完成审查 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("lint_build_test" in updates) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `🧪 Lint / Build / Test 已完成 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }

            if ("final_report" in updates) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "STATUS", content: `✅ Final Report 已生成 (耗时: ${nodeElapsed}s)` })}\n\n`,
                ),
              );
            }
          }

          // 图跑完以后，再取一次最终快照。
          // 这一步拿到的是完整状态，不只是中途的 updates 增量。
          const finalSnapshot = await graph.getState({
            configurable: { thread_id: sessionId },
          });
          finalState = finalSnapshot.values as AgentStateValues;
          if (finalState.finalReportSummary) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "TEXT",
                  content: `### 最终报告\n${finalState.finalReportSummary}\n\n`,
                })}\n\n`,
              ),
            );
          }
          if (finalState.interactiveRequest) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "INTERACTIVE_REQUEST",
                  payload: finalState.interactiveRequest,
                })}\n\n`,
              ),
            );
          }
        } catch (graphErr) {
          console.error("LangGraph 运行期异常:", graphErr);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "TOOL_STATUS", content: "Agent 思考流中断" })}\n\n`,
            ),
          );
          controller.close();
          return;
        }

        // 到这里说明 LangGraph 部分已经全部执行完成。
        // 下面要做的是：把图的产物喂给最终大模型，让它组织成更自然的回答文本。
        const totalGraphElapsed = (
          (performance.now() - totalGraphStart) /
          1000
        ).toFixed(1);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "STATUS", content: `✨ 拓扑网络演算完毕，总耗时: ${totalGraphElapsed}s。开始接入大模型深度推理...` })}\n\n`,
          ),
        );

        // 提前把图内部各节点累积的 Token 取出来，后面和流式回答阶段一起统计。
        const backgroundTokens = finalState?.tokenUsage || { prompt: 0, completion: 0, total: 0 };
        const memorySummaryText = finalState?.summary
          ? `\n\n[此前久远的对话背景历史摘要]:\n${finalState.summary}`
          : "";

        /*
         * 这里的 systemPrompt 不是给图用的，而是给“最后那次流式回答”用的。
         *
         * 前面的 LangGraph 负责把事做完；
         * 这里负责把做完的结果，用更自然、更像助手的方式讲给用户听。
         */
        const systemPrompt = {
          role: "system",
          content: `你是一位顶级 AI 软件架构师与全栈编码代理。你的目标是高效、准确地协助用户完成项目开发。

【协作原则与工作流】：
1. 深入分析：在开始任何编码任务前，先理清需求。如有必要，使用 'read_file_from_disk' 或 'search_codebase' 获取上下文。
2. 优先使用工具：涉及文件修改时，必须使用 'propose_file_change' 提交修改。提交后，利用 'get_diff' 检查差异，确保逻辑无误，最后使用 'apply_file_change' 正式落地。
3. 动态调整：如果终端命令出现错误，请自行读取相关文件并分析错误日志，随后尝试修复。
4. 明确的沟通：完成每一个阶段性目标后，使用简洁专业的中文进行总结，并汇报你的工作进度。

【约束与协议】：
- 编码修改：建议使用 'propose_file_change' -> 'get_diff' -> 'apply_file_change' 的闭环流程，确保每次修改都经过验证，并且编码习惯必须严格要求eslint+typescript格式。
- 严禁输出xml代码块或任何内部标记语言，所有输出必须为标准 Markdown 格式。
- 严禁在对话内容中输出超长的完整代码块，涉及文件更新请一律使用工具处理。
- 如果用户需求模糊，请主动提问。
- 在输出最终报告时，使用标准 Markdown 格式（支持代码块语法 \`\`\`）。
- 始终保持 proactive（主动），如果发现代码可以优化或存在潜在 Bug，请直接向用户提出改进建议，并在得到许可后调用工具进行操作。

【当前上下文】：
${memorySummaryText}`,
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
              // 这里必须复用前面已经解析好的 apiKey。
              // 否则即使请求头里带了自定义 Key，或者 Electron 主进程已经注入了 Key，
              // 到最终流式回答这一步又会因为重新读取 process.env 而“看起来像丢 Key”。
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: customApiModel,
              messages: [
                systemPrompt,
                ...recentMessages,
              ],
              stream: true,
              stream_options: { include_usage: true }, // 👈 强制开启 Usage
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

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              console.log("✅ 流式传输正常结束");
              if (buffer) {
                const trimmed = buffer.trim();
                if (trimmed && trimmed.startsWith("data:")) {
                  const dataJson = trimmed.slice("data:".length).trim();
                  if (dataJson !== "[DONE]") {
                    try {
                      const parsed = JSON.parse(dataJson) as StreamDeltaResponse;
                      
                      // 👇 流结束时可能附带残余数据包包含 usage
                      if (parsed.usage) {
                        const finalPrompt = backgroundTokens.prompt + (parsed.usage.prompt_tokens || 0);
                        const finalCompletion = backgroundTokens.completion + (parsed.usage.completion_tokens || 0);
                        const finalTotal = backgroundTokens.total + (parsed.usage.total_tokens || 0);
                        controller.enqueue(
                          encoder.encode(`data: ${JSON.stringify({ type: "USAGE", content: { prompt: finalPrompt, completion: finalCompletion, total: finalTotal } })}\n\n`)
                        );
                      }

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
                
                // 👇 核心功能：如果在流中发现了 usage 数据包，执行后台累加合并，然后送给前端
                if (parsed.usage) {
                  const finalPrompt = backgroundTokens.prompt + (parsed.usage.prompt_tokens || 0);
                  const finalCompletion = backgroundTokens.completion + (parsed.usage.completion_tokens || 0);
                  const finalTotal = backgroundTokens.total + (parsed.usage.total_tokens || 0);

                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({ 
                        type: "USAGE", 
                        content: { prompt: finalPrompt, completion: finalCompletion, total: finalTotal } 
                      })}\n\n`,
                    ),
                  );
                }

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
