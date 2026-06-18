import {
  AIMessage,
  RemoveMessage,
  ToolMessage,
} from "@langchain/core/messages";
import fs from "fs";
import path from "path";
import { tools } from "../tools";
import { AgentState } from "./state";
const QWEN_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

interface QwenMessageResponse {
  choices?: Array<{
    message?: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
}
interface QwenSummaryResponse {
  choices?: Array<{
    message?: {
      content: string | null;
    };
  }>;
}

// --------------------------------------------------------
// 节点 A: 严格路由节点
// --------------------------------------------------------
export async function routerNode(
  state: typeof AgentState.State,
): Promise<Record<string, unknown>> {
  const recentMessages = state.messages.slice(-6);

  const firstStageContext = [
    {
      role: "system",
      content: `You are a STRICT routing module. Your ONLY job is to evaluate if the user's latest request requires a tool call. 
      1. If YES, call the relevant tool. 
      2. If NO, output EXACTLY AND ONLY the string 'NO_TOOL'. 
      CRITICAL: DO NOT act as an AI assistant. DO NOT provide any text explanation. ONLY output 'NO_TOOL' or trigger a tool.`,
    },
    {
      role: "user",
      content: `Analyze the following conversation history:\n${JSON.stringify(recentMessages, null, 2)}\n\nAction required: If a tool is needed, call it. If not, output 'NO_TOOL'.`,
    },
  ];

  const res = await fetch(QWEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
    },
    body: JSON.stringify({
      model: "qwen3.6-flash-2026-04-16",
      messages: firstStageContext,
      tools: tools,
      tool_choice: "auto",
      stream: false,
    }),
  });

  const result = (await res.json()) as QwenMessageResponse;
  const assistantMessage = result.choices?.[0]?.message;

  if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
    const aiMessage = new AIMessage({
      content: assistantMessage.content || "",
      tool_calls: assistantMessage.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments) as Record<string, unknown>,
        type: "tool_call" as const,
      })),
    });

    return {
      routeDecision: "TOOL_CALL",
      messages: [aiMessage],
    };
  }

  return { routeDecision: "NO_TOOL" };
}

// --------------------------------------------------------
// 磁盘物理辅助操作
// --------------------------------------------------------
async function proposeCodeChange(
  filePath: string,
  fileContent: string,
): Promise<string> {
  try {
    const rootPath = process.cwd();
    const safePath = path.join(
      rootPath,
      filePath.startsWith("src/") ? filePath : path.join("src", filePath),
    );
    if (!fs.existsSync(safePath)) {
      fs.writeFileSync(safePath, fileContent, "utf-8");
      return JSON.stringify({ msg: `🆕 成功新建了文件：${filePath}` });
    }
    const pendingPath = `${safePath}.pending`;
    fs.writeFileSync(pendingPath, fileContent, "utf-8");
    return JSON.stringify({
      type: "DIFF_READY",
      payload: {
        original: filePath,
        pending: `${filePath}.pending`,
        message: "我已将修改生成在 .pending 文件中",
      },
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return `❌ 计算补丁失败: ${errorMessage}`;
  }
}

async function readFileFromLocalDisk(filePath: string): Promise<string> {
  try {
    const rootPath = process.cwd();
    const safePath = path.join(rootPath, filePath);
    if (!fs.existsSync(safePath)) return `❌ 未找到文件: ${filePath}`;
    return fs.readFileSync(safePath, "utf-8");
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return `❌ 读取失败: ${errorMessage}`;
  }
}

// --------------------------------------------------------
// 节点 B: 工具执行节点 (修复：返回标准 ToolMessage 实例)
// --------------------------------------------------------
export async function executeToolsNode(
  state: typeof AgentState.State,
): Promise<Record<string, unknown>> {
  const lastMessage = state.messages[state.messages.length - 1];

  if (
    !AIMessage.isInstance(lastMessage) ||
    !lastMessage.tool_calls ||
    lastMessage.tool_calls.length === 0
  ) {
    return { messages: [] };
  }

  const toolOutputs: ToolMessage[] = [];
  let pendingDiffResult: string | null = null;

  for (const toolCall of lastMessage.tool_calls) {
    const args = toolCall.args as { filePath?: string; fileContent?: string };
    const filePath = args.filePath || "";
    const fileContent = args.fileContent || "";

    if (toolCall.name === "propose_file_change") {
      const result = await proposeCodeChange(filePath, fileContent);
      pendingDiffResult = result;
      toolOutputs.push(
        new ToolMessage({
          content: result,
          tool_call_id: toolCall.id ?? "",
          name: toolCall.name,
        }),
      );
    } else if (toolCall.name === "read_file_from_disk") {
      const result = await readFileFromLocalDisk(filePath);
      toolOutputs.push(
        new ToolMessage({
          content: result,
          tool_call_id: toolCall.id ?? "",
          name: toolCall.name,
        }),
      );
    }
  }

  return {
    messages: toolOutputs,
    pendingDiffResult,
  };
}
// --------------------------------------------------------
// ⚡ 新增节点 C: Token 智能化压缩与滚动摘要节点
// --------------------------------------------------------
export async function summarizeHistoryNode(
  state: typeof AgentState.State,
): Promise<Record<string, unknown>> {
  const messages = state.messages || [];
  const summary = state.summary || "";

  // 🎯 优化一：【数量水位线哨兵】
  // 如果当前总消息数还没有超过 14 条（或者你指定的 MAX_CONTEXT_MESSAGES），
  // 证明上下文非常轻量，不需要做任何压缩，直接 0 毫秒闪回通过！
  if (messages.length < 14) {
    return {};
  }

  // 只有在消息爆满时，才裁剪最老的 4 条消息进行摘要融合
  const messagesToSummarize = messages.slice(0, 4);

  const summaryPrompt = `
    你是一个记忆管理专家。请根据现有的摘要内容以及新提供的对话历史，将它们融合成一段最新、最精炼的中文上下文大纲。
    要求：保留所有关键的工程进展、讨论过的文件名和核心结论，去除寒暄。字数控制在 200 字以内。

    [当前已有历史摘要]:
    ${summary || "暂无历史摘要"}

    [需要加入的新对话历史]:
    ${JSON.stringify(
      messagesToSummarize.map((m) => ({
        role: m._getType(),
        content: m.content,
      })),
      null,
      2,
    )}
  `;

  try {
    const res = await fetch(QWEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "qwen3.7-max-2026-06-08",
        messages: [{ role: "user", content: summaryPrompt }],
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`Summary API HTTP error! status: ${res.status}`);
    }

    const result = (await res.json()) as QwenSummaryResponse;
    const nextSummary = result.choices?.[0]?.message?.content || summary;

    // 构造 LangGraph 的老消息清除指令
    const deletionMessages = messagesToSummarize
      .map((m) => {
        const id = m.id;
        return id ? new RemoveMessage({ id }) : null;
      })
      .filter((m): m is RemoveMessage => m !== null);

    return {
      messages: deletionMessages,
      summary: nextSummary,
    };
  } catch (error) {
    console.error("⚠️ Token 摘要压缩失败，跳过此次压缩:", error);
    return {};
  }
}
