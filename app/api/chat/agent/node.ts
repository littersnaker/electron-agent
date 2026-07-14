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
  const model = state.model;
  // 只保留 user/assistant 消息，排除 ToolMessage，避免历史工具结果强制触发新工具调用
  const recentMessages = state.messages
    .filter((m) => m._getType() !== "tool")
    .slice(-6);

  const firstStageContext = [
    {
      role: "system",
      content: `You are an autonomous coding agent.
            Current Working Directory: ${state.workingDir || "未指定，默认使用项目启动目录"}
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
    【核心指令】
1. 当用户让你分析代码、查看项目结构或寻找特定文件时（例如问“说一下主进程代码和next的页面结构”），你【绝对禁止】在文本回复中口头承诺“让我查看...”、“接下来我将去读取...”等废话。
2. 你必须【立刻、马上】调用对应的工具（如 list_directory 查看目录，或 read_file_from_disk 读取文件）。
3. 只有当你已经通过工具链获取了所有必要的代码上下文、能够完全回答用户的问题时，你才允许不调用工具并给出最终结论。
4. 记住：你的行动力体现在调用工具上，而不是在文本里说空话。
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
      model: model,
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

async function getCodeOutline(
  filePath: string,
  workingDir: string,
): Promise<string> {
  try {
    const safePath = await getSafePath(filePath, workingDir);
    if (!fs.existsSync(safePath))
      return `❌ 未找到文件: ${workingDir || filePath}`;

    const content = fs.readFileSync(safePath, "utf-8");
    const lines = content.split("\n");
    const outline: string[] = [];

    lines.forEach((line, index) => {
      // 匹配前端常用的 export, function, class, interface, type, 以及主进程的 ipcMain 监听等关键行
      if (
        /^\s*(export\s+)?(function|class|interface|enum|type)\b/.test(line) ||
        /^\s*(export\s+)?const\s+\w+\s*=\s*(\(|async)/.test(line) ||
        /ipcMain\.(on|handle)/.test(line)
      ) {
        outline.push(`Line ${index + 1}: ${line.trim()}`);
      }
    });

    return outline.length > 0
      ? `📄 [${workingDir || filePath}] 代码结构大纲:\n${outline.join("\n")}`
      : `📄 [${workingDir || filePath}] 未检测到明显的顶层导出或方法定义（可能全是内联配置）。`;
  } catch (error) {
    return `❌ 提取大纲失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}
// --------------------------------------------------------
// 磁盘物理辅助操作
// --------------------------------------------------------
// async function proposeCodeChange(
//   filePath: string,
//   fileContent: string,
//   workingDir: string
// ): Promise<string> {
//   try {
//     const rootPath = workingDir || process.cwd();
//     const safePath = path.join(
//       rootPath,
//       filePath.startsWith("./") ? filePath : path.join("./", filePath),
//     );
//     if (!fs.existsSync(safePath)) {
//       fs.writeFileSync(safePath, fileContent, "utf-8");
//       return JSON.stringify({ msg: `🆕 成功新建了文件：${filePath}` });
//     }
//     const pendingPath = `${safePath}.pending`;
//     fs.writeFileSync(pendingPath, fileContent, "utf-8");
//     return JSON.stringify({
//       type: "DIFF_READY",
//       payload: {
//         original: filePath,
//         pending: `${filePath}.pending`,
//         message: "我已将修改生成在 .pending 文件中",
//       },
//     });
//   } catch (error: unknown) {
//     const errorMessage = error instanceof Error ? error.message : String(error);
//     return `❌ 计算补丁失败: ${errorMessage}`;
//   }
// }
async function getSafePath(
  filePath: string,
  workingDir: string,
): Promise<string> {
  const rootPath = workingDir || process.cwd(); // ⚡ 核心替换
  const normalizedPath = filePath.replace(/^(\.\/|\/)/, "");
  return path.join(rootPath, normalizedPath);
}

async function readFileFromLocalDisk(
  filePath: string,
  workingDir: string,
): Promise<string> {
  try {
    const safePath = await getSafePath(filePath, workingDir);
    if (!fs.existsSync(safePath))
      return `❌ 未找到文件: ${workingDir || filePath}`;
    return fs.readFileSync(safePath, "utf-8");
  } catch (error: unknown) {
    return `❌ 读取失败: ${error}`;
  }
}
async function listDirectory(
  dirPath = ".",
  workingDir: string,
): Promise<string> {
  try {
    const rootPath = workingDir || process.cwd();
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
async function searchCodebase(
  keyword: string,
  workingDir: string,
): Promise<string> {
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
              results.push(
                path.relative(workingDir || process.cwd(), fullPath),
              );
            }
          } catch {}
        }
      }
    }

    walk(workingDir || process.cwd());

    return JSON.stringify(results, null, 2);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return `❌ 搜索失败: ${errorMessage}`;
  }
}
async function runTerminalCommand(
  command: string,
  workingDir: string,
): Promise<string> {
  try {
    const result = execSync(command, {
      cwd: workingDir || process.cwd(), // ⚡ 核心替换
      encoding: "buffer",
      timeout: 15000,
    });
    return result.toString("utf-8");
  } catch (error: unknown) {
    return String(error);
  }
}
async function getDiff(filePath: string, workingDir: string): Promise<string> {
  try {
    const original = path.join(workingDir || process.cwd(), filePath);

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
async function applyFileChange(
  filePath: string,
  workingDir: string,
): Promise<string> {
  const original = path.join(workingDir || process.cwd(), filePath);

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
  workingDir: string,
): Promise<string> {
  try {
    const safePath = await getSafePath(filePath, workingDir);

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
  const currentWorkingDir = state.workingDir || process.cwd(); // 取出工作目录
  for (const toolCall of lastMessage.tool_calls) {
    const args = toolCall.args as Record<string, string>;
    const filePath = args.filePath || "";
    const fileContent = args.fileContent || "";
    let result = "";
    switch (toolCall.name) {
      case "propose_file_change":
        result = await proposeFileChange(
          filePath,
          fileContent,
          currentWorkingDir,
        );
        toolOutputs.push(
          new ToolMessage({
            content:
              typeof result === "string" ? result : JSON.stringify(result),
            tool_call_id: toolCall.id ?? "unknown_id",
            name: toolCall.name,
          }),
        );
        // 自动追加 Diff 检查
        const diff = await getDiff(filePath, currentWorkingDir);
        toolOutputs.push(
          new ToolMessage({
            content: diff,
            tool_call_id: `${toolCall.id}-diff`,
            name: "get_diff",
          }),
        );
        break;
      case "list_directory":
        result = await listDirectory(args.dirPath || ".", currentWorkingDir);
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
        result = await searchCodebase(args.keyword || "", currentWorkingDir);
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
        result = await applyFileChange(filePath, currentWorkingDir);
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
        result = await runTerminalCommand(
          args.command || "",
          currentWorkingDir,
        );
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
        result = await readFileFromLocalDisk(filePath, currentWorkingDir);
        toolOutputs.push(
          new ToolMessage({
            content:
              typeof result === "string" ? result : JSON.stringify(result),
            tool_call_id: toolCall.id ?? "unknown_id",
            name: toolCall.name,
          }),
        );
        break;
      // 💡 【核心补全 1】: 补全获取本地时间
      case "get_local_time":
        result = new Date().toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
        });
        toolOutputs.push(
          new ToolMessage({
            content: `当前系统时间: ${result}`,
            tool_call_id: toolCall.id ?? "unknown_id",
            name: toolCall.name,
          }),
        );
        break;

      // 💡 【核心补全 3】: 新增大纲技能的物理响应
      case "get_code_outline":
        result = await getCodeOutline(filePath, currentWorkingDir);
        toolOutputs.push(
          new ToolMessage({
            content: result,
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
  const modelel = state.model;
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
    4. 用户当前的需求
    
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
        model: modelel,
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
  const model = state.model;
  const summary = state.summary;
  // 增加防御性判断
  if (!summary) return { messages: [] };

  // 💡 【核心修复点 1】：从整个消息历史中，精准捞出用户最后一次提问的真实内容
  const humanMessages = state.messages.filter((m) => m._getType() === "human");
  const lastUserQuery =
    humanMessages.length > 0
      ? humanMessages[humanMessages.length - 1].content
      : "分析项目结构";

  try {
    const res = await fetch(QWEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: "system",
            content: `你是一位卓越的高级全栈开发专家和编程助手。
            【意图分流与任务优先级】
在处理用户请求时，请始终遵循以下处理顺序：

1. 闲聊与常识判断：如果用户的问题属于闲聊、日常信息查询（如时间、天气、简单常识、问候），请直接使用通用知识库进行回复，严禁触发任何文件读取、项目分析或代码修改工具。
2. 复杂工程处理：仅当用户的问题涉及明确的编程、架构修改、项目结构分析或代码审查时，才允许进入代码工具调用链路。

【拒绝过度分析】
如果在处理简单问题时，你不需要工具即可给出准确答案，请直接给出结果。不要在回答中生成“项目结构扫描报告”、“摘要”或“思考过程”文档，保持回答的简洁和直接。
【触发修改、读取、分析、文件内容的时候】
1. 请结合工具调用后沉淀的【核心源码与结构摘要】，直接、具体、深刻地回答用户提出的技术问题。
2. 【绝对禁止】给出“泛泛的建议”、“后续步骤”或“宏观报告”等空洞废话。
3. 用户的目的不是要你评估项目，而是要你解答他的疑问。用户要你“说一下主进程代码”，你就必须根据摘要里的具体代码细节、文件名和逻辑，清晰地罗列并讲解出来。`,
          },
          {
            role: "user",
            content: `用户真实想问的问题是: "${lastUserQuery}"\n\n后台工具帮你扫描到的核心代码及结构摘要如下:\n${summary}`,
          },
        ],
        stream: false, // 保持非流式（或根据你的流式架构调整）
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("ReportNode API 报错:", errorText);
      return {};
    }

    const data = await res.json();
    const finalReply = data.choices?.[0]?.message?.content || "";

    // 💡 【核心修复点 2】：把大模型真正解答用户问题的文本作为 AIMessage 返回，流向 END
    return {
      messages: [new AIMessage({ content: finalReply })],
    };
  } catch (error) {
    console.error("❌ 报告节点炸了:", error);
    return {};
  }
}
