"use client";

import { useEffect, useRef, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import ChatList from "./component/ChatList";
import CustomTitleBar from "./component/CustomTitleBar";
import { AVAILABLE_MODELS } from "./const/modelList";
import {
  AttachedFile,
  ChatSession,
  Message,
  WorkspaceProject,
} from "./const/pageConst";
import { parseSelectedFile } from "./utils/fileParser";
import ApiKeyModal from "./component/ApiKeyModal";
import ChatSidebar from "./component/ChatSidebar";
import ModelSelector from "./component/ModelSelector";

const MAX_CONTEXT_MESSAGES = 24;

function welcome(mode: "qa" | "code", project?: WorkspaceProject): Message[] {
  return [
    {
      role: "assistant",
      content:
        mode === "code"
          ? `已进入 ${project?.name || "项目"} 的 Code Agent。代码索引可用于快速定位文件、符号和相关实现。`
          : "你好，我是独立的问答 Agent。你可以直接问我任何问题。",
    },
  ];
}

type WorkspaceResponse = {
  projects: WorkspaceProject[];
  sessions: ChatSession[];
};

type InteractiveRequest = {
  id: string;
  command: string;
  prompt: string;
  mode: "normal" | "pty";
  suggestedMode: "auto" | "llm" | "user";
  options: Array<{ label: string; value: string }>;
  promptRound: number;
  recentOutput: string;
};

type ToolActivity = {
  id: string;
  label: string;
  status: "running" | "completed" | "error";
  startedAt: number;
  endedAt?: number;
};

type StreamPacket = {
  type?: "TEXT" | "STATUS" | "TOOL_STATUS" | "USAGE" | "INTERACTIVE_REQUEST";
  content?: string | { prompt: number; completion: number; total: number };
  payload?: InteractiveRequest;
};

export default function Home() {
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolActivities, setToolActivities] = useState<ToolActivity[]>([]);
  const [agentStatus, setAgentStatus] = useState("");
  const [attachedFile, setAttachedFile] = useState<AttachedFile | null>(null);
  const [isParsingFile, setIsParsingFile] = useState(false);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [selectedModel, setSelectedModel] = useState("qwen3.7-max-2026-05-20");
  const [tokenInfo, setTokenInfo] = useState<{
    prompt: number;
    completion: number;
    total: number;
  } | null>(null);
  const [interactiveRequest, setInteractiveRequest] =
    useState<InteractiveRequest | null>(null);
  const [interactiveAnswer, setInteractiveAnswer] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const finalTextRef = useRef("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeSession = sessions.find(
    (session) => session.id === activeSessionId,
  );
  const activeProject = projects.find(
    (project) => project.id === activeSession?.projectId,
  );

  const refreshWorkspace = async (): Promise<WorkspaceResponse> => {
    const response = await fetch("/api/workspace", { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取本地工作区数据");
    const workspace = (await response.json()) as WorkspaceResponse;
    setProjects(workspace.projects);
    setSessions(workspace.sessions);
    return workspace;
  };

  const createSession = async (
    mode: "qa" | "code",
    projectId: string | null = null,
  ) => {
    if (mode === "code" && !projectId) return;
    const project = projects.find((item) => item.id === projectId);
    const initialMessages = welcome(mode, project);
    const response = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "createSession",
        mode,
        projectId,
        title: "新对话",
        messages: initialMessages,
      }),
    });
    if (!response.ok)
      throw new Error((await response.json()).error || "创建会话失败");
    const { session } = (await response.json()) as { session: ChatSession };
    setSessions((current) => [session, ...current]);
    setActiveSessionId(session.id);
    setMessages(session.messages);
    setInput("");
    setTokenInfo(null);
  };

  useEffect(() => {
    const initialize = async () => {
      try {
        const workspace = await refreshWorkspace();
        if (workspace.sessions.length) {
          setActiveSessionId(workspace.sessions[0].id);
          setMessages(workspace.sessions[0].messages);
        } else {
          await createSession("qa");
        }
      } catch (error) {
        console.error(error);
      }
    };
    initialize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const checkAuth = async () => {
      const response = await fetch("/api/config");
      const { hasDefaultKey } = await response.json();
      const savedKey = localStorage.getItem("DASHSCOPE_API_KEY") || "";
      setApiKey(savedKey);
      if (!hasDefaultKey && !savedKey) setShowKeyModal(true);
    };
    checkAuth();
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const persistSession = async (
    session: ChatSession,
    nextMessages: Message[],
    title = session.title,
  ) => {
    await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "updateSession",
        id: session.id,
        title,
        messages: nextMessages,
      }),
    });
  };

  const switchSession = (id: string) => {
    if (isStreaming || id === activeSessionId) return;
    const session = sessions.find((item) => item.id === id);
    if (!session) return;
    setActiveSessionId(id);
    setMessages(session.messages);
    setInput("");
    setAttachedFile(null);
    setToolActivities([]);
    setAgentStatus("");
    setTokenInfo(null);
    setInteractiveRequest(null);
    setInteractiveAnswer("");
  };

  const deleteSession = async (id: string, event: React.MouseEvent) => {
    event.stopPropagation();
    if (isStreaming) return;
    const remaining = sessions.filter((session) => session.id !== id);
    await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "deleteSession", id }),
    });
    setSessions(remaining);
    if (activeSessionId === id) {
      if (remaining[0]) switchSession(remaining[0].id);
      else void createSession("qa");
    }
  };

  const reindexProject = async (projectId: string) => {
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? { ...project, indexStatus: "indexing" }
          : project,
      ),
    );
    try {
      const response = await fetch(`/api/projects/${projectId}/index`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("索引失败");
      await refreshWorkspace();
    } catch (error) {
      console.error(error);
      setProjects((current) =>
        current.map((project) =>
          project.id === projectId
            ? { ...project, indexStatus: "error" }
            : project,
        ),
      );
    }
  };

  const addProject = async () => {
    try {
      // Electron's preload deliberately exposes only the directory picker.
      // @ts-expect-error preload API is injected by Electron at runtime.
      const rootPath = await window.electronAPI?.selectFolder?.();
      if (!rootPath) return;
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "createProject", rootPath }),
      });
      if (!response.ok)
        throw new Error((await response.json()).error || "添加项目失败");
      const { project } = (await response.json()) as {
        project: WorkspaceProject;
      };
      await refreshWorkspace();
      await createSession("code", project.id);
      void reindexProject(project.id);
    } catch (error) {
      console.error(error);
    }
  };

  const handleFileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsParsingFile(true);
    try {
      setAttachedFile(await parseSelectedFile(file));
    } finally {
      setIsParsingFile(false);
    }
  };

  const handleSaveKey = (key?: string) => {
    if (key) {
      localStorage.setItem("DASHSCOPE_API_KEY", key);
      setApiKey(key);
    }
    setShowKeyModal(false);
  };

  const submitPrompt = async (
    promptText: string,
    fileOverride: AttachedFile | null = attachedFile,
  ) => {
    if (!activeSession || isStreaming || isParsingFile) return;
    const prompt = promptText.trim();
    if (!prompt && !fileOverride) return;
    const userContent =
      fileOverride && !fileOverride.type.startsWith("image/")
        ? `${prompt || "请分析这份文件"}\n\n--- ${fileOverride.name} ---\n${fileOverride.textContent || ""}`
        : prompt;
    const history: Message[] = [
      ...messages,
      { role: "user", content: userContent },
      { role: "assistant", content: "" },
    ];
    const title =
      activeSession.title === "新对话"
        ? prompt.slice(0, 18) || fileOverride?.name || "新对话"
        : activeSession.title;
    const optimisticSession = { ...activeSession, title, messages: history };
    setSessions((current) =>
      current.map((session) =>
        session.id === activeSession.id ? optimisticSession : session,
      ),
    );
    setMessages(history);
    void persistSession(activeSession, history, title);
    setInput("");
    setAttachedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setIsStreaming(true);
    setToolActivities([]);
    setAgentStatus("正在准备执行计划…");
    setTokenInfo(null);
    setInteractiveAnswer("");
    let nextInteractiveRequest: InteractiveRequest | null = null;
    finalTextRef.current = "";
    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const response = await fetch(
        activeSession.mode === "code" ? "/api/chat" : "/api/qa",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-dashscope-api-key": apiKey,
            "x-dashscope-model": selectedModel,
          },
          body: JSON.stringify({
            messages: history.slice(-MAX_CONTEXT_MESSAGES),
            sessionId: activeSession.id,
            workingDir: activeProject?.rootPath || "",
            projectId: activeProject?.id || "",
          }),
          signal: abortController.signal,
        },
      );
      if (!response.ok || !response.body) throw new Error("模型请求失败");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const packet = JSON.parse(line.slice(5).trim()) as StreamPacket;
            const streamContent = packet.content;
            if (packet.type === "TEXT" && typeof streamContent === "string") {
              finalTextRef.current += streamContent;
              setAgentStatus("");
              setMessages((current) => [
                ...current.slice(0, -1),
                { role: "assistant", content: finalTextRef.current },
              ]);
            } else if (
              packet.type === "TOOL_STATUS" &&
              typeof streamContent === "string"
            ) {
              const label = streamContent.trim();
              // eslint-disable-next-line react-hooks/purity
              const now = Date.now();
              setAgentStatus("Agent 正在执行工具调用…");
              setToolActivities((current) => {
                const last = current[current.length - 1];
                if (last?.status === "running" && last.label === label) {
                  return current;
                }

                const completed = current.map((activity) =>
                  activity.status === "running"
                    ? {
                        ...activity,
                        status: "completed" as const,
                        endedAt: now,
                      }
                    : activity,
                );

                return [
                  ...completed,
                  {
                    id: `tool_${now}_${Math.random().toString(36).slice(2, 7)}`,
                    label,
                    status: "running" as const,
                    startedAt: now,
                  },
                ].slice(-8);
              });
            } else if (
              packet.type === "STATUS" &&
              typeof streamContent === "string" &&
              !finalTextRef.current
            ) {
              setAgentStatus(streamContent);
            } else if (
              packet.type === "USAGE" &&
              streamContent &&
              typeof streamContent !== "string"
            ) {
              setTokenInfo(streamContent);
            } else if (packet.type === "INTERACTIVE_REQUEST" && packet.payload) {
              nextInteractiveRequest = packet.payload;
              setInteractiveRequest(packet.payload);
              setInteractiveAnswer("");
            }
          } catch {
            /* Ignore incomplete SSE frames. */
          }
        }
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        finalTextRef.current ||= "⚠️ 请求失败，请检查模型配置后重试。";
        setToolActivities((current) =>
          current.map((activity) =>
            activity.status === "running"
              ? { ...activity, status: "error" as const, endedAt: Date.now() }
              : activity,
          ),
        );
      }
    } finally {
      setToolActivities((current) =>
        current.map((activity) =>
          activity.status === "running"
            ? { ...activity, status: "completed" as const, endedAt: Date.now() }
            : activity,
        ),
      );
      const answer =
        finalTextRef.current ||
        (nextInteractiveRequest ? "终端正在等待你的选择。" : "已停止生成。");
      const finalHistory = [
        ...history.slice(0, -1),
        { role: "assistant" as const, content: answer },
      ];
      setMessages(finalHistory);
      const finalSession = { ...activeSession, title, messages: finalHistory };
      setSessions((current) =>
        current.map((session) =>
          session.id === activeSession.id ? finalSession : session,
        ),
      );
      void persistSession(activeSession, finalHistory, title);
      abortRef.current = null;
      setIsStreaming(false);
      setAgentStatus("");
      setInteractiveRequest(nextInteractiveRequest);
    }
  };

  const handleInteractiveReply = async (
    mode: "auto" | "llm" | "user",
    answer?: string,
  ) => {
    if (!interactiveRequest || isStreaming) return;
    const normalizedAnswer =
      mode === "user"
        ? (answer ?? interactiveAnswer).replace(/\r?\n/g, "")
        : answer;
    const prompt = [
      `[INTERACTIVE_REPLY] id=${interactiveRequest.id} mode=${mode}`,
      mode === "user"
        ? `answer=${normalizedAnswer === "" ? "__ENTER__" : normalizedAnswer}`
        : normalizedAnswer
          ? `answer=${normalizedAnswer}`
          : "",
    ]
      .filter(Boolean)
      .join(" ");
    setInteractiveAnswer("");
    await submitPrompt(prompt, null);
  };

  return (
    <main
      className="relative flex h-screen flex-col overflow-hidden"
      style={{
        background:
          "radial-gradient(circle at 72% 12%, rgba(10,132,255,0.09), transparent 28%), radial-gradient(circle at 45% 95%, rgba(191,90,242,0.055), transparent 30%), #0b0b0d",
        color: "#f5f5f7",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI', sans-serif",
      }}
    >
      <ApiKeyModal isOpen={showKeyModal} onSave={handleSaveKey} />
      <CustomTitleBar />

      <div
        className="flex min-h-0 flex-1 border-t"
        style={{ borderColor: "rgba(255,255,255,0.055)" }}
      >
        <ChatSidebar
          sessions={sessions}
          projects={projects}
          activeSessionId={activeSessionId}
          isStreaming={isStreaming}
          createQaSession={() => void createSession("qa")}
          createCodeSession={(projectId) =>
            void createSession("code", projectId)
          }
          addProject={() => void addProject()}
          reindexProject={(projectId) => void reindexProject(projectId)}
          switchSession={switchSession}
          deleteSession={deleteSession}
        />

        <section className="relative flex min-w-0 flex-1 flex-col">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-24"
            style={{
              background:
                "linear-gradient(180deg, rgba(11,11,13,0.78), transparent)",
            }}
          />

          <div className="relative mx-auto flex min-h-0 w-full max-w-[1100px] flex-1 flex-col px-5 pb-4 pt-4 lg:px-8">
            <header
              className="mb-3 flex h-[58px] shrink-0 items-center justify-between rounded-[18px] border px-4"
              style={{
                background: "rgba(255,255,255,0.043)",
                borderColor: "rgba(255,255,255,0.075)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
                backdropFilter: "blur(24px) saturate(130%)",
                WebkitBackdropFilter: "blur(24px) saturate(130%)",
              }}
            >
              <div className="flex min-w-0 items-center gap-3">
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] border"
                  style={{
                    background:
                      activeSession?.mode === "code"
                        ? "rgba(10,132,255,0.13)"
                        : "rgba(191,90,242,0.12)",
                    borderColor: "rgba(255,255,255,0.085)",
                    color:
                      activeSession?.mode === "code" ? "#64b5ff" : "#d6a5ff",
                  }}
                >
                  {activeSession?.mode === "code" ? (
                    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none">
                      <path
                        d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none">
                      <path
                        d="M5.2 5h13.6A2.2 2.2 0 0 1 21 7.2v7.3a2.2 2.2 0 0 1-2.2 2.2h-7.2L7 19.3l.8-2.6H5.2A2.2 2.2 0 0 1 3 14.5V7.2A2.2 2.2 0 0 1 5.2 5Z"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </div>
                <div className="min-w-0">
                  <h1 className="truncate text-[15px] font-semibold tracking-[-0.015em]">
                    {activeSession?.mode === "code" ? "Code Agent" : "QA Agent"}
                  </h1>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-white/35">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        activeProject?.indexStatus === "indexing"
                          ? "animate-pulse"
                          : ""
                      }`}
                      style={{
                        background: activeProject
                          ? activeProject.indexStatus === "ready"
                            ? "#30d158"
                            : activeProject.indexStatus === "error"
                              ? "#ff453a"
                              : "#ffd60a"
                          : "rgba(255,255,255,0.25)",
                      }}
                    />
                    <span className="truncate">
                      {activeProject
                        ? `${activeProject.name} · ${
                            activeProject.indexStatus === "ready"
                              ? "本地索引已就绪"
                              : activeProject.indexStatus === "error"
                                ? "索引异常"
                                : "代码索引处理中"
                          }`
                        : "独立问答，不读取本地项目"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {tokenInfo && (
                  <span
                    className="hidden h-8 items-center gap-1.5 rounded-[10px] border px-2.5 font-mono text-[10px] tabular-nums sm:flex"
                    style={{
                      background: "rgba(255,255,255,0.045)",
                      borderColor: "rgba(255,255,255,0.075)",
                      color: "rgba(235,235,245,0.45)",
                    }}
                    title={`输入 ${tokenInfo.prompt} · 输出 ${tokenInfo.completion}`}
                  >
                    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
                      <path
                        d="m11.5 2.8-6 8h4l-1 6.4 6-8h-4l1-6.4Z"
                        fill="#ffd60a"
                      />
                    </svg>
                    {tokenInfo.total}
                  </span>
                )}

                {isStreaming && (
                  <button
                    type="button"
                    onClick={() => abortRef.current?.abort()}
                    className="flex h-8 items-center gap-1.5 rounded-[10px] border px-2.5 text-[11px] font-medium transition-colors hover:bg-white/[0.055]"
                    style={{
                      background: "rgba(255,69,58,0.08)",
                      borderColor: "rgba(255,69,58,0.16)",
                      color: "#ff6961",
                    }}
                  >
                    <span className="h-2.5 w-2.5 rounded-[3px] bg-current" />
                    停止
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setShowKeyModal(true)}
                  className="flex h-8 w-8 items-center justify-center rounded-[10px] border transition-colors hover:bg-white/[0.06]"
                  style={{
                    background: "rgba(255,255,255,0.045)",
                    borderColor: "rgba(255,255,255,0.075)",
                    color: "rgba(235,235,245,0.52)",
                  }}
                  title="API Key 设置"
                >
                  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
                    <path
                      d="M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <path
                      d="M16.1 11.2c.05-.39.05-.79 0-1.18l1.45-1.12-1.45-2.5-1.7.7a6.3 6.3 0 0 0-1.03-.6L13.1 4.7h-2.9l-.27 1.82c-.37.16-.71.36-1.03.6l-1.7-.7-1.45 2.5 1.45 1.12a5.8 5.8 0 0 0 0 1.18l-1.45 1.12 1.45 2.5 1.7-.7c.32.24.66.44 1.03.6l.27 1.82h2.9l.27-1.82c.37-.16.71-.36 1.03-.6l1.7.7 1.45-2.5-1.45-1.12Z"
                      stroke="currentColor"
                      strokeWidth="1.15"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
            </header>

            <ChatList
              key={activeSessionId}
              messages={messages}
              isStreaming={isStreaming}
              toolActivities={toolActivities}
              agentStatus={agentStatus}
            />

            <div className="shrink-0 pt-2">
              {interactiveRequest && !isStreaming && (
                <section
                  className="mb-3 overflow-hidden rounded-[20px] border"
                  style={{
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.075), rgba(255,255,255,0.04))",
                    borderColor: "rgba(10,132,255,0.22)",
                    boxShadow:
                      "0 18px 45px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.055)",
                  }}
                >
                  <div className="flex items-start gap-3 px-4 py-3.5">
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]"
                      style={{
                        background: "rgba(10,132,255,0.13)",
                        color: "#64b5ff",
                      }}
                    >
                      <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none">
                        <path
                          d="M5 6.5h14v11H5z"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinejoin="round"
                        />
                        <path
                          d="m8 10 2 2-2 2M12.5 14h3.5"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[13px] font-semibold">终端需要你的选择</div>
                          <div className="mt-0.5 text-[10px] text-white/35">
                            第 {interactiveRequest.promptRound} 次交互 · 保持当前进程
                          </div>
                        </div>
                        <span
                          className="rounded-full px-2 py-1 font-mono text-[9px] uppercase"
                          style={{
                            background: "rgba(10,132,255,0.11)",
                            color: "#64b5ff",
                          }}
                        >
                          {interactiveRequest.mode}
                        </span>
                      </div>

                      <div className="mt-3 text-[11px] text-white/45">运行命令</div>
                      <div
                        className="mt-1 rounded-[10px] border px-3 py-2 font-mono text-[11px] leading-5"
                        style={{
                          background: "rgba(0,0,0,0.24)",
                          borderColor: "rgba(255,255,255,0.075)",
                          color: "rgba(245,245,247,0.82)",
                        }}
                      >
                        {interactiveRequest.command}
                      </div>

                      <div className="mt-3 whitespace-pre-wrap text-[12px] leading-5 text-white/65">
                        {interactiveRequest.prompt}
                      </div>
                    </div>
                  </div>

                  <div
                    className="mx-4 max-h-40 overflow-auto rounded-[12px] border p-3 font-mono text-[10px] leading-5 whitespace-pre-wrap"
                    style={{
                      background: "rgba(0,0,0,0.28)",
                      borderColor: "rgba(255,255,255,0.07)",
                      color: "rgba(235,235,245,0.52)",
                    }}
                  >
                    {interactiveRequest.recentOutput || "终端正在等待更多输出…"}
                  </div>

                  <div className="flex flex-wrap gap-2 px-4 pb-3 pt-3">
                    {interactiveRequest.options.map((option, index) => (
                      <button
                        key={`${interactiveRequest.id}-${option.value}`}
                        type="button"
                        onClick={() =>
                          void handleInteractiveReply("user", option.value)
                        }
                        className="rounded-[10px] border px-3 py-2 text-[11px] font-medium transition-all hover:-translate-y-px active:translate-y-0"
                        style={{
                          background:
                            index === 0
                              ? "linear-gradient(180deg, #168dff, #0879eb)"
                              : "rgba(255,255,255,0.055)",
                          borderColor:
                            index === 0
                              ? "rgba(10,132,255,0.46)"
                              : "rgba(255,255,255,0.085)",
                          color: index === 0 ? "white" : "rgba(245,245,247,0.72)",
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => void handleInteractiveReply("auto")}
                      className="rounded-[10px] border px-3 py-2 text-[11px] font-medium transition-colors hover:bg-white/[0.06]"
                      style={{
                        background: "rgba(255,255,255,0.045)",
                        borderColor: "rgba(255,255,255,0.08)",
                        color: "rgba(235,235,245,0.55)",
                      }}
                    >
                      自动选择
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleInteractiveReply("llm")}
                      className="rounded-[10px] border px-3 py-2 text-[11px] font-medium transition-colors hover:bg-white/[0.06]"
                      style={{
                        background: "rgba(255,255,255,0.045)",
                        borderColor: "rgba(255,255,255,0.08)",
                        color: "rgba(235,235,245,0.55)",
                      }}
                    >
                      交给 Agent
                    </button>
                  </div>

                  <div
                    className="flex gap-2 border-t px-4 py-3"
                    style={{ borderColor: "rgba(255,255,255,0.07)" }}
                  >
                    <input
                      value={interactiveAnswer}
                      onChange={(event) => setInteractiveAnswer(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleInteractiveReply("user");
                        }
                      }}
                      placeholder="输入自定义回答，留空表示发送回车"
                      className="h-9 min-w-0 flex-1 rounded-[10px] border bg-black/20 px-3 text-[11px] outline-none placeholder:text-white/20 focus:border-[#0a84ff]"
                      style={{
                        borderColor: "rgba(255,255,255,0.085)",
                        color: "#f5f5f7",
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void handleInteractiveReply("user")}
                      className="h-9 rounded-[10px] px-3 text-[11px] font-semibold text-white transition-all active:scale-[0.98]"
                      style={{ background: "#0a84ff" }}
                    >
                      发送输入
                    </button>
                  </div>
                </section>
              )}

              {attachedFile && (
                <div
                  className="mb-2 flex items-center gap-2 rounded-[12px] border px-3 py-2 text-[11px]"
                  style={{
                    background: "rgba(255,255,255,0.05)",
                    borderColor: "rgba(255,255,255,0.075)",
                    color: "rgba(245,245,247,0.68)",
                  }}
                >
                  <span
                    className="flex h-6 w-6 items-center justify-center rounded-lg"
                    style={{ background: "rgba(10,132,255,0.12)", color: "#64b5ff" }}
                  >
                    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
                      <path
                        d="m7 10.5 4.7-4.7a2.2 2.2 0 0 1 3.1 3.1L9 14.7a3.2 3.2 0 0 1-4.5-4.5l5.1-5.1"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </span>
                  <span className="min-w-0 flex-1 truncate">{attachedFile.name}</span>
                  <button
                    type="button"
                    onClick={() => setAttachedFile(null)}
                    className="flex h-6 w-6 items-center justify-center rounded-full text-[14px] text-white/35 transition-colors hover:bg-white/[0.06] hover:text-white/70"
                  >
                    ×
                  </button>
                </div>
              )}

              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept="image/*,application/pdf,text/*"
                onChange={handleFileSelect}
              />

              <div
                className="rounded-[22px] border p-2.5 transition-all focus-within:border-[rgba(10,132,255,0.36)]"
                style={{
                  background: "rgba(28,28,30,0.82)",
                  borderColor: "rgba(255,255,255,0.09)",
                  boxShadow:
                    "0 20px 55px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.055)",
                  backdropFilter: "blur(30px) saturate(145%)",
                  WebkitBackdropFilter: "blur(30px) saturate(145%)",
                }}
              >
                <TextareaAutosize
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void submitPrompt(input);
                    }
                  }}
                  minRows={2}
                  maxRows={7}
                  disabled={isStreaming || isParsingFile}
                  placeholder={
                    activeSession?.mode === "code"
                      ? "描述要分析、创建或修改的项目任务…"
                      : "输入你的问题…"
                  }
                  className="max-h-44 min-w-0 w-full resize-none bg-transparent px-2.5 pb-2 pt-1.5 text-[13px] leading-6 outline-none placeholder:text-white/25 disabled:opacity-50"
                  style={{ color: "#f5f5f7" }}
                />

                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isStreaming || isParsingFile}
                      className="flex h-9 w-9 items-center justify-center rounded-[11px] border transition-colors hover:bg-white/[0.06] disabled:opacity-40"
                      style={{
                        background: "rgba(255,255,255,0.045)",
                        borderColor: "rgba(255,255,255,0.075)",
                        color: "rgba(235,235,245,0.52)",
                      }}
                      title="添加文件"
                    >
                      {isParsingFile ? (
                        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/15 border-t-white/60" />
                      ) : (
                        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
                          <path
                            d="m7 10.5 4.7-4.7a2.2 2.2 0 0 1 3.1 3.1L9 14.7a3.2 3.2 0 0 1-4.5-4.5l5.1-5.1"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                        </svg>
                      )}
                    </button>
                    <span className="hidden text-[9px] text-white/25 sm:inline">
                      Enter 发送 · Shift+Enter 换行
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <ModelSelector
                      models={AVAILABLE_MODELS}
                      selectedModel={selectedModel}
                      onSelect={setSelectedModel}
                    />
                    <button
                      type="button"
                      onClick={() => void submitPrompt(input)}
                      disabled={
                        isStreaming ||
                        isParsingFile ||
                        (!input.trim() && !attachedFile)
                      }
                      className="flex h-9 w-9 items-center justify-center rounded-[11px] text-white transition-all active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-30"
                      style={{
                        background: "linear-gradient(180deg, #168dff, #0879eb)",
                        boxShadow:
                          "0 8px 18px rgba(10,132,255,0.22), inset 0 1px 0 rgba(255,255,255,0.2)",
                      }}
                      title="发送"
                    >
                      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
                        <path
                          d="M10 15.5v-11M5.5 9 10 4.5 14.5 9"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
