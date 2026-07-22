"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  AttachedFile,
  ChatSession,
  Message,
  WorkspaceProject,
} from "../const/pageConst";
import { buildRetrievedAttachment } from "../lib/rag/attachment-rag";
import {
  buildImageAttachmentPayload,
  buildLlmRequestHeaders,
} from "../lib/llm/client-request";
import type { LlmCredentials } from "../lib/llm/types";
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
  apiKeys: LlmCredentials;
  selectedModel: string;
  attachedFile: AttachedFile | null;
  isParsingFile: boolean;
  clearAfterSubmit: () => void;
  agents: AgentCoordinator;
}

function buildVisibleUserContent(
  prompt: string,
  attachment: AttachedFile | null,
): string {
  if (!attachment) return prompt;
  return [prompt || "请分析这份文件", `📎 ${attachment.name}`].join("\n\n");
}

function buildRequestUserContent(
  prompt: string,
  attachment: AttachedFile | null,
): string {
  if (!attachment || attachment.type.startsWith("image/")) return prompt;

  return [
    prompt || "请分析这份文件",
    `--- ${attachment.name} ---`,
    attachment.textContent || "",
  ].join("\n\n");
}

function validateCodeWorkspace(
  session: ChatSession,
  project?: WorkspaceProject,
): string | null {
  if (session.mode !== "code") return null;
  if (!project) return "当前 Code 会话绑定的项目不存在，请重新选择项目。";
  if (!project.rootPath.trim()) {
    return "当前 Code 会话没有有效工作目录，请重新添加项目。";
  }
  return null;
}

async function readResponseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    // 非 JSON 错误响应继续使用状态码兜底。
  }
  return `模型请求失败（HTTP ${response.status}）`;
}

export function useChatStream({
  activeSession,
  activeProject,
  messages,
  setMessages,
  setSessions,
  persistSession,
  apiKeys,
  selectedModel,
  attachedFile,
  isParsingFile,
  clearAfterSubmit,
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

  // Effect 只负责组件卸载清理，不在 Effect 中同步 setState。
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
    async (
      promptText: string,
      fileOverride: AttachedFile | null = attachedFile,
    ) => {
      if (!activeSession || isStreaming || isParsingFile) return;

      const prompt = promptText.trim();
      if (!prompt && !fileOverride) return;

      const visibleUserContent = buildVisibleUserContent(prompt, fileOverride);
      const workspaceError = validateCodeWorkspace(
        activeSession,
        activeProject,
      );

      if (workspaceError) {
        const errorHistory: Message[] = [
          ...messages,
          { role: "user", content: visibleUserContent },
          { role: "assistant", content: `⚠️ ${workspaceError}` },
        ];
        const title =
          activeSession.title === "新对话"
            ? prompt.slice(0, 18) || fileOverride?.name || "新对话"
            : activeSession.title;
        const failedSession = {
          ...activeSession,
          title,
          messages: errorHistory,
        };

        setMessages(errorHistory);
        setSessions((current) =>
          current.map((session) =>
            session.id === activeSession.id ? failedSession : session,
          ),
        );
        void persistSession(activeSession, errorHistory, title);
        clearAfterSubmit();
        return;
      }

      /**
       * RAG 只在提交瞬间执行一次。
       * 页面输入变化不会反复切片或检索，原始附件也不会被修改。
       */
      const retrievedFile = buildRetrievedAttachment(fileOverride, prompt);
      const requestUserContent = buildRequestUserContent(
        prompt,
        retrievedFile,
      );
      const visibleHistory: Message[] = [
        ...messages,
        { role: "user", content: visibleUserContent },
        { role: "assistant", content: "" },
      ];
      const requestMessages: Message[] = [
        ...messages,
        { role: "user", content: requestUserContent },
      ];
      const title =
        activeSession.title === "新对话"
          ? prompt.slice(0, 18) || fileOverride?.name || "新对话"
          : activeSession.title;
      const optimisticSession = {
        ...activeSession,
        title,
        messages: visibleHistory,
      };

      setSessions((current) =>
        current.map((session) =>
          session.id === activeSession.id ? optimisticSession : session,
        ),
      );
      setMessages(visibleHistory);
      void persistSession(activeSession, visibleHistory, title);
      clearAfterSubmit();

      setIsStreaming(true);
      setToolActivities([]);
      agents.beginRun();
      setAgentStatus(
        activeSession.mode === "code"
          ? "Orchestrator 正在识别任务类型…"
          : "正在准备回答…",
      );
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
            headers: buildLlmRequestHeaders(apiKeys, selectedModel),
            body: JSON.stringify({
              messages: requestMessages.slice(-MAX_CONTEXT_MESSAGES),
              attachments: buildImageAttachmentPayload(fileOverride),
              sessionId: activeSession.id,
              workingDir: activeProject?.rootPath || "",
              projectId: activeProject?.id || "",
            }),
            signal: abortController.signal,
          },
        );

        if (!response.ok || !response.body) {
          throw new Error(await readResponseError(response));
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
          const message =
            error instanceof Error ? error.message : "模型请求失败";
          finalTextRef.current ||= `⚠️ ${message}`;
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
          ...visibleHistory.slice(0, -1),
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
      activeProject,
      activeSession,
      agents,
      apiKeys,
      attachedFile,
      clearAfterSubmit,
      isParsingFile,
      isStreaming,
      messages,
      persistSession,
      selectedModel,
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
