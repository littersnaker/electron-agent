// src/app/page.tsx
"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
// 1. ⚡ 删掉旧的 Virtuoso 引入，引入我们刚刚写好的 ChatList 组件
import ChatList from "./component/ChatList";
import {
  Message,
  AttachedFile,
  ChatSession,
  StreamPacket,
} from "./const/pageConst";

const DB_NAME = "GeminiChatDB";
const DB_VERSION = 1;
const MAX_CONTEXT_MESSAGES = 24;

const starterMessages: Message[] = [
  {
    role: "assistant",
    content: "你好，我是你的智能对话机器人，有什么问题可以问我哦！",
  },
];

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

  // ⚡ 2. 删掉旧的 virtuosoRef 引用，列表内部自己接管
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 1. 异步初始化加载 IndexedDB 数据 (保持原样...)
  useEffect(() => {
    async function initChatFromDB() {
      try {
        const db = await openDB();
        const allSessions = await new Promise<ChatSession[]>((resolve) => {
          const tx = db.transaction("sessions", "readonly");
          const store = tx.objectStore("sessions");
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        });

        const activeIdSetting = await new Promise<{
          key: string;
          value: string;
        } | null>((resolve) => {
          const tx = db.transaction("settings", "readonly");
          const store = tx.objectStore("settings");
          const req = store.get("activeSessionId");
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        });

        let initialSessions = allSessions;
        let initialActiveId = activeIdSetting?.value || "";

        if (initialSessions.length === 0) {
          const defaultSession: ChatSession = {
            id:
              "session_" +
              Date.now() +
              Math.random().toString(36).substring(2, 9),
            title: "新的对话",
            messages: starterMessages,
          };
          initialSessions = [defaultSession];
          initialActiveId = defaultSession.id;

          const tx = db.transaction(["sessions", "settings"], "readwrite");
          tx.objectStore("sessions").put(defaultSession);
          tx.objectStore("settings").put({
            key: "activeSessionId",
            value: defaultSession.id,
          });
        } else {
          if (
            !initialActiveId ||
            !initialSessions.some((s) => s.id === initialActiveId)
          ) {
            initialActiveId = initialSessions[0].id;
          }
        }

        setSessions(initialSessions);
        setActiveSessionId(initialActiveId);

        const currentSession = initialSessions.find(
          (s) => s.id === initialActiveId,
        );
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

  // 3. 当切换活跃会话时记录设置表 (保持原样...)
  useEffect(() => {
    if (!isLoaded || !activeSessionId) return;
    openDB().then((db) => {
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put({
        key: "activeSessionId",
        value: activeSessionId,
      });
    });
  }, [activeSessionId, isLoaded]);

  // 4. 切换会话逻辑 (保持原样...)
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

  // 5. 新增对话逻辑 (保持原样...)
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

    const db = await openDB();
    const tx = db.transaction("sessions", "readwrite");
    tx.objectStore("sessions").put(newSession);
  };

  // 6. 删除特定会话逻辑 (保持原样...)
  const deleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isStreaming) return;

    if (sessions.length <= 1) {
      clearChat();
      return;
    }

    const remainingSessions = sessions.filter((s) => s.id !== sessionId);
    setSessions(remainingSessions);

    const db = await openDB();
    const tx = db.transaction("sessions", "readwrite");
    tx.objectStore("sessions").delete(sessionId);

    if (activeSessionId === sessionId) {
      const nextActive = remainingSessions[0];
      setActiveSessionId(nextActive.id);
      setMessages(nextActive.messages);
    }
  };

  // ⚡ 3. 【核心删改】：彻底删掉原来的自动吸底 useEffect 副作用

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // 前端多模态及 PDF 深度解析模块 (保持原样...)
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
          const pageText = (tokenizedText.items as Array<{ str?: string }>)
            .map((item) => item.str || "")
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

  // 核心 handleSubmit 流式请求及存储 (保持原样...)
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

    const updatedHistory: Message[] = [
      ...messages,
      { role: "user" as const, content: displayPrompt },
      { role: "assistant" as const, content: "" },
    ];

    const currentSession = sessions.find((s) => s.id === activeSessionId);
    let updatedTitle = currentSession?.title || "新的对话";

    if (updatedTitle === "新的对话" || updatedTitle === "New Chat") {
      const cleanContent = displayPrompt
        .replace(/^📎 \[文件：.*?\]\s*/g, "")
        .trim();
      const firstSentence = cleanContent.split(/[\n。？?！!]/)[0].trim();
      if (firstSentence) {
        updatedTitle =
          firstSentence.length > 15
            ? firstSentence.slice(0, 15) + "..."
            : firstSentence;
      } else {
        updatedTitle = cleanContent.slice(0, 12) || "新的对话";
      }
    }

    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSessionId
          ? { ...s, title: updatedTitle, messages: updatedHistory }
          : s,
      ),
    );
    const db = await openDB();
    const tx = db.transaction("sessions", "readwrite");
    tx.objectStore("sessions").put({
      id: activeSessionId,
      title: updatedTitle,
      messages: updatedHistory,
    });

    setMessages(updatedHistory);

    const apiMessages = [
      ...updatedHistory.slice(-MAX_CONTEXT_MESSAGES).map((m) => ({
        role: m.role,
        content:
          m.role === "user" && m.content === displayPrompt && attachedFile
            ? attachedFile.type.startsWith("image/")
              ? [
                  {
                    type: "text",
                    text: textContent || "请帮我分析一下这张图片。",
                  },
                  {
                    type: "image_url",
                    image_url: { url: attachedFile.base64 },
                  },
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
        body: JSON.stringify({
          messages: apiMessages,
          sessionId: activeSessionId,
        }),
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
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;
          if (trimmed.startsWith("data:")) {
            const rawData = trimmed.slice("data:".length).trim();
            if (rawData === "[DONE]") continue;

            try {
              // 🎯 安全地通过接口断言，平息 ESLint 的 `no-explicit-any` 和不安全成员访问警告
              const packet = JSON.parse(rawData) as StreamPacket;

              if (packet && typeof packet === "object") {
                // 分支一：处理真实的大模型流式吐字（包括逻辑思考与正文）
                if (packet.type === "TEXT") {
                  const textToken = packet.content || "";
                  if (textToken) {
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
                }

                // 分支二：处理 LangGraph 拓扑节点的普通进度状态
                else if (packet.type === "STATUS") {
                  const statusText = packet.content || "";
                  setMessages((prev) => {
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                      role: "assistant",
                      content: statusText, // 💡 临时渲染成状态文字，带给用户极佳的动态反馈
                    };
                    return updated;
                  });
                }

                // 分支三：处理 LangGraph 正在调用特定工具的状态
                else if (packet.type === "TOOL_STATUS") {
                  const toolName = packet.content || "";
                  setMessages((prev) => {
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                      role: "assistant",
                      content: `🔧 正在调用代码控制台执行修改: [${toolName}]...`,
                    };
                    return updated;
                  });
                }

                // 分支四：处理补丁就绪信号
                else if (packet.type === "DIFF_READY") {
                  console.log("检测到补丁就绪信号:", packet.payload);
                }
              }
            } catch (e) {
              console.warn("解析流数据包跳过一行:", trimmed, e);
            }
          }
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      const message =
        error instanceof Error ? error.message : "Streaming failed.";
      finalTextRef.current = message;
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: "assistant", content: message };
        return updated;
      });
    } finally {
      isFetchingRef.current = false;
      abortRef.current = null;
      setIsStreaming(false);

      const finalHistory = [
        ...updatedHistory.slice(0, -1),
        { role: "assistant" as const, content: finalTextRef.current },
      ];
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeSessionId ? { ...s, messages: finalHistory } : s,
        ),
      );
      const finalDb = await openDB();
      const finalTx = finalDb.transaction("sessions", "readwrite");
      finalTx.objectStore("sessions").put({
        id: activeSessionId,
        title: updatedTitle,
        messages: finalHistory,
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
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeSessionId
          ? { ...s, title: "新的对话", messages: starterMessages }
          : s,
      ),
    );
    openDB().then((db) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put({
        id: activeSessionId,
        title: "新的对话",
        messages: starterMessages,
      });
    });
  }

  // ⚡ 4. 【核心删改】：彻底删掉原来的 renderMessageRow 整个函数

  return (
    <main className="min-h-screen bg-zinc-100 text-zinc-950 flex overflow-hidden">
      {/* 左侧历史会话侧边栏 (保持原样...) */}
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
            <p className="mt-1 text-sm text-zinc-500">千问模型</p>
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

        {/* ⚡ 5. 【核心替换】：在这里直接换上我们封装好的高效 ChatList 组件 */}
        {/* 💡 绝招：key={activeSessionId} 强制在切换会话时使组件重载，瞬间闪现吸底，不再卡在顶部！ */}
        <ChatList
          key={activeSessionId}
          messages={messages}
          isStreaming={isStreaming}
        />

        {/* 底部输入框表单 (保持原样...) */}
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
