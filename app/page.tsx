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

type ChatSession = {
  id: string;
  title: string;
  messages: Message[];
};

const DB_NAME = "GeminiChatDB";
const DB_VERSION = 1;
const MAX_CONTEXT_MESSAGES = 24;

const starterMessages: Message[] = [
  {
    role: "assistant",
    content:
      "你好，我是你的智能对话机器人，有什么问题可以问我哦！",
  },
];

// ⚡ 封装原生的 IndexedDB 异步连接器
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export default function Home() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  
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

  // 1. 异步初始化加载 IndexedDB 数据
  useEffect(() => {
    async function initChatFromDB() {
      try {
        const db = await openDB();
        
        // 读取所有历史会话
        const allSessions = await new Promise<ChatSession[]>((resolve) => {
          const tx = db.transaction("sessions", "readonly");
          const store = tx.objectStore("sessions");
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        });

        // 读取上次活跃的会话 ID
        const activeIdSetting = await new Promise<{ key: string; value: string } | null>((resolve) => {
          const tx = db.transaction("settings", "readonly");
          const store = tx.objectStore("settings");
          const req = store.get("activeSessionId");
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        });

        let initialSessions = allSessions;
        let initialActiveId = activeIdSetting?.value || "";

        // 如果数据库是空的，初始化创建一个默认会话
        if (initialSessions.length === 0) {
          const defaultSession: ChatSession = {
            id: "session_" + Date.now() + Math.random().toString(36).substring(2, 9),
            title: "新的对话",
            messages: starterMessages,
          };
          initialSessions = [defaultSession];
          initialActiveId = defaultSession.id;

          // 顺手写入数据库做兜底持久化
          const tx = db.transaction(["sessions", "settings"], "readwrite");
          tx.objectStore("sessions").put(defaultSession);
          tx.objectStore("settings").put({ key: "activeSessionId", value: defaultSession.id });
        } else {
          // 校验上次活跃的 ID 在列表里是否存在
          if (!initialActiveId || !initialSessions.some(s => s.id === initialActiveId)) {
            initialActiveId = initialSessions[0].id;
          }
        }

        // 按 ID 的创建时间戳倒序排列侧边栏（如果需要，这里我们保持默认读取顺序）
        setSessions(initialSessions);
        setActiveSessionId(initialActiveId);
        
        const currentSession = initialSessions.find(s => s.id === initialActiveId);
        if (currentSession) {
          setMessages(currentSession.messages);
        }
      } catch (e) {
        console.error("IndexedDB 初始化故障，开启兜底存储机制:", e);
      } finally {
        setIsLoaded(true);
      }
    }

    initChatFromDB();
  }, []);


  // 3. 当切换活跃会话时，单独将 activeSessionId 记录到设置表
  useEffect(() => {
    if (!isLoaded || !activeSessionId) return;
    openDB().then((db) => {
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put({ key: "activeSessionId", value: activeSessionId });
    });
  }, [activeSessionId, isLoaded]);

  // 4. 切换会话逻辑
  const switchSession = (sessionId: string) => {
    if (isStreaming || sessionId === activeSessionId) return;
    abortRef.current?.abort();
    setIsStreaming(false);

    setActiveSessionId(sessionId);
    const targetSession = sessions.find((s) => s.id === sessionId);
    if (targetSession) {
      setMessages(targetSession.messages);
    }
    setInput("");
    setAttachedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // 5. 新增对话逻辑
  const createNewSession = async () => {
    if (isStreaming) return;
    abortRef.current?.abort();
    setIsStreaming(false);

    const newSession: ChatSession = {
      id: "session_" + Date.now() + Math.random().toString(36).substring(2, 9),
      title: "新的对话",
      messages: starterMessages,
    };

    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
    setMessages(starterMessages);
    
    setInput("");
    setAttachedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";

    // 同步将新行插入到数据库
    const db = await openDB();
    const tx = db.transaction("sessions", "readwrite");
    tx.objectStore("sessions").put(newSession);
  };

  // 6. 删除特定会话逻辑
  const deleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation(); 
    if (isStreaming) return;

    if (sessions.length <= 1) {
      clearChat();
      return;
    }

    const remainingSessions = sessions.filter((s) => s.id !== sessionId);
    setSessions(remainingSessions);

    // 从数据库中彻底擦除该条会话
    const db = await openDB();
    const tx = db.transaction("sessions", "readwrite");
    tx.objectStore("sessions").delete(sessionId);

    if (activeSessionId === sessionId) {
      const nextActive = remainingSessions[0];
      setActiveSessionId(nextActive.id);
      setMessages(nextActive.messages);
    }
  };

  // 自动吸底逻辑
  useEffect(() => {
    if (isStreaming && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({
        index: messages.length - 1,
        align: "end",
        behavior: "auto",
      });
    }
  }, [messages, isStreaming]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // 前端多模态及 PDF 深度解析模块（未变动）
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsParsingFile(true);
    try {
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
          setIsParsingFile(false);
        };
        reader.readAsDataURL(file);
        return;
      }

      if (file.type === "application/pdf") {
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(arrayBuffer),
        });
        const pdf = await loadingTask.promise;

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
        setAttachedFile({
          name: file.name,
          type: file.type,
          base64: "",
          textContent: fullText.trim() || "（未读取到有效文本）",
        });
        setIsParsingFile(false);
        return;
      }

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
        setIsParsingFile(false);
      };
      textReader.readAsText(file);
    } catch (error) {
      console.error("解析文件发生致命错误:", error);
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
      combinedText = `${textContent || "帮我分析下这份文件："}\n\n--- 附带文件[${attachedFile.name}]内容如下 ---\n${fileContent}`;
    }

    const displayPrompt = attachedFile
      ? `📎 [文件：${attachedFile.name}]\n  ${textContent}`
      : textContent;

    // 组装包含用户当前输入的最新历史记录
    const updatedHistory: Message[] = [
      ...messages,
      { role: "user" as const, content: displayPrompt },
      { role: "assistant" as const, content: "" },
    ];

    // ==========================================
    // ⚡ 1. 核心合规重构：在事件触发时，立即计算标题（不依赖 useEffect）
    // ==========================================
    const currentSession = sessions.find(s => s.id === activeSessionId);
    let updatedTitle = currentSession?.title || "新的对话";

    if (updatedTitle === "新的对话" || updatedTitle === "New Chat") {
      const cleanContent = displayPrompt.replace(/^📎 \[文件：.*?\]\s*/g, "").trim();
      const firstSentence = cleanContent.split(/[\n。？?！!]/)[0].trim();
      if (firstSentence) {
        updatedTitle = firstSentence.length > 15 
          ? firstSentence.slice(0, 15) + "..." 
          : firstSentence;
      } else {
        updatedTitle = cleanContent.slice(0, 12) || "新的对话";
      }
    }

    // ⚡ 2. 立即同步更新侧边栏 Session 列表状态，并存入第一笔数据（用户消息 + 新标题）
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSessionId ? { ...s, title: updatedTitle, messages: updatedHistory } : s))
    );
    const db = await openDB();
    const tx = db.transaction("sessions", "readwrite");
    tx.objectStore("sessions").put({ id: activeSessionId, title: updatedTitle, messages: updatedHistory });

    // 更新右侧聊天面板的数据源
    setMessages(updatedHistory);

    // 准备发送给 API 的 payload
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
            const packet = JSON.parse(rawData);

            if (packet.type === "TEXT" || typeof packet === "string") {
              const textToken =
                typeof packet === "string" ? packet : packet.content;

              finalTextRef.current += textToken;
              
              // ⚡ 3. 流式传输期间，【只】更新右侧文本展示区 messages，维持 Virtuoso 极速流畅渲染
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
      const message = error instanceof Error ? error.message : "Streaming failed.";
      finalTextRef.current = message; // 保证异常信息也能被完整收录
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

      // ==========================================
      // ⚡ 4. 核心合规重构：流式交互彻底关闭时，一次性对最终全量数据收网持久化
      // ==========================================
      const finalHistory = [
        ...updatedHistory.slice(0, -1),
        { role: "assistant" as const, content: finalTextRef.current }
      ];
      
      // 更新左侧内存 Session 状态
      setSessions((prev) =>
        prev.map((s) => (s.id === activeSessionId ? { ...s, messages: finalHistory } : s))
      );
      
      // 最终完整写入 IndexedDB
      const finalDb = await openDB();
      const finalTx = finalDb.transaction("sessions", "readwrite");
      finalTx.objectStore("sessions").put({ 
        id: activeSessionId, 
        title: updatedTitle, 
        messages: finalHistory 
      });
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
    
    setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, title: "新的对话", messages: starterMessages } : s));
    
    // 清空数据库中该特定会话里面的对话内容
    openDB().then(db => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put({ id: activeSessionId, title: "新的对话", messages: starterMessages });
    });
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
    <main className="min-h-screen bg-zinc-100 text-zinc-950 flex overflow-hidden">
      
      {/* 左侧历史会话侧边栏 */}
      <div className="w-64 bg-zinc-900 text-zinc-200 flex flex-col h-screen border-r border-zinc-800 shrink-0 select-none">
        <div className="p-4">
          <button
            onClick={createNewSession}
            disabled={isStreaming}
            className="w-full flex items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-zinc-700 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="text-base font-bold">＋</span> 新增对话
          </button>
        </div>
        
        {/* 会话列表列表 */}
        <div className="flex-1 overflow-y-auto px-2 pb-4 space-y-1">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <div
                key={session.id}
                onClick={() => switchSession(session.id)}
                className={`group flex items-center justify-between rounded-md px-3 py-2.5 text-sm font-medium cursor-pointer transition-colors
                  ${isActive ? "bg-zinc-800 text-white" : "hover:bg-zinc-800/40 text-zinc-400 hover:text-zinc-200"}`}
              >
                <div className="flex items-center gap-2.5 truncate flex-1 mr-2">
                  <span className="text-sm shrink-0">💬</span>
                  <span className="truncate">{session.title}</span>
                </div>
                <button
                  onClick={(e) => deleteSession(session.id, e)}
                  disabled={isStreaming}
                  className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-200 transition-opacity px-1 font-bold text-xs disabled:hidden"
                  title="删除对话"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
        
        <div className="p-3 border-t border-zinc-800 text-xs text-zinc-500 text-center">
          共 {sessions.length} 个历史对话 (已启用 IndexedDB 存储)
        </div>
      </div>

      {/* 右侧聊天区域 */}
      <div className="flex-1 flex flex-col h-screen max-w-5xl mx-auto px-4 py-6">
        <header className="mb-5 flex items-center justify-between border-b border-zinc-200 pb-4">
          <div>
            <h1 className="text-2xl font-semibold">AI Chat Component</h1>
            <p className="mt-1 text-sm text-zinc-500">
              千问模型
            </p>
          </div>
          <div className="flex gap-2">
            {isStreaming && (
              <button
                className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium bg-white hover:bg-zinc-200"
                onClick={stopStreaming}
              >
                Stop
              </button>
            )}
            <button
              className="rounded-md border border-zinc-300 px-3 py-2 text-sm font-medium bg-white hover:bg-zinc-200"
              onClick={clearChat}
            >
              Clear Current
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 pb-4">
          <Virtuoso
            ref={virtuosoRef}
            className="h-full w-full"
            data={messages}
            followOutput={(isAtBottom) => {
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