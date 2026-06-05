"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type AttachedFile = {
  name: string;
  type: string;
  base64: string;
  textContent?: string;
};
const STORAGE_KEY = "gemini-chat-messages";
const MAX_CONTEXT_MESSAGES = 24;
const starterMessages: Message[] = [
  {
    role: "assistant",
    content:
      "Hi, I am your chat assistant. Ask me anything, or upload an image/document!",
  },
];

export default function Home() {
  const [messages, setMessages] = useState<Message[]>(starterMessages);
  const [input, setInput] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [attachedFile, setAttachedFile] = useState<AttachedFile | null>(null);
  const [isParsingFile, setIsParsingFile] = useState(false);
  const isFetchingRef = useRef(false);
  const finalTextRef = useRef("");
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    function loadMessages() {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as Message[];
          setMessages(parsed);
        } catch (e) {
          console.error("Failed to parse stored messages:", e);
          setMessages(starterMessages);
        }
      }
      setIsLoaded(true);
    }

    loadMessages();
  }, []);

  // 核心逻辑：当消息更新且正在流式传输时，强行滚动到最底部
  useEffect(() => {
    if (isStreaming && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({
        index: messages.length - 1,
        align: "end",
        behavior: "auto", // 流式传输用 auto 紧跟速度，用 smooth 会有延迟感
      });
    }
  }, [messages, isStreaming]);
  useEffect(() => {
    if (!isLoaded) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  }, [isLoaded, messages]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsParsingFile(true);
    console.log(`📁 选中文件: ${file.name} (${file.type}, ${file.size} bytes)`);
    try {
      // ======== 分支 1：处理图片类型 (保持原样，用于图片预览和多模态输入) ========
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = (event) => {
          setAttachedFile({
            name: file.name,
            type: file.type,
            base64: event.target?.result as string,
          });
          setIsParsingFile(false);
        };
        reader.onerror = () => {
          console.error("图片读取失败");
          setIsParsingFile(false);
        };
        reader.readAsDataURL(file);
        return; // 处理完毕，直接拦截返回
      }

      // ======== 分支 2：⚡ 核心新增：前端直接深度解析 PDF ========
      if (file.type === "application/pdf") {
        // 1. 动态引入 pdfjs-dist，防止大库拖慢首页首屏加载速度
        const pdfjsLib = await import("pdfjs-dist");

        // 2. 配置浏览器专用的 Worker CDN（自动匹配你本地安装的 pdfjs-dist 版本）
        // 注意：如果你安装的是较老的 v3.x 版本，请把末尾的 .mjs 改为 .js
        pdfjsLib.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

        // 3. 将文件读取为二进制 ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();

        // 4. 加载 PDF 文档
        const loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(arrayBuffer),
        });
        const pdf = await loadingTask.promise;

        // 5. 循环提取每一页的文本
        let fullText = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const tokenizedText = await page.getTextContent();
          const pageText = tokenizedText.items
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((item: any) => item.str)
            .join(" ");
          fullText += pageText + "\n";
        }
        console.log(`📄 PDF 解析完成，提取文本长度: ${fullText.length} ${fullText} characters`);
        // 6. 将提取出来的纯文本塞进状态机，传给后端
        setAttachedFile({
          name: file.name,
          type: file.type,
          base64: "", // 非图片不需要 base64
          textContent: fullText.trim() || "（未读取到有效文本）",
        });

        setIsParsingFile(false);
        return; // 处理完毕，直接拦截返回
      }

      // ======== 分支 3：处理普通文本文件 (如 .txt, .md, .json) ========
      const textReader = new FileReader();
      textReader.onload = (textEvent) => {
        setAttachedFile({
          name: file.name,
          type: file.type,
          base64: "",
          textContent: textEvent.target?.result as string,
        });
        setIsParsingFile(false);
      };
      textReader.onerror = () => {
        console.error("文本文件读取失败");
        setIsParsingFile(false);
      };
      textReader.readAsText(file);
    } catch (error) {
      console.error("前端解析文件发生致命错误:", error);
      setIsParsingFile(false);
    }
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const textContent = input.trim();
    if ((!textContent && !attachedFile) || isStreaming || isParsingFile) return;

    let combinedText = textContent;
    if (attachedFile && !attachedFile.type.startsWith("image/")) {
      const fileContent = attachedFile.textContent || "（未读取到有效文本）";
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      combinedText = `${textContent || "帮我分析下这份文件："}\n\n--- 附带文件[${attachedFile.name}]内容如下 ---\n${fileContent}`;
    }

    const displayPrompt = attachedFile
      ? `📎 [文件：${attachedFile.name}]\n  ${textContent}`
      : textContent;

    const updatedHistory: Message[] = [
      ...messages,
      { role: "user" as const, content: displayPrompt },
      { role: "assistant" as const, content: "" },
    ];
    setMessages(updatedHistory);

    const apiMessages = [
      ...updatedHistory.slice(-MAX_CONTEXT_MESSAGES).map((m) => ({
        role: m.role,
        content:
          m.role === "user" &&
          m.content === displayPrompt &&
          attachedFile
            ? attachedFile.type.startsWith("image/")
              ? [
                  {
                    type: "text",
                    text: textContent || "请帮我分析一下这张图片。",
                  },
                  { type: "image_url", image_url: { url: attachedFile.base64 } },
                ]
              : combinedText
            : m.content,
      })),
    ];

    setInput("");
    setAttachedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";

    finalTextRef.current = "";
    isFetchingRef.current = true;
    setIsStreaming(true);

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
        signal: abortController.signal,
      });

      if (!response.body || !response.ok) throw new Error("Request failed.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split(/\r?\n\r?/);
        buffer = chunks.pop() || "";

        for (const chunk of chunks) {
          const line = chunk.trim();
          if (!line || line.startsWith(":")) continue;

          const dataLine = line.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;

          const rawData = dataLine.slice("data:".length).trim();
          if (rawData === "[DONE]") continue;

          try {
            // 🌟 核心：解析通用的 JSON 对象，而不是直接解析 string
            const packet = JSON.parse(rawData);

            // 2. 如果是普通文本流 (TEXT)
            if (packet.type === "TEXT" || typeof packet === "string") {
              const textToken =
                typeof packet === "string" ? packet : packet.content;

              finalTextRef.current += textToken;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: finalTextRef.current,
                };
                return updated;
              });
            }
          } catch (e) {
            console.error("解析流数据包失败:", e);
          }
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      const message =
        error instanceof Error ? error.message : "Streaming failed.";
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: "assistant",
          content: message,
        };
        return updated;
      });
    } finally {
      isFetchingRef.current = false;
      abortRef.current = null;
      setIsStreaming(false);
    }
  }

  function stopStreaming() {
    isFetchingRef.current = false;
    abortRef.current?.abort();
  }

  function clearChat() {
    abortRef.current?.abort();
    setMessages(starterMessages);
    setInput("");
    setAttachedFile(null);
    setIsStreaming(false);
    window.localStorage.removeItem(STORAGE_KEY);
  }

  const renderMessageRow = (message: Message, isUser: boolean) => (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
      <div
        className={`max-w-[85%] rounded-lg px-4 py-3 text-sm leading-6 shadow-sm 
          ${isUser ? "bg-blue-600 text-white whitespace-pre-wrap" : "bg-white text-zinc-900"}`}
      >
        {isUser ? (
          message.content
        ) : (
          <div className="prose prose-sm prose-zinc max-w-none w-full overflow-x-auto wrap-break-word whitespace-normal">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content || "Thinking..."}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <main className="min-h-screen bg-zinc-100 text-zinc-950">
      <div className="mx-auto flex h-screen w-full max-w-5xl flex-col px-4 py-6">
        <header className="mb-5 flex items-center justify-between border-b border-zinc-200 pb-4">
          <div>
            <h1 className="text-2xl font-semibold">AI Chat Component</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Virtuoso + Typewriter Optimized Stream
            </p>
          </div>
          <div className="flex gap-2">
            {isStreaming && (
              <button
                className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-200"
                onClick={stopStreaming}
              >
                Stop
              </button>
            )}
            <button
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-200"
              onClick={clearChat}
            >
              Clear
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 pb-4">
          <Virtuoso
            ref={virtuosoRef} // 1. 挂载 ref
            className="h-full w-full"
            data={messages}
            // 2. 删掉旧的 initialTopMostItemIndex={messages.length - 1} 避免冲突
            // 如果想在首次加载本地缓存时定位到最后，可以改用下面的静态逻辑或由 isLoaded 触发一次
            followOutput={(isAtBottom) => {
              // 3. 当用户自己在向上翻看历史记录时（!isAtBottom），不要强行吸底打扰用户
              // 当正在流式传输，或者本身就在底部时，自动吸底
              if (isStreaming) return "auto";
              return isAtBottom ? "auto" : false;
            }}
            itemContent={(index, message) => {
              return renderMessageRow(message, message.role === "user");
            }}
          />
        </div>

        <div className="border-t border-zinc-200 pt-4">
          {attachedFile && (
            <div className="mb-2 flex items-center gap-2 max-w-xs rounded-md bg-zinc-200 px-3 py-1.5 text-xs text-zinc-700">
              {attachedFile.type.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={attachedFile.base64}
                  alt="preview"
                  className="h-8 w-8 rounded object-cover border bg-white"
                />
              ) : (
                <span className="text-lg">📄</span>
              )}
              <div className="flex-1 truncate font-medium">
                {attachedFile.name}
              </div>
              <button
                type="button"
                className="text-zinc-400 hover:text-zinc-600 ml-1 font-bold"
                onClick={() => {
                  setAttachedFile(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
              >
                ✕
              </button>
            </div>
          )}

          <form className="flex gap-2" onSubmit={handleSubmit}>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileSelect}
              className="hidden"
              accept="image/*,application/pdf,text/*"
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3.5 text-xl hover:bg-zinc-50 active:scale-95 transition-transform"
              title="Upload file"
              disabled={isStreaming || isParsingFile}
            >
              📎
            </button>

            <input
              className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-4 py-3 text-sm outline-none focus:border-blue-500"
              onChange={(event) => setInput(event.target.value)}
              placeholder={
                isParsingFile
                  ? "⚡ 正在深度解析文件中..."
                  : attachedFile
                    ? "Ask about this file..."
                    : "Type a message..."
              }
              value={input}
              disabled={isParsingFile}
            />

            <button
              className="rounded-md bg-zinc-950 px-5 py-3 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
              disabled={(!input.trim() && !attachedFile) || isParsingFile}
              type="submit"
            >
              {isParsingFile ? "Parsing..." : "Send"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
