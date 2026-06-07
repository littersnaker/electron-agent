/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execSync } from "child_process"; // ⚡ 新增：用于调用系统原生的 git diff 命令
import { tools } from "./tools";
export const runtime = "nodejs";

const QWEN_STREAM_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    .trim()
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "");
const MODEL_NAME = "qwen3.6-flash-2026-04-16";
const FRIST_MODEL_NAME = "qwen3.6-flash";

// 2. ⚡ 核心改动：不再直接覆盖原文件，而是生成 .pending 文件并计算出 Git 风格的 Diff
async function proposeCodeChange(
  filePath: string,
  fileContent: string,
): Promise<string> {
  try {
    const rootPath = process.cwd();
    const hasSrcDir = fs.existsSync(path.join(rootPath, "src"));
    let finalizedPath = filePath;

    if (!hasSrcDir && filePath.startsWith("src/")) {
      finalizedPath = filePath.replace(/^src\//, "");
    } else if (
      hasSrcDir &&
      !filePath.startsWith("src/") &&
      !filePath.startsWith("app/")
    ) {
      finalizedPath = path.join("src", filePath);
    }

    const safePath = path.join(rootPath, finalizedPath);
    if (!safePath.startsWith(rootPath)) {
      return "🚨 安全警告：拒绝操作项目外部路径！";
    }

    // 🌟 1. 绝对不要动原文件本身（保持 safePath 干净，Next.js 绝对不会报错白屏！）
    if (!fs.existsSync(safePath)) {
      // 如果原文件不存在，直接创建
      fs.writeFileSync(safePath, fileContent, "utf-8");
      return JSON.stringify({ msg: `🆕 成功为您新建了文件：${finalizedPath}` });
    }

    // 🌟 2. 我们把 AI 生成的新代码，老老实实写进扩展名为 `.pending` 的镜像文件里
    const pendingPath = `${safePath}.pending`;
    fs.writeFileSync(pendingPath, fileContent, "utf-8");
    console.log(`✨ [Agent 差异生成成功] 已写入 ${finalizedPath}.pending`);

    // 🌟 3. 返回给大模型极度明确的引导话术，让它在前端聊天框里手把手教用户怎么点开对比
    return JSON.stringify({
      type: "DIFF_READY",
      payload: {
        original: finalizedPath,
        pending: `${finalizedPath}.pending`,
        message: "我已将修改生成在 .pending 文件中，请点击下方按钮对比。",
      },
    });
  } catch (error: any) {
    console.error("🚨 proposeCodeChange 崩溃:", error);
    return `❌ 计算补丁失败: ${error?.message}`;
  }
}
// 后端真实的读盘业务函数
async function readFileFromLocalDisk(filePath: string): Promise<string> {
  try {
    const rootPath = process.cwd();
    const hasSrcDir = fs.existsSync(path.join(rootPath, "src"));
    let finalizedPath = filePath;

    if (!hasSrcDir && filePath.startsWith("src/")) {
      finalizedPath = filePath.replace(/^src\//, "");
    } else if (
      hasSrcDir &&
      !filePath.startsWith("src/") &&
      !filePath.startsWith("app/")
    ) {
      finalizedPath = path.join("src", filePath);
    }

    let safePath = path.join(rootPath, finalizedPath);
    if (
      !fs.existsSync(safePath) &&
      fs.existsSync(path.join(rootPath, filePath))
    ) {
      safePath = path.join(rootPath, filePath);
      finalizedPath = filePath;
    }

    if (!safePath.startsWith(rootPath)) {
      return "🚨 安全警告：拒绝读取项目外部路径！";
    }

    if (!fs.existsSync(safePath)) {
      return `❌ 读取失败：在项目中未找到文件 "${finalizedPath}"。`;
    }

    const fileContent = fs.readFileSync(safePath, "utf-8");
    console.log(`📖 [物理读盘完成] 成功读取文件: ${finalizedPath}`);
    return fileContent;
  } catch (error: any) {
    return `❌ 读取失败: ${error?.message}`;
  }
}

export async function POST(req: Request) {
  if (!process.env.DASHSCOPE_API_KEY) {
    return NextResponse.json(
      { error: "Missing DASHSCOPE_API_KEY" },
      { status: 500 },
    );
  }

  try {
    const { messages } = await req.json();
    if (!messages || messages.length === 0) {
      return NextResponse.json(
        { error: "Messages array is empty" },
        { status: 400 },
      );
    }

    const currentDate = new Date();
    const timeString = currentDate.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
    });

    // 🧠 提示词深度升级：明确禁止盲写，强制要求输出 \`\`\`diff
    //     const systemMessage = {
    //   role: "system",
    //   content: `You are an AI code completion engine.
    // [IDENTITY]
    // - You are specialized in React, Next.js, and TypeScript.
    // - You are working in a local development environment.

    // [OPERATIONAL GUIDELINES]
    // 1. ONLY use 'read_file_from_disk' if you need to understand existing code.
    // 2. ONLY use 'propose_file_change' IF AND ONLY IF the user explicitly asks to modify, refactor, or fix a specific file.
    // 3. If the user asks for analysis, explanation, or general questions, DO NOT call 'propose_file_change'. Provide a direct text response instead.

    // [STREAMING BEHAVIOR]
    // - After any tool execution, you MUST provide a summary of your action in Chinese.
    // - If you did NOT call 'propose_file_change', simply provide a helpful, concise answer to the user's question.

    // [FORMATTING]
    // - Always answer the user in Chinese.
    // - Be concise, professional, and accurate.`
    // };
    const systemMessage = {
      role: "system",
      content: `You are a professional AI software engineering assistant.   
  [CORE RESPONSIBILITIES] 
  1. ONLY use 'propose_file_change' when the user explicitly asks to modify, refactor, or create a file. Do NOT call it for reading or analysis. 
  2. ONLY use 'read_file_from_disk' or 'read_pdf_from_disk' when the user requests content or analysis of existing files. 
  3. ONLY use 'get_local_time' when the user asks for the current time, date, or time-sensitive information.
  4. For all other general inquiries, provide a direct text response without calling any tools.  
  
  [INTERACTION PROTOCOL] 
  - Respond in Chinese unless requested otherwise. 
  - After any tool execution, provide a concise summary of the action performed. 
  - Do NOT output full code blocks in chat; always use 'propose_file_change' to submit file modifications. 
  - Maintain a professional, concise, and highly accurate tone.`,
    };
    // 只保留最近的 6 条消息（3轮对话），防止 Context 爆炸
    const recentMessages = messages.slice(-6);
    const currentContext = [systemMessage, ...recentMessages];
    // const currentContext = [systemMessage, ...messages];

    console.log(`📡 [代码 Agent] 正在分析用户需求...`);
    // ⚡ 新增：为第一阶段专门克隆一份消息，并加上强硬的“闭嘴指令”
    const firstStageContext = [
      {
        role: "system",
        content: `You are a STRICT routing module. Your ONLY job is to evaluate if the user's latest request requires a tool call. 
    1. If YES, call the relevant tool. 
    2. If NO, output EXACTLY AND ONLY the string 'NO_TOOL'. 
    CRITICAL: DO NOT act as an AI assistant. DO NOT answer the user's question. DO NOT provide any text or explanation. ONLY output 'NO_TOOL' or trigger a tool.`,
      },
      {
        role: "user",
        // 我们不再按照一来一回的格式传消息，而是把历史记录当成一段纯文本数据塞给它
        content: `Analyze the following conversation history and decide if the user's LAST message requires a tool call.\n\n<conversation_history>\n${JSON.stringify(recentMessages, null, 2)}\n</conversation_history>\n\nAction required: If a tool is needed, call it. If not, output 'NO_TOOL' now.`,
      },
    ];

    console.log("输入字符数:", JSON.stringify(firstStageContext).length);
    const firstResponse = await fetch(QWEN_STREAM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      },
      body: JSON.stringify({
        model: FRIST_MODEL_NAME,
        messages: firstStageContext,
        tools: tools,
        tool_choice: "auto",
        stream: false,
      }),
    });

    if (!firstResponse.ok) {
      const errText = await firstResponse.text();
      throw new Error(
        `Qwen API First-stage HTTP ${firstResponse.status}: ${errText}`,
      );
    }

    const firstResult = await firstResponse.json();
    const assistantMessage = firstResult.choices?.[0]?.message;
    console.log("👉 第一阶段 AI 实际文本回复：", assistantMessage?.content);

    if (
      assistantMessage?.tool_calls &&
      assistantMessage.tool_calls.length > 0
    ) {
      currentContext.push(assistantMessage);

      for (const toolCall of assistantMessage.tool_calls) {
        // ⚡ 核心逻辑分支替换：执行 Diff 生成提案
        if (toolCall.function.name === "propose_file_change") {
          console.log(
            `🛠️ [工具触发] 发现 AI 正在创建重构提议并计算 Diff 差异...`,
          );
          const args = JSON.parse(toolCall.function.arguments);
          const proposeResult = await proposeCodeChange(
            args.filePath,
            args.fileContent,
          );

          currentContext.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: proposeResult,
          });
        } else if (toolCall.function.name === "read_file_from_disk") {
          console.log(`🔍 [工具触发] 发现 AI 正在尝试读取你的本地文件资产...`);
          const args = JSON.parse(toolCall.function.arguments);
          const readResult = await readFileFromLocalDisk(args.filePath);

          currentContext.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: readResult,
          });
        } else if (toolCall.function.name === "get_local_time") {
          console.log(`⏰ [工具触发] 发现 AI 正在尝试获取本地时间...`);
          const localTime = new Date().toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
            timeZoneName: "short",
          });
          currentContext.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: localTime,
          });
        }
      }
      console.log(
        `✅ [物理比对完成] 补丁就绪，切换至流式，让 AI 汇报 Diff 视图...`,
      );
    } else {
      console.log(`💬 [普通对话] AI 选择直接通过文本回答，未触发文件操作。`);
    }

    // ========================================================
    // 阶段二：流式文本生成阶段 (输出精美的 markdown diff 视图)
    // ========================================================
    const controllerWithTimeout = new AbortController();
    const timeoutId = setTimeout(() => controllerWithTimeout.abort(), 160000); // 160s 超时
    try {
      const response = await fetch(QWEN_STREAM_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          messages: currentContext,
          stream: true,
        }),
        signal: controllerWithTimeout.signal, // ⚡ 绑定信号
      });

      clearTimeout(timeoutId); // 成功建立连接，清除定时器

      if (!response.ok)
        throw new Error(
          `Second-stage Stream failed with status ${response.status}`,
        );
      if (!response.body) throw new Error("Response Body is null");

      if (!response.ok) throw new Error("Second-stage Stream failed");
      if (!response.body) throw new Error("Response Body is null");

      const encoder = new TextEncoder();
      const decoder = new TextDecoder("utf-8");
      const reader = response.body.getReader();

      const outputStream = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(": connected\n\n"));

          // 🌟 1. 检查上下文，如果刚刚执行了工具，先发送补丁就绪信号
          const lastToolCall = assistantMessage?.tool_calls?.[0];
          if (lastToolCall?.function.name === "propose_file_change") {
            // 解析之前保存的补丁结果
            const toolResult = currentContext.find(
              (m) => m.role === "tool",
            )?.content;
            if (toolResult) {
              // 发送特定的补丁就绪指令给前端
              controller.enqueue(encoder.encode(`data: ${toolResult}\n\n`));
            }
          }

          let buffer = "";
          try {
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
                  const parsed = JSON.parse(dataJson);
                  const text = parsed.choices?.[0]?.delta?.content || "";
                  if (text) {
                    // 2. 将文本回复封装为 TEXT_CHUNK
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify({ type: "TEXT", content: text })}\n\n`,
                      ),
                    );
                  }
                } catch (e) {}
              }
            }
          } finally {
            controller.close();
            reader.releaseLock();
          }
        },
      });
      // 🌟 【关键修复】确保这里直接返回了 Response，且没有在其他地方提前 return
      return new Response(outputStream, {
        headers: {
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Accel-Buffering": "no",
        },
      });
    } catch (fetchError: any) {
      clearTimeout(timeoutId);

      // 如果是被我们手动 abort 的，或者是原生的 timeout
      if (
        fetchError.name === "AbortError" ||
        fetchError.code === "UND_ERR_HEADERS_TIMEOUT"
      ) {
        console.error(
          "🚨 阶段二大模型响应头接收超时，可能是模型生成 Diff 耗时过长或网络拥堵。",
        );
        throw new Error("大模型响应超时，请稍后重试。");
      }
      throw fetchError;
    }
  } catch (error: any) {
    console.error("❌ [致命错误]:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: error?.message },
      { status: 500 },
    );
  }
}
