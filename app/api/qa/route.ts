import { NextResponse } from "next/server";

export const runtime = "nodejs";

const QWEN_STREAM_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

type ChatMessage = { role: "user" | "assistant"; content: string };
type StreamChunk = {
  choices?: Array<{ delta?: { content?: string; reasoning_content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

export async function POST(request: Request): Promise<Response> {
  const apiKey = request.headers.get("x-dashscope-api-key") || process.env.DASHSCOPE_API_KEY;
  const model = request.headers.get("x-dashscope-model") || "qwen3.7-max-2026-05-20";
  if (!apiKey) return NextResponse.json({ error: "Missing DASHSCOPE_API_KEY" }, { status: 500 });

  const { messages } = (await request.json()) as { messages?: ChatMessage[] };
  if (!messages?.length) return NextResponse.json({ error: "Messages are required" }, { status: 400 });

  const upstream = await fetch(QWEN_STREAM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        {
          role: "system",
          content: "你是独立的问答 Agent,是一个百宝箱，无所不知。直接、准确地回答用户问题；仅在确实能帮助理解时提供简短推理，不调用文件、终端或项目工具。",
        },
        ...messages,
      ],
    }),
  });
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: await upstream.text() || "QA model request failed" }, { status: upstream.status || 502 });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body!.getReader();
      let buffer = "";
      let reasoningOpen = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload) as StreamChunk;
              if (chunk.usage) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "USAGE", content: { prompt: chunk.usage.prompt_tokens || 0, completion: chunk.usage.completion_tokens || 0, total: chunk.usage.total_tokens || 0 } })}\n\n`));
              }
              const delta = chunk.choices?.[0]?.delta;
              let content = "";
              if (delta?.reasoning_content) {
                if (!reasoningOpen) {
                  content += "<INTERNAL_THINK_START>";
                  reasoningOpen = true;
                }
                content += delta.reasoning_content;
              }
              if (delta?.content) {
                if (reasoningOpen) {
                  content += "<INTERNAL_THINK_END>";
                  reasoningOpen = false;
                }
                content += delta.content;
              }
              if (content) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "TEXT", content })}\n\n`));
            } catch {
              // Ignore malformed keepalive chunks from the upstream SSE stream.
            }
          }
        }
        if (reasoningOpen) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "TEXT", content: "<INTERNAL_THINK_END>" })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
