// src/app/page.tsx
"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
// 1. ⚡ 删掉旧的 Virtuoso 引入，引入我们刚刚写好的 ChatList 组件
import ChatList from "./component/ChatList";
import TextareaAutosize from "react-textarea-autosize";
import {
  Message,
  AttachedFile,
  ChatSession,
  StreamPacket,
} from "./const/pageConst";
import CustomTitleBar from "./component/CustomTitleBar";

// 暗黑主题硬编码颜色（避免 CSS 变量加载时序问题）
const T = {
  bg: "#0a0a0f",
  bgSoft: "#12121a",
  surface: "#16161f",
  surfaceHover: "#1d1d2a",
  border: "#26263a",
  borderSoft: "#1f1f2e",
  fg: "#ededf2",
  fgMuted: "#9a9ab0",
  fgSubtle: "#6b6b85",
  accentFrom: "#a855f7",
  accentTo: "#6366f1",
  accentGlow: "rgba(139, 92, 246, 0.35)",
  accentGrad: "linear-gradient(135deg, #a855f7 0%, #6366f1 100%)",
  green: "#22c55e",
};

function createSessionId(): string {
  return "session_" + Date.now() + Math.random().toString(36).substring(2, 9);
}

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
  const [currentTool, setCurrentTool] = useState<string>(""); // ⚡ 新增：当前执行的工具名状态
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
            id: createSessionId(),
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
          const sanitizedMessages = currentSession.messages.filter((msg) => {
            //逻辑：如果这一条是 assistant 发的，且包含"思考"、"演算"、"正在"等关键字
            // 且该条消息是最后一条，那就说明是上次崩溃残留的"骨架屏"
            const isTempLoading =
              msg.role === "assistant" && msg.content === "";

            // 仅保留非临时的消息
            return !isTempLoading;
          });

          // 设置清理后的消息
          setMessages(sanitizedMessages);
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
    setCurrentTool(""); // ⚡ 切换会话时清空工具状态

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
    setCurrentTool(""); // ⚡ 创建新会话时清空工具状态

    const newSession: ChatSession = {
      id: createSessionId(),
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
        pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
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
          // 每 3 页让出一次主线程，防止大 PDF 阻塞 UI
          if (i % 3 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
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
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as FormEvent<HTMLFormElement>);
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
    setCurrentTool(""); // ⚡ 开始新请求时清空工具状态

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
                    // 文本开始返回，立即清除工具状态，避免 currentTool 遮挡文本
                    if (currentTool) setCurrentTool("");
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
                // 如果已经收到过文字内容，不再覆盖，避免打断打字机效果
                else if (packet.type === "STATUS") {
                  const statusText = packet.content || "";
                  if (!finalTextRef.current.trim()) {
                    setMessages((prev) => {
                      const updated = [...prev];
                      updated[updated.length - 1] = {
                        role: "assistant",
                        content: statusText,
                      };
                      return updated;
                    });
                  }
                }

                // 分支三：处理 LangGraph 正在调用特定工具的状态
                else if (packet.type === "TOOL_STATUS") {
                  const toolName = packet.content || "";
                  setCurrentTool(toolName); // ⚡ 更新当前工具状态
                  if (!finalTextRef.current.trim()) {
                    setMessages((prev) => {
                      const updated = [...prev];
                      updated[updated.length - 1] = {
                        role: "assistant",
                        content: `[${toolName}]`,
                      };
                      return updated;
                    });
                  }
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
      // 区分主动取消和其他网络错误
      if (error instanceof DOMException && error.name === "AbortError") {
        console.log("用户主动取消请求");
        setMessages((prev) => {
          const newMessages = [...prev];
          if (
            newMessages.length > 0 &&
            newMessages[newMessages.length - 1].role === "assistant"
          ) {
            const lastContent = newMessages[newMessages.length - 1].content;
            if (!lastContent.trim()) {
              newMessages[newMessages.length - 1].content = "⏹️ 已停止生成";
            }
          }
          return newMessages;
        });
      } else {
        // 🎯 核心拦截 2：这里会捕获 断网、fetch 失败、以及上面抛出的 response.ok 异常
        console.error("请求中断或失败:", error);

        // 强制把最后一条卡住的占位消息，替换成你要求的统一样板文案
        setMessages((prev) => {
          const newMessages = [...prev];
          if (
            newMessages.length > 0 &&
            newMessages[newMessages.length - 1].role === "assistant"
          ) {
            newMessages[newMessages.length - 1].content =
              "⚠️ 网络问题，稍后再试。";
          }
          return newMessages;
        });
      }
    } finally {
      isFetchingRef.current = false;
      abortRef.current = null;
      setIsStreaming(false);
      setCurrentTool(""); // ⚡ 请求结束后清空工具状态

      // 如果当前会话已被 "清空对话" 标记为清除，不再保存旧数据
      if (clearedSessionRef.current === activeSessionId) {
        clearedSessionRef.current = null;
        return;
      }

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
    setCurrentTool(""); // ⚡ 停止流式时清空工具状态
  }

  // 标记当前会话是否已被清空，防止 sendMessage 的 finally 保存旧数据
  const clearedSessionRef = useRef<string | null>(null);

  async function clearChat() {
    abortRef.current?.abort();

    // 1. 标记当前会话已被清空，防止 sendMessage 的 finally 保存旧数据
    clearedSessionRef.current = activeSessionId;

    // 2. 生成全新的 ID
    const newSessionId = createSessionId();

    // 3. 更新本地状态
    setMessages(starterMessages);
    setActiveSessionId(newSessionId);

    // 4. 更新侧边栏：添加新会话，不删除旧的（旧的保留在列表中，方便回顾）
    setSessions((prev) => [
      { id: newSessionId, title: "新的对话", messages: starterMessages },
      ...prev,
    ]);

    // 5. IndexedDB 写入新会话
    const db = await openDB();
    const tx = db.transaction("sessions", "readwrite");
    tx.objectStore("sessions").put({
      id: newSessionId,
      title: "新的对话",
      messages: starterMessages,
    });
  }

  // ⚡ 4. 【核心删改】：彻底删掉原来的 renderMessageRow 整个函数

  return (
    <main
      className="h-screen flex flex-col  overflow-hidden"
      style={{ background: T.bg, color: T.fg }}
    >
      <div className="shrink-0">
        <CustomTitleBar />
      </div>
      <div className="flex flex-1 overflow-hidden border-t border-gray-700">
        {/* 左侧历史会话侧边栏 */}
        <div
          className="w-72 flex flex-col  shrink-0 select-none"
          style={{
            background: T.bgSoft,
            borderRight: `1px solid ${T.borderSoft}`,
          }}
        >
          {/* 顶部品牌区 */}
          <div className="px-5 pt-5 pb-3">
            <div className="flex items-center gap-3">
              <div
                className="flex items-center justify-center w-10 h-10 rounded-xl text-white font-bold text-xl shrink-0"
                style={{
                  background: T.accentGrad,
                  boxShadow: `0 4px 14px -4px ${T.accentGlow}`,
                }}
              >
                A
              </div>
              <div className="min-w-0">
                <div className="text-base font-semibold text-gradient">
                  智能助手
                </div>
                <div className="text-xs" style={{ color: T.fgSubtle }}>
                  千问大模型驱动
                </div>
              </div>
            </div>
          </div>

          {/* 新增对话按钮 */}
          <div className="px-4 pb-3">
            <button
              onClick={createNewSession}
              disabled={isStreaming}
              className="btn-gradient w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none"
            >
              <span className="text-base leading-none">＋</span> 新建对话
            </button>
          </div>

          {/* 会话列表 */}
          <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-1">
            <div
              className="px-2 py-1 text-xs font-medium"
              style={{ color: T.fgSubtle }}
            >
              历史对话
            </div>
            {sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              return (
                <div
                  key={session.id}
                  onClick={() => switchSession(session.id)}
                  className={`group flex items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium cursor-pointer transition-all
                  ${isActive ? "" : "hover:bg-[#1d1d2a]"}`}
                  style={
                    isActive
                      ? {
                          background: T.surfaceHover,
                          color: T.fg,
                          boxShadow: `inset 2px 0 0 ${T.accentFrom}`,
                        }
                      : { color: T.fgMuted }
                  }
                >
                  <div className="flex items-center gap-2.5 truncate flex-1 mr-2">
                    <span className="text-sm shrink-0 opacity-70">💬</span>
                    <span className="truncate">{session.title}</span>
                  </div>
                  <button
                    onClick={(e) => deleteSession(session.id, e)}
                    disabled={isStreaming}
                    className="opacity-0 group-hover:opacity-100 transition-opacity px-1 font-bold text-xs disabled:hidden hover:text-red-400"
                    style={{ color: T.fgSubtle }}
                    title="删除对话"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>

          {/* 底部状态栏 */}
          <div
            className="px-4 py-3 text-xs flex items-center justify-between"
            style={{
              borderTop: `1px solid ${T.borderSoft}`,
              color: T.fgSubtle,
            }}
          >
            <span>共 {sessions.length} 个对话</span>
            <span className="flex items-center gap-1.5">
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ background: T.green }}
              ></span>
              已本地存储
            </span>
          </div>
        </div>

        {/* 右侧聊天区域 */}
        <div className="flex-1 flex flex-col max-w-5xl mx-auto px-6 py-6">
          <header
            className="mb-5 flex items-center justify-between pb-4"
            style={{ borderBottom: `1px solid ${T.borderSoft}` }}
          >
            <div>
              <h1 className="text-xl font-semibold text-gradient">AI 对话</h1>
              <p className="mt-0.5 text-xs" style={{ color: T.fgSubtle }}>
                基于 LangGraph 智能体 · 通义千问
              </p>
            </div>
            <div className="flex gap-2">
              {isStreaming && (
                <button
                  className="rounded-lg px-3.5 py-2 text-sm font-medium transition-all hover:opacity-80"
                  style={{
                    background: T.surfaceHover,
                    color: T.fg,
                    border: `1px solid ${T.border}`,
                  }}
                  onClick={stopStreaming}
                >
                  ⏹ 停止生成
                </button>
              )}
              <button
                className="rounded-lg px-3.5 py-2 text-sm font-medium transition-all hover:opacity-80"
                style={{
                  background: T.surfaceHover,
                  color: T.fg,
                  border: `1px solid ${T.border}`,
                }}
                onClick={clearChat}
              >
                清空对话
              </button>
            </div>
          </header>

          {/* ⚡ 5. 【核心替换】：在这里直接换上我们封装好的高效 ChatList 组件 */}
          {/* 💡 绝招：key={activeSessionId} 强制在切换会话时使组件重载，瞬间闪现吸底，不再卡在顶部！ */}
          <ChatList
            key={activeSessionId}
            messages={messages}
            isStreaming={isStreaming}
            currentTool={currentTool} // ⚡ 传递当前工具状态给 ChatList
          />

          {/* 底部输入框表单 (保持原样...) */}
          <div
            className="pt-4"
            style={{ borderTop: `1px solid ${T.borderSoft}` }}
          >
            {attachedFile && (
              <div
                className="mb-2 flex items-center gap-2 max-w-xs rounded-lg px-3 py-1.5 text-xs"
                style={{ background: T.surfaceHover, color: T.fgMuted }}
              >
                {attachedFile.type.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={attachedFile.base64}
                    alt="preview"
                    className="h-8 w-8 rounded object-cover border"
                    style={{ borderColor: T.border }}
                  />
                ) : (
                  <span className="text-lg">📄</span>
                )}
                <div className="flex-1 truncate font-medium">
                  {attachedFile.name}
                </div>
                <button
                  type="button"
                  className="ml-1 font-bold hover:opacity-70"
                  style={{ color: T.fgSubtle }}
                  onClick={() => {
                    setAttachedFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                >
                  ✕
                </button>
              </div>
            )}

            <form className="flex flex-col gap-2 " onSubmit={handleSubmit}>
              {/* <input
              className="input-glow min-w-0 flex-1 rounded-lg px-4 py-3 text-sm outline-none transition-all"
              style={{ background: T.surface, color: T.fg, border: `1px solid ${T.border}` }}
              onChange={(event) => setInput(event.target.value)}
              placeholder={
                isParsingFile
                  ? "⚡ 正在深度解析文件中..."
                  : attachedFile
                    ? "问问关于这份文件的内容..."
                    : "输入你的问题，按回车发送..."
              }
              value={input}
              disabled={isParsingFile}
            /> */}

              <div className="flex items-center justify-between gap-2">
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
                  className="flex items-center justify-center rounded-lg px-3.5 text-xl transition-all hover:opacity-80 active:scale-95"
                  style={{
                    background: T.surface,
                    color: T.fgMuted,
                    border: `1px solid ${T.border}`,
                  }}
                  title="上传文件"
                  disabled={isStreaming || isParsingFile}
                >
                  📎
                </button>
              </div>
              <div
                className="mt-2 relative flex items-center gap-2 text-xs"
                style={{ color: T.fgSubtle }}
              >
                <TextareaAutosize
                  minRows={4}
                  maxRows={4} // 设置最大行数，超过后显示滚动条
                  className="input-glow min-w-0 flex-1 rounded-lg px-4 py-3 text-sm outline-none transition-all resize-none h-25 pr-20" // 预留右侧按钮空间
                  style={{
                    background: T.surface,
                    color: T.fg,
                    border: `1px solid ${T.border}`,
                    lineHeight: "1.5rem", // 保持行高一致
                  }}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    isParsingFile
                      ? "⚡ 正在深度解析..."
                      : "输入问题，Shift+Enter 换行..."
                  }
                  value={input}
                  disabled={isParsingFile}
                />
                <button
                  className="btn-gradient absolute right-[10px] bottom-[10px] rounded-lg px-5 py-3 text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none"
                  disabled={(!input.trim() && !attachedFile) || isParsingFile}
                  type="submit"
                >
                  {isParsingFile ? "解析中..." : "发送"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </main>
  );
}
