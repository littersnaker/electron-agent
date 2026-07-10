import {
  AIMessage,
  RemoveMessage,
  ToolMessage,
} from "@langchain/core/messages";
import fs from "fs";
import path from "path";
import { tools } from "../tools";
import { AgentState } from "./state";
import { execSync } from "child_process";
const QWEN_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

interface QwenMessageResponse {
  choices?: Array<{
    message?: {
      content: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
}
interface QwenSummaryResponse {
  choices?: Array<{ message?: { content: string | null } }>;
}

// --------------------------------------------------------
// 节点 A: 严格路由节点
// --------------------------------------------------------
export async function routerNode(
  state: typeof AgentState.State,
): Promise<Record<string, unknown>> {
  // 只保留 user/assistant 消息，排除 ToolMessage，避免历史工具结果强制触发新工具调用
  const recentMessages = state.messages
    .filter((m) => m._getType() !== "tool")
    .slice(-6);

  const firstStageContext = [
    {
      role: "system",
      content: `You are an autonomous coding agent.

            Role:
            Senior Full Stack Engineer.

            Capabilities:
            - Explore project structure
            - Search source code
            - Read files
            - Modify files
            - Execute commands
            - Analyze errors
            - Fix issues

            Tool Strategy:
            1. Unknown project? -> list_directory
            2. Unknown file location? -> search_codebase
            3. Before modifying code? -> read_file_from_disk
            4. Need code changes? -> propose_file_change
            5. Need validation? -> run_terminal_command

            Rules:
            - Never assume file contents.
            - Always inspect before modifying.
            - Prefer tool usage over guessing.
            - Continue using tools until enough information is gathered.
            - Return NO_TOOL only when no further tool usage is required and you have perfectly resolved the user's request.  

            CRITICAL RULES FOR RE-ROUTING:
            - Focus on the user's CURRENT request. If it is unrelated to previous tool calls or conversation history, return 'NO_TOOL'.
            - If the current request requires tools based on previous results or is a direct continuation, use the appropriate tool.
            - Only return 'NO_TOOL' when the user's CURRENT request has been fully addressed or clearly requires no tools.

            YOUR OUTPUT RULES:
          - If you have read a file and identified bugs, you MUST propose a change.
          - DO NOT just acknowledge that you read the file.
          - The user will see your final answer only if you call a tool or produce final text content.
          - If you stop without proposing a fix, you are failing your objective.

          INSTRUCTION:
    1. Analyze the user's CURRENT request against the conversation history.
    2. If the current request is new and unrelated to previous tool results, return 'NO_TOOL' immediately.
    3. If the current request requires further tools or is a direct follow-up, output the appropriate tool call.
    4. Only continue analyzing previous tool results if the user's current request explicitly references them.
                  `,
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
      model: "qwen3.7-plus-2026-05-26",
      messages: firstStageContext,
      tools: tools,
      tool_choice: "auto",
      stream: false,
    }),
  });

  const result = (await res.json()) as QwenMessageResponse;
  const assistantMessage = result.choices?.[0]?.message;

  if (assistantMessage?.tool_calls && assistantMessage.tool_calls.length > 0) {
    console.log(
      `🤖 [Router Node] 成功触发工具调用:`,
      assistantMessage.tool_calls.map((t) => t.function.name),
    );
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
      filePath.startsWith("./") ? filePath : path.join("./", filePath),
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
async function getSafePath(filePath: string): Promise<string> {
  const rootPath = process.cwd();
  // 强制移除开头的 ./ 或 /，确保它始终是相对于 rootPath 的
  const normalizedPath = filePath.replace(/^(\.\/|\/)/, "");
  return path.join(rootPath, normalizedPath);
}

async function readFileFromLocalDisk(filePath: string): Promise<string> {
  try {
    const safePath = await getSafePath(filePath); // 统一调用
    if (!fs.existsSync(safePath))
      return `❌ 未找到文件: ${filePath} (实际查找路径: ${safePath})`;
    return fs.readFileSync(safePath, "utf-8");
  } catch (error: unknown) {
    return `❌ 读取失败: ${error}`;
  }
}
async function listDirectory(dirPath = "."): Promise<string> {
  try {
    const rootPath = process.cwd();
    const targetDir = path.join(rootPath, dirPath);

    const files = fs.readdirSync(targetDir, {
      withFileTypes: true,
    });

    return JSON.stringify(
      files.map((item) => ({
        name: item.name,
        type: item.isDirectory() ? "directory" : "file",
      })),
      null,
      2,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return `❌ 读取目录失败: ${errorMessage}`;
  }
}
async function searchCodebase(keyword: string): Promise<string> {
  try {
    const results: string[] = [];

    function walk(dir: string) {
      const entries = fs.readdirSync(dir, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (
          ["node_modules", ".next", ".git", ".pnpm-store", "public"].includes(
            entry.name,
          )
        ) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          try {
            const content = fs.readFileSync(fullPath, "utf8");

            if (content.includes(keyword)) {
              results.push(path.relative(process.cwd(), fullPath));
            }
          } catch {}
        }
      }
    }

    walk(process.cwd());

    return JSON.stringify(results, null, 2);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return `❌ 搜索失败: ${errorMessage}`;
  }
}
async function runTerminalCommand(command: string): Promise<string> {
  try {
    const result = execSync(command, {
      cwd: process.cwd(),
      encoding: "buffer",
      timeout: 15000,
    });
    return result.toString("utf-8");
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
async function getDiff(filePath: string): Promise<string> {
  try {
    const original = path.join(process.cwd(), filePath);

    const pending = `${original}.pending`;

    if (!fs.existsSync(pending)) {
      return "No pending diff found";
    }

    const result = execSync(`git diff --no-index "${original}" "${pending}"`, {
      encoding: "utf8",
    });

    return result;
  } catch (error: unknown) {
    const err = error as {
      stdout?: string;
      message?: string;
    };

    return err.stdout ?? err.message ?? "Diff failed";
  }
}
async function applyFileChange(filePath: string): Promise<string> {
  const original = path.join(process.cwd(), filePath);

  const pending = `${original}.pending`;

  if (!fs.existsSync(pending)) {
    return "❌ pending 文件不存在";
  }

  fs.copyFileSync(pending, original);

  fs.unlinkSync(pending);

  return "✅ 修改已应用";
}
async function proposeFileChange(
  filePath: string,
  fileContent: string,
): Promise<string> {
  try {
    const safePath = await getSafePath(filePath);

    // 如果父目录不存在，先创建父目录（防止报错）
    const dir = path.dirname(safePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

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
    return `❌ 操作失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}
// --------------------------------------------------------
// 节点 B: 工具执行节点 (修复：返回标准 ToolMessage 实例)
// --------------------------------------------------------
export async function executeToolsNode(
  state: typeof AgentState.State,
): Promise<Record<string, unknown>> {
  const lastMessage = state.messages[state.messages.length - 1];
  console.log(
    "🔍 Execute Tools 节点被触发，当前最后一条消息类型:",
    lastMessage._getType(),
  );
  console.log("🔍 当前总结内容:", state.summary);

  if (!AIMessage.isInstance(lastMessage) || !lastMessage.tool_calls) {
    return { messages: [] };
  }

  const toolOutputs: ToolMessage[] = [];

  for (const toolCall of lastMessage.tool_calls) {
    const args = toolCall.args as Record<string, string>;
    const filePath = args.filePath || "";
    const fileContent = args.fileContent || "";
    let result = "";
    switch (toolCall.name) {
      case "propose_file_change":
        result = await proposeFileChange(filePath, fileContent);
        toolOutputs.push(
          new ToolMessage({
            content:
              typeof result === "string" ? result : JSON.stringify(result),
            tool_call_id: toolCall.id ?? "unknown_id",
            name: toolCall.name,
          }),
        );
        // 自动追加 Diff 检查
        const diff = await getDiff(filePath);
        toolOutputs.push(
          new ToolMessage({
            content: diff,
            tool_call_id: `${toolCall.id}-diff`,
            name: "get_diff",
          }),
        );
        break;
      case "list_directory":
        result = await listDirectory(args.dirPath || ".");
        toolOutputs.push(
          new ToolMessage({
            content:
              typeof result === "string" ? result : JSON.stringify(result),
            tool_call_id: toolCall.id ?? "unknown_id",
            name: toolCall.name,
          }),
        );
        break;
      case "search_codebase":
        result = await searchCodebase(args.keyword || "");
        toolOutputs.push(
          new ToolMessage({
            content:
              typeof result === "string" ? result : JSON.stringify(result),
            tool_call_id: toolCall.id ?? "unknown_id",
            name: toolCall.name,
          }),
        );
        break;
      case "apply_file_change":
        result = await applyFileChange(filePath);
        toolOutputs.push(
          new ToolMessage({
            content:
              typeof result === "string" ? result : JSON.stringify(result),
            tool_call_id: toolCall.id ?? "unknown_id",
            name: toolCall.name,
          }),
        );
        break;
      case "run_terminal_command":
        result = await runTerminalCommand(args.command || "");
        toolOutputs.push(
          new ToolMessage({
            content:
              typeof result === "string" ? result : JSON.stringify(result),
            tool_call_id: toolCall.id ?? "unknown_id",
            name: toolCall.name,
          }),
        );
        break;
      case "read_file_from_disk":
        result = await readFileFromLocalDisk(filePath);
        toolOutputs.push(
          new ToolMessage({
            content:
              typeof result === "string" ? result : JSON.stringify(result),
            tool_call_id: toolCall.id ?? "unknown_id",
            name: toolCall.name,
          }),
        );
        break;
      default:
        console.warn(`Unknown tool: ${toolCall.name}`);
    }
  }

  return { messages: toolOutputs };
}
// --------------------------------------------------------
// ⚡ 新增节点 C: Token 智能化压缩与滚动摘要节点
// --------------------------------------------------------
export async function summarizeHistoryNode(
  state: typeof AgentState.State,
): Promise<Record<string, unknown>> {
  const messages = state.messages || [];
  const summary = state.summary || "";
  const keepCount = 5; // 保留最近5条消息，确保文件读取内容不被删除
  if (messages.length <= keepCount) return {};

  if (state.messages.length < 5) {
    return { summary: state.summary };
  }

  // 1. 策略：保留最近的 keepCount 条消息（包含最后一次工具调用的往返）
  // 2. 策略：对 keepCount 条之前的消息进行摘要
  const messagesToSummarize = messages.slice(0, messages.length - keepCount);

  // ⚡ 核心修复：保护 ToolMessage 不被删除，确保文件读取结果保留
  if (messagesToSummarize.length === 0) return {};

  const summaryPrompt = `
    请精炼总结以下对话历史，重点保留：
    1. 文件读取的结果和关键内容
    2. 文件修改进度和bug修复结论
    3. 用户的原始请求和意图
    
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
        model: "qwen3.7-max-2026-05-20",
        messages: [{ role: "user", content: summaryPrompt }],
        stream: false,
      }),
    });
    if (!res.ok) {
      throw new Error(`Summary API HTTP error! status: ${res.status}`);
    }

    const result = (await res.json()) as QwenSummaryResponse;
    const nextSummary = result.choices?.[0]?.message?.content || state.summary;
    console.log("✅ 摘要生成成功:", nextSummary);

    // 构造删除指令：删除被选中进行摘要的那些消息（包括 ToolMessage）
    // ⚠️ 我们不再无差别保护 ToolMessage，而是在生成摘要时，让 AI 把 ToolMessage 的“结果”总结进去！
    const deletionMessages = messagesToSummarize
      .map((m) => (m.id ? new RemoveMessage({ id: m.id }) : null))
      .filter((m): m is RemoveMessage => m !== null);
    console.log("📝 摘要节点执行完毕，新摘要长度:", nextSummary.length);
    return {
      messages: deletionMessages,
      summary: nextSummary, // 工具执行结果的信息现在被塞进 summary 里了
    };
  } catch (error) {
    console.error("❌ 摘要节点炸了:", error); // 如果这里打印了错误，说明问题找到了！
    return {};
  }
}
export async function reportNode(state: typeof AgentState.State) {
  const summary = state.summary;
  // 增加防御性判断
  if (!summary) return { messages: [] };

  try {
    const res = await fetch(QWEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`, // 确保环境变量存在
      },
      body: JSON.stringify({
        model: "qwen3.7-max-2026-05-20", // 确保模型名称正确，之前你可能用了别的qwen3.6-plus
        messages: [
          {
            role: "system",
            content: "你是一位代码分析专家，请根据摘要给出建议。",
          },
          { role: "user", content: `摘要内容: ${summary}` },
        ],
        stream: false, // 强制非流式
      }),
    });

    // 1. 必须先检查 res.ok
    if (!res.ok) {
      const errorText = await res.text();
      console.error("ReportNode API Error:", errorText);
      return {
        messages: [new AIMessage("分析总结生成失败，请检查 API 配置。")],
      };
    }

    // 2. 只有确认是 JSON 才解析
    const data = await res.json();

    // 3. 安全提取内容
    const content = data.choices?.[0]?.message?.content || "无法生成详细建议。";

    return {
      messages: [new AIMessage(content)],
    };
  } catch (error) {
    console.error("ReportNode Exception:", error);
    return { messages: [new AIMessage("分析总结过程出现异常。")] };
  }
}
