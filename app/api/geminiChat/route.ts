/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

export const runtime = "nodejs";

// ⚠️【重要：请核对你的梯子端口】如果是 Clash 默认通常是 7890，v2ray 通常是 10809
// 把顶部的代理配置改成这样：
const MY_PROXY_PORT = "7890"; 

// 显式指定 http 协议头，有时候能解决 node-fetch 的握手失败问题
const proxyUrl = `http://127.0.0.1:${MY_PROXY_PORT}`; 

const agent = process.env.NODE_ENV === "development" 
  ? new HttpsProxyAgent(proxyUrl, {
      keepAlive: true, // 🔥 让连接保持活跃，防止被代理软件中途切断
    }) 
  : undefined;
type ChatMessage = { role: "user" | "assistant"; content: string };
type GeminiPart = { text?: string };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
type GeminiStreamChunk = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
};

const MODEL = "gemini-2.5-flash";
const GEMINI_STREAM_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=${process.env.GEMINI_API_KEY}`;

function toGeminiContent(message: ChatMessage): GeminiContent {
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  };
}

// 🚀 发起流式请求（去掉了内部硬超时，防止长文本被误杀）
async function requestGeminiStreamFetch(contents: GeminiContent[]) {
  const body = JSON.stringify({
    contents,
    systemInstruction: {
      parts: [
        {
          text: `You are Gemini 2.5 Flash, a large language model trained by Google. Respond in the language used by the user (default to Chinese if the user speaks Chinese). Keep answers clear, accurate, and concise.
          Core Persona:
          - You are a Senior Frontend Engineer with 7 years of experience, specialized in the React ecosystem (React 16/18, Next.js).
          - You are also proficient in modern frontend technologies including Vue 2/3, Flutter, Taro, and Electron.
          - You have solid backend experience and can build reliable APIs using NestJS and Express.
          - You are an expert in relational and non-relational databases, highly skilled in writing and optimizing complex queries for MySQL, PostgreSQL, and Redis.
          Behavioral Guidelines:
          - Act as a senior technical collaborator. Provide clean, production-ready code snippets and practical architecture advice.
          - When asked about your model version or identity, confidently state that you are Gemini 2.5 Flash.`,
        },
      ],
    },
  });

  console.log("📡 [Gemini] 正在通过代理发起流式文本生成请求...");
  
  const response = await fetch(GEMINI_STREAM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no", 
    },
    body,
    agent, 
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini HTTP ${response.status}: ${errText}`);
  }

  return response;
}

function getSafeStructure(messages: ChatMessage[]): ChatMessage[] {
  const trimmed = messages.filter((m) => m.content && m.content.trim());
  while (trimmed.length > 0 && trimmed[0].role === "assistant") trimmed.shift();
  if (trimmed.length === 0) return [];

  const validated: ChatMessage[] = [];
  for (const msg of trimmed) {
    if (validated.length === 0) {
      validated.push(msg);
      continue;
    }
    const lastMsg = validated[validated.length - 1];
    if (lastMsg.role === msg.role) {
      lastMsg.content += "\n" + msg.content;
    } else {
      validated.push(msg);
    }
  }
  while (validated.length > 0 && validated[validated.length - 1].role === "assistant") validated.pop();
  return validated;
}

// 通过本地字数平替 Token 裁剪，安全高效
function truncateByLocalLength(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  let totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  while (totalChars > maxChars && messages.length > 2) {
    const removed1 = messages.shift();
    const removed2 = messages.shift();
    totalChars -= (removed1?.content.length || 0) + (removed2?.content.length || 0);
  }
  return messages;
}

export async function POST(req: Request) {
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "Missing GEMINI_API_KEY" }, { status: 500 });
  }

  try {
    const { messages } = (await req.json()) as { messages?: ChatMessage[] };
    if (!messages || messages.length === 0) {
      return NextResponse.json({ error: "Messages array is empty" }, { status: 400 });
    }

    // 1. 结构规范化
    let cleanMessages = getSafeStructure(messages);
    if (cleanMessages.length === 0) {
      return NextResponse.json({ error: "Invalid messages structure" }, { status: 400 });
    }

    // 2. 纯本地高效字数裁剪（把长对话限制在 5 万字以内，绝对不会爆模型上下文）
    cleanMessages = truncateByLocalLength(cleanMessages, 50_000);

    // 3. 直接发起流式请求（不再调用坑人的 countTokens，省下一半的配额和网络开销！）
    const geminiResponse = await requestGeminiStreamFetch(cleanMessages.map(toGeminiContent));
    console.log("✅ [Gemini] 成功建立流式连接，开始桥接数据...");
    
    const encoder = new TextEncoder();
    
    const outputStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        let buffer = "";

        if (!geminiResponse.body) {
          controller.close();
          return;
        }

        geminiResponse.body.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf-8");
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;

            const dataJson = trimmed.slice("data:".length).trim();
            if (dataJson === "[DONE]") continue;

            try {
              const parsed = JSON.parse(dataJson) as GeminiStreamChunk;
              const candidate = parsed.candidates?.[0];
              
              if (candidate?.finishReason && candidate.finishReason !== "STOP") {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(`[AI 拒绝回答: ${candidate.finishReason}]`)}\n\n`));
                continue;
              }

              const text = (candidate?.content?.parts?.map((part) => part.text ?? "").join("")) ?? "";
              if (text) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(text)}\n\n`));
              }
            } catch (e) {
              // 忽略个别非标准流解析错
            }
          }
        });

        geminiResponse.body.on("end", () => {
          controller.close();
        });

        geminiResponse.body.on("error", (err) => {
          console.error("[流内部中断]:", err);
          controller.close();
        });
      }
    });

    return new Response(outputStream, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });

  } catch (error: any) {
    console.error("[Gemini 路由致命错误]:", error);
    if (error?.message?.includes("429") || error?.message?.includes("RESOURCE_EXHAUSTED")) {
      return NextResponse.json(
        { error: "RATE_LIMIT_EXCEEDED", message: "谷歌免费版限制太严格了，请等待 30 秒等额度刷新后再试。" },
        { status: 429 }
      );
    }
    return NextResponse.json(
      { error: "INTERNAL_SERVER_ERROR", message: error?.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}