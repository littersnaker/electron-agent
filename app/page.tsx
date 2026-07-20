"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import ApiKeyModal from "./component/ApiKeyModal";
import ChatList from "./component/ChatList";
import ChatSidebar from "./component/ChatSidebar";
import CustomTitleBar from "./component/CustomTitleBar";
import ModelSelector from "./component/ModelSelector";
import { AVAILABLE_MODELS } from "./const/modelList";
import {
  AttachedFile,
  ChatSession,
  Message,
  WorkspaceProject,
} from "./const/pageConst";
import { T } from "./const/theme";
import { parseSelectedFile } from "./utils/fileParser";

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
type StreamPacket = {
  type?: "TEXT" | "STATUS" | "TOOL_STATUS" | "USAGE";
  content?: string | { prompt: number; completion: number; total: number };
};

export default function Home() {
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentTool, setCurrentTool] = useState("");
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
    setCurrentTool("");
    setTokenInfo(null);
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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeSession || isStreaming || isParsingFile) return;
    const prompt = input.trim();
    if (!prompt && !attachedFile) return;
    const userContent =
      attachedFile && !attachedFile.type.startsWith("image/")
        ? `${prompt || "请分析这份文件"}\n\n--- ${attachedFile.name} ---\n${attachedFile.textContent || ""}`
        : prompt;
    const history: Message[] = [
      ...messages,
      { role: "user", content: userContent },
      { role: "assistant", content: "" },
    ];
    const title =
      activeSession.title === "新对话"
        ? prompt.slice(0, 18) || attachedFile?.name || "新对话"
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
    setCurrentTool("");
    setTokenInfo(null);
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
              setMessages((current) => [
                ...current.slice(0, -1),
                { role: "assistant", content: finalTextRef.current },
              ]);
            } else if (
              packet.type === "TOOL_STATUS" &&
              typeof streamContent === "string"
            ) {
              setCurrentTool(streamContent);
            } else if (
              packet.type === "STATUS" &&
              typeof streamContent === "string" &&
              !finalTextRef.current
            ) {
              setMessages((current) => [
                ...current.slice(0, -1),
                { role: "assistant", content: streamContent },
              ]);
            } else if (
              packet.type === "USAGE" &&
              streamContent &&
              typeof streamContent !== "string"
            ) {
              setTokenInfo(streamContent);
            }
          } catch {
            /* Ignore incomplete SSE frames. */
          }
        }
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        finalTextRef.current ||= "⚠️ 请求失败，请检查模型配置后重试。";
    } finally {
      const answer = finalTextRef.current || "已停止生成。";
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
      setCurrentTool("");
    }
  };

  return (
    <main
      className="flex h-screen flex-col overflow-hidden"
      style={{ background: T.bg, color: T.fg }}
    >
      <ApiKeyModal isOpen={showKeyModal} onSave={handleSaveKey} />
      <CustomTitleBar />
      <div className="flex min-h-0 flex-1 border-t border-gray-700">
        {/* 左边选择栏 */}
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
        {/* 右边聊天 */}
        <div className="mx-auto flex min-w-0 max-w-5xl flex-1 flex-col px-6 py-6">
          <header
            className="mb-5 flex items-center justify-between border-b pb-4"
            style={{ borderColor: T.borderSoft }}
          >
            <div>
              <h1 className="text-xl font-semibold text-gradient">
                {activeSession?.mode === "code" ? "Code Agent" : "QA Agent"}
              </h1>
              <p className="mt-0.5 text-xs" style={{ color: T.fgSubtle }}>
                {activeProject
                  ? `${activeProject.name} · ${activeProject.indexStatus === "ready" ? "本地索引已就绪" : "代码索引处理中"}`
                  : "独立问答，不访问本地文件"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {tokenInfo && (
                <span
                  className="rounded-lg border px-3 py-1.5 text-[11px] font-mono"
                  style={{ borderColor: T.border, background: T.surfaceHover }}
                >
                  ⚡ {tokenInfo.total}
                </span>
              )}
              {isStreaming && (
                <button
                  onClick={() => abortRef.current?.abort()}
                  className="rounded-lg border px-3 py-2 text-sm"
                  style={{ borderColor: T.border }}
                >
                  停止
                </button>
              )}
              <button
                onClick={() => setShowKeyModal(true)}
                className="text-xs text-gray-400 hover:text-white"
              >
                ⚙ API Key
              </button>
            </div>
          </header>
          <ChatList
            key={activeSessionId}
            messages={messages}
            isStreaming={isStreaming}
            currentTool={currentTool}
          />
          <div className="border-t pt-4" style={{ borderColor: T.borderSoft }}>
            {attachedFile && (
              <div
                className="mb-2 flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
                style={{ background: T.surfaceHover }}
              >
                <span className="flex-1 truncate">📎 {attachedFile.name}</span>
                <button type="button" onClick={() => setAttachedFile(null)}>
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
              className="flex flex-1 flex-col gap-2 border rounded-lg px-2 py-2  outline-none"
              style={{
                background: T.surface,
                color: T.fg,
                border: `1px solid ${T.border}`,
              }}
            >
              <TextareaAutosize
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    handleSubmit(
                      event as unknown as FormEvent<HTMLFormElement>,
                    );
                  }
                }}
                minRows={4}
                maxRows={6}
                disabled={isStreaming || isParsingFile}
                placeholder={
                  activeSession?.mode === "code"
                    ? "描述要分析或修改的项目任务…"
                    : "输入问题，Shift+Enter 换行…"
                }
                className=" min-w-0 h-full flex-1 resize-none rounded-lg px-4 py-3 pr-0 max-h-30  text-sm outline-none"
              />
              <div className=" flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isStreaming || isParsingFile}
                  className="rounded-lg border px-3 text-lg cursor-pointer"
                  style={{ borderColor: T.border }}
                >
                  📎
                </button>
                <div className="flex items-center gap-2">
                  {" "}
                  <ModelSelector
                    models={AVAILABLE_MODELS}
                    selectedModel={selectedModel}
                    onSelect={setSelectedModel}
                  />
                  <button
                    type="submit"
                    onClick={() => {
                      handleSubmit(
                        event as unknown as FormEvent<HTMLFormElement>,
                      );
                    }}
                    disabled={
                      isStreaming ||
                      isParsingFile ||
                      (!input.trim() && !attachedFile)
                    }
                    className="btn-gradient rounded-lg px-4 py-1 text-sm text-white disabled:opacity-40"
                  >
                    发送
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
