"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
  AttachedFile,
  ChatSession,
  Message,
  WorkspaceProject,
} from "../const/pageConst";
import type {
  InteractiveRequest,
  StreamPacket,
  TokenInfo,
  ToolActivity,
} from "../types/workspace";
import { inferAgentKind, MAX_CONTEXT_MESSAGES } from "../utils/agentRuntime";
import type { AgentCoordinator } from "./useAgentCoordinator";

type PersistSession = (
  session: ChatSession,
  nextMessages: Message[],
  title?: string,
) => Promise<void>;

interface UseChatStreamOptions {
  activeSession?: ChatSession;
  activeProject?: WorkspaceProject;
  messages: Message[];
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setSessions: Dispatch<SetStateAction<ChatSession[]>>;
  persistSession: PersistSession;
  apiKey: string;
  selectedModel: string;
  attachedFile: AttachedFile | null;
  isParsingFile: boolean;
  setInput: Dispatch<SetStateAction<string>>;
  clearAfterSubmit: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  agents: AgentCoordinator;
}

export function useChatStream({
  activeSession,
  activeProject,
  messages,
  setMessages,
  setSessions,
  persistSession,
  apiKey,
  selectedModel,
  attachedFile,
  isParsingFile,
  setInput,
  clearAfterSubmit,
  fileInputRef,
  agents,
}: UseChatStreamOptions) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolActivities, setToolActivities] = useState<ToolActivity[]>([]);
  const [agentStatus, setAgentStatus] = useState("");
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [interactiveRequest, setInteractiveRequest] =
    useState<InteractiveRequest | null>(null);
  const [interactiveAnswer, setInteractiveAnswer] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const finalTextRef = useRef("");

  useEffect(() => () => abortRef.current?.abort(), []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const resetTransient = useCallback(() => {
    setToolActivities([]);
    setAgentStatus("");
    setTokenInfo(null);
    setInteractiveRequest(null);
    setInteractiveAnswer("");
  }, []);

  const submitPrompt = useCallback(
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    async (
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
      clearAfterSubmit();
      if (fileInputRef.current) fileInputRef.current.value = "";

      setIsStreaming(true);
      setToolActivities([]);
      agents.beginRun();
      setAgentStatus("Orchestrator 正在准备执行计划…");
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

        if (!response.ok || !response.body) {
          throw new Error("模型请求失败");
        }

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
                agents.markFinalResponse();
                setMessages((current) => [
                  ...current.slice(0, -1),
                  { role: "assistant", content: finalTextRef.current },
                ]);
                continue;
              }

              if (
                packet.type === "TOOL_STATUS" &&
                typeof streamContent === "string"
              ) {
                const label = streamContent.trim();
                const now = Date.now();

                agents.activateAgent(inferAgentKind(label), label);
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
                continue;
              }

              if (
                packet.type === "STATUS" &&
                typeof streamContent === "string" &&
                !finalTextRef.current
              ) {
                setAgentStatus(streamContent);
                agents.activateAgent(
                  inferAgentKind(streamContent),
                  streamContent,
                );
                continue;
              }

              if (
                packet.type === "AGENT_START" ||
                packet.type === "AGENT_STATUS" ||
                packet.type === "AGENT_PROGRESS" ||
                packet.type === "AGENT_FINISH" ||
                packet.type === "AGENT_ERROR"
              ) {
                agents.applyAgentEvent(
                  packet.type,
                  packet.agent,
                  typeof streamContent === "string" ? streamContent : "",
                );
                continue;
              }

              if (
                packet.type === "USAGE" &&
                streamContent &&
                typeof streamContent !== "string"
              ) {
                setTokenInfo(streamContent);
                continue;
              }

              if (
                packet.type === "INTERACTIVE_REQUEST" &&
                packet.payload
              ) {
                nextInteractiveRequest = packet.payload;
                setInteractiveRequest(packet.payload);
                setInteractiveAnswer("");
                agents.updateAgent("terminal", {
                  status: "running",
                  progress: 72,
                  currentTask: "等待用户提供终端交互输入",
                });
              }
            } catch {
              // 忽略不完整的 SSE 帧，等待下一段数据补齐。
            }
          }
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          finalTextRef.current ||= "⚠️ 请求失败，请检查模型配置后重试。";
          agents.failRunningAgents();
          setToolActivities((current) =>
            current.map((activity) =>
              activity.status === "running"
                ? {
                    ...activity,
                    status: "error" as const,
                    endedAt: Date.now(),
                  }
                : activity,
            ),
          );
        }
      } finally {
        setToolActivities((current) =>
          current.map((activity) =>
            activity.status === "running"
              ? {
                  ...activity,
                  status: "completed" as const,
                  endedAt: Date.now(),
                }
              : activity,
          ),
        );
        agents.finalizeAgents(nextInteractiveRequest);

        const answer =
          finalTextRef.current ||
          (nextInteractiveRequest ? "终端正在等待你的选择。" : "已停止生成。");
        const finalHistory: Message[] = [
          ...history.slice(0, -1),
          { role: "assistant", content: answer },
        ];
        const finalSession = {
          ...activeSession,
          title,
          messages: finalHistory,
        };

        setMessages(finalHistory);
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
    },
    [
      activeProject?.id,
      activeProject?.rootPath,
      activeSession,
      agents,
      apiKey,
      attachedFile,
      clearAfterSubmit,
      fileInputRef,
      isParsingFile,
      isStreaming,
      messages,
      persistSession,
      selectedModel,
      setInput,
      setMessages,
      setSessions,
    ],
  );

  const handleInteractiveReply = useCallback(
    async (mode: "auto" | "llm" | "user", answer?: string) => {
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
    },
    [interactiveAnswer, interactiveRequest, isStreaming, submitPrompt],
  );

  return {
    isStreaming,
    toolActivities,
    agentStatus,
    tokenInfo,
    interactiveRequest,
    interactiveAnswer,
    setInteractiveAnswer,
    submitPrompt,
    handleInteractiveReply,
    stop,
    resetTransient,
  };
}

export type ChatStreamController = ReturnType<typeof useChatStream>;
