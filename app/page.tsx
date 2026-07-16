// src/app/page.tsx
"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import ChatList from "./component/ChatList";
import ChatSidebar from "./component/ChatSidebar";
import ApiKeyModal from "./component/ApiKeyModal";
import TextareaAutosize from "react-textarea-autosize";
import {
  Message,
  AttachedFile,
  ChatSession,
  StreamPacket,
} from "./const/pageConst";
import CustomTitleBar from "./component/CustomTitleBar";
import ModelSelector from "./component/ModelSelector";
import { AVAILABLE_MODELS } from "./const/modelList";

// 引入刚刚提取出的独立配置、状态工具、解析函数
import { T } from "./const/theme";
import { createSessionId } from "./utils/uuid";
import { openDB } from "./utils/db";
import { parseSelectedFile } from "./utils/fileParser";

const MAX_CONTEXT_MESSAGES = 24;

const starterMessages: Message[] = [
  {
    role: "assistant",
    content: "你好，我是你的智能对话机器人，有什么问题可以问我哦！",
  },
];

export default function Home() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");

  const [messages, setMessages] = useState<Message[]>(starterMessages);
  const [input, setInput] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [attachedFile, setAttachedFile] = useState<AttachedFile | null>(null);
  const [isParsingFile, setIsParsingFile] = useState(false);
  const [currentTool, setCurrentTool] = useState<string>(""); 
  const isFetchingRef = useRef(false);
  const finalTextRef = useRef("");
  const [workingDir, setWorkingDir] = useState<string>("");
  const [apiKey, setApiKey] = useState<string>("");
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [selectedModel, setSelectedModel] = useState("qwen3.7-max-2026-05-20");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const clearedSessionRef = useRef<string | null>(null);

  // 1. 初始化鉴权状态
  useEffect(() => {
    async function checkAuth() {
      const res = await fetch("/api/config");
      const { hasDefaultKey } = await res.json();
      const savedKey = localStorage.getItem("DASHSCOPE_API_KEY");

      if (!localStorage.getItem("frist_open")) {
        setShowKeyModal(true);
        localStorage.setItem("frist_open", "true");
      }
      if (!hasDefaultKey && !savedKey) {
        setShowKeyModal(true);
      }
    }
    checkAuth();
  }, []);

  const handleSave = (key?: string) => {
    if (key) {
      localStorage.setItem("DASHSCOPE_API_KEY", key);
      setApiKey(key);
    }
    setShowKeyModal(false);
  };

  const handleSelectFolder = async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const folderPath = await window.electronAPI.selectFolder();
      if (folderPath) {
        setWorkingDir(folderPath);
      }
    } catch (error) {
      console.error("选择文件夹失败:", error);
    }
  };

  // 2. 异步初始化加载 IndexedDB 数据
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
            const isTempLoading =
              msg.role === "assistant" && msg.content === "";
            return !isTempLoading;
          });
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

  // 3. 当切换活跃会话时记录设置表
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

  // 4. 切换会话
  const switchSession = (sessionId: string) => {
    if (isStreaming || sessionId === activeSessionId) return;
    abortRef.current?.abort();
    setIsStreaming(false);
    setCurrentTool("");

    setActiveSessionId(sessionId);
    const targetSession = sessions.find((s) => s.id === sessionId);
    if (targetSession) {
      setMessages(targetSession.messages);
    }
    setInput("");
    setAttachedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // 5. 新增对话
  const createNewSession = async () => {
    if (isStreaming) return;
    abortRef.current?.abort();
    setIsStreaming(false);
    setCurrentTool("");

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

  // 6. 删除特定会话
  const deleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (isStreaming) return;

    if (sessions.length <= 1) {
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

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // 7. 文件选择（调用提取的异步解析工具）
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsParsingFile(true);
    try {
      const parsedData = await parseSelectedFile(file);
      setAttachedFile(parsedData);
    } catch (error) {
      console.error("解析文件发生致命错误:", error);
    } finally {
      setIsParsingFile(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as FormEvent<HTMLFormElement>);
    }
  };

  // 8. 核心流式请求与会话状态处理
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
    setCurrentTool("");

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-dashscope-api-key": apiKey || "",
          "x-dashscope-model": selectedModel ,
        },
        body: JSON.stringify({
          messages: apiMessages,
          sessionId: activeSessionId,
          workingDir: workingDir,
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
              const packet = JSON.parse(rawData) as StreamPacket;

              if (packet && typeof packet === "object") {
                if (packet.type === "TEXT") {
                  const textToken = packet.content || "";
                  if (textToken) {
                    finalTextRef.current += textToken;
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
                else if (packet.type === "TOOL_STATUS") {
                  const toolName = packet.content || "";
                  setCurrentTool(toolName);
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
        console.error("请求中断或失败:", error);
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
      setCurrentTool("");

      if (clearedSessionRef.current === activeSessionId) {
        clearedSessionRef.current = null;
        return;
      }

      if (!finalTextRef.current.trim()) {
        finalTextRef.current =
          "⚠️ 未能获取到大模型的有效回复内容，请检查服务端工作流日志。";
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
    setCurrentTool("");
    setMessages((prevMessages) => [
      ...prevMessages,
      {
        role: "assistant",
        content: "⚠️ 生成已由用户手动停止。",
      },
    ]);
  }


  return (
    <main
      className="h-screen flex flex-col overflow-hidden"
      style={{ background: T.bg, color: T.fg }}
    >
      <ApiKeyModal isOpen={showKeyModal} onSave={handleSave} />
      <div className="shrink-0">
        <CustomTitleBar />
      </div>
      <div className="flex flex-1 overflow-hidden border-t border-gray-700">
        {/* 已经完美抽离出去的高效侧边栏组件 */}
        <ChatSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          isStreaming={isStreaming}
          createNewSession={createNewSession}
          switchSession={switchSession}
          deleteSession={deleteSession}
        />

        {/* 右侧主聊天区域 */}
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
            <div className="flex gap-2 items-center">
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
              <div className=" flex items-center gap-2">
                <label className=" text-gray-500 block">选择模型</label>
                <ModelSelector
                  models={AVAILABLE_MODELS}
                  selectedModel={selectedModel}
                  onSelect={setSelectedModel}
                />
              </div>
              <button
                className="text-gray-400 cursor-pointer hover:text-white"
                onClick={() => setShowKeyModal(true)}
              >
                ⚙️ 设置 API Key
              </button>
            </div>
          </header>

          <ChatList
            key={activeSessionId}
            messages={messages}
            isStreaming={isStreaming}
            currentTool={currentTool}
          />

          {/* 底部固定输入表单区 */}
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
            {workingDir && (
              <div
                className="mb-2 flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs border border-purple-500/30"
                style={{ background: "rgba(139, 92, 246, 0.1)", color: T.fg }}
              >
                <span className="text-base">📁</span>
                <span style={{ color: T.fgSubtle }}>当前操作目录:</span>
                <span className="flex-1 truncate font-mono font-medium text-purple-400">
                  {workingDir}
                </span>
                <button
                  type="button"
                  onClick={() => setWorkingDir("")}
                  className="hover:text-red-400"
                  title="清除目录"
                >
                  ✕
                </button>
              </div>
            )}
            <form className="flex flex-col gap-2 " onSubmit={handleSubmit}>
              <div className="flex items-center  gap-2">
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
                <button
                  type="button"
                  onClick={handleSelectFolder}
                  className="flex items-center justify-center rounded-lg px-3.5 text-xl transition-all hover:opacity-80 active:scale-95"
                  style={{
                    background: T.surface,
                    color: T.fgMuted,
                    border: `1px solid ${T.border}`,
                  }}
                  title="选择工作目录"
                  disabled={isStreaming || isParsingFile}
                >
                  📁
                </button>
              </div>
              <div
                className="mt-2 relative flex items-center gap-2 text-xs"
                style={{ color: T.fgSubtle }}
              >
                <TextareaAutosize
                  minRows={4}
                  maxRows={4}
                  className="input-glow min-w-0 flex-1 rounded-lg px-4 py-3 text-sm outline-none transition-all resize-none h-25 pr-20"
                  style={{
                    background: T.surface,
                    color: T.fg,
                    border: `1px solid ${T.border}`,
                    lineHeight: "1.5rem",
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