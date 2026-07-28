"use client";
/**
 * 模块职责：聊天流式请求、SSE 消费和会话状态协调。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toMessageAttachments } from "../../constants/page-constants";
import type { AttachedFile, Message } from "../../constants/page-constants";
import { buildRetrievedAttachment } from "../../lib/rag/attachment-rag";
import {
  buildImageAttachmentsPayload,
  buildLlmRequestHeaders,
} from "../../lib/llm/client-request";
import type {
  AgentLifecycleEventPayload,
  InteractiveRequest,
  StreamPacket,
  TokenInfo,
  ToolActivity,
} from "../../types/workspace";
import { inferAgentKind, MAX_CONTEXT_MESSAGES } from "../../utilities/agent-runtime";
import {
  buildRequestUserContent,
  buildVisibleUserContent,
  isAgentLifecyclePayload,
  isInteractiveRequestPayload,
  readResponseError,
  validateCodeWorkspace,
} from "./chat-stream-helpers";
import type {
  SubmitPromptOptions,
  UseChatStreamOptions,
} from "./chat-stream-helpers";

export function useChatStream({
  activeSession,
  activeProject,
  messages,
  setMessages,
  setSessions,
  persistSession,
  apiKeys,
  selectedModel,
  attachedFiles,
  isParsingFile,
  clearAfterSubmit,
  agents,
}: UseChatStreamOptions) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolActivities, setToolActivities] = useState<ToolActivity[]>([]);
  const [agentStatus, setAgentStatus] = useState("");
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [agentLifecycleEvents, setAgentLifecycleEvents] = useState<
    AgentLifecycleEventPayload[]
  >([]);
  const [interactiveRequest, setInteractiveRequest] =
    useState<InteractiveRequest | null>(null);
  const [interactiveAnswer, setInteractiveAnswer] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const finalTextRef = useRef("");
  /** 一旦收到真实 lifecycle，就不再用 STATUS/TOOL_STATUS 文案反推 Agent。 */
  const hasLifecycleRef = useRef(false);

  // Effect 只负责组件卸载清理，不在 Effect 中同步 setState。
  useEffect(() => () => abortRef.current?.abort(), []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const resetTransient = useCallback(() => {
    setToolActivities([]);
    setAgentStatus("");
    setTokenInfo(null);
    setAgentLifecycleEvents([]);
    setInteractiveRequest(null);
    setInteractiveAnswer("");
    hasLifecycleRef.current = false;
  }, []);

  const submitPrompt = useCallback(
    async (
      promptText: string,
      fileOverride: readonly AttachedFile[] = attachedFiles,
      options: SubmitPromptOptions = {},
    ) => {
      if (!activeSession || isStreaming || isParsingFile) return;
      // Commerce 会话必须走独立 /api/commerce/research，禁止意外落入 QA Route。
      if (activeSession.mode === "commerce") return;

      const prompt = promptText.trim();
      if (!prompt && fileOverride.length === 0) return;

      const visibleUserContent = buildVisibleUserContent(prompt, fileOverride);
      const visibleAttachments = toMessageAttachments(fileOverride);
      const suppressVisibleUserMessage =
        options.suppressVisibleUserMessage === true;
      const visibleBaseMessages =
        suppressVisibleUserMessage &&
        interactiveRequest &&
        messages[messages.length - 1]?.role === "assistant"
          ? messages.slice(0, -1)
          : messages;
      const workspaceError = validateCodeWorkspace(
        activeSession,
        activeProject,
      );

      if (workspaceError) {
        const visibleErrorUserMessage: Message[] = suppressVisibleUserMessage
          ? []
          : [
              {
                role: "user",
                content: visibleUserContent,
                attachments: visibleAttachments,
              },
            ];
        const errorHistory: Message[] = [
          ...visibleBaseMessages,
          ...visibleErrorUserMessage,
          { role: "assistant", content: `⚠️ ${workspaceError}` },
        ];
        const title = suppressVisibleUserMessage
          ? activeSession.title
          : activeSession.title === "新对话"
            ? prompt.slice(0, 18) || fileOverride[0]?.name || "新对话"
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
      const retrievedFiles = fileOverride.map((attachment) =>
        buildRetrievedAttachment(attachment, prompt),
      ).filter((attachment): attachment is AttachedFile => Boolean(attachment));
      const requestUserContent = buildRequestUserContent(prompt, retrievedFiles);
      const visibleUserMessages: Message[] = suppressVisibleUserMessage
        ? []
        : [
            {
              role: "user",
              content: visibleUserContent,
              attachments: visibleAttachments,
            },
          ];
      const visibleHistory: Message[] = [
        ...visibleBaseMessages,
        ...visibleUserMessages,
        { role: "assistant", content: "" },
      ];
      const requestMessages = [
        ...messages.map(({ role, content }) => ({ role, content })),
        { role: "user" as const, content: requestUserContent },
      ];
      const title = suppressVisibleUserMessage
        ? activeSession.title
        : activeSession.title === "新对话"
          ? prompt.slice(0, 18) || fileOverride[0]?.name || "新对话"
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
      setAgentLifecycleEvents([]);
      hasLifecycleRef.current = false;
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
              attachments: buildImageAttachmentsPayload(fileOverride),
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
                if (!hasLifecycleRef.current) {
                  agents.activateAgent(inferAgentKind(label), label);
                }
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
                if (!hasLifecycleRef.current) {
                  agents.activateAgent(
                    inferAgentKind(streamContent),
                    streamContent,
                  );
                }
                continue;
              }

              if (
                packet.type === "AGENT_LIFECYCLE" &&
                isAgentLifecyclePayload(packet.payload)
              ) {
                const lifecycleEvent = packet.payload;
                hasLifecycleRef.current = true;
                setAgentLifecycleEvents((current: AgentLifecycleEventPayload[]) => {
                  const next = [...current, lifecycleEvent];
                  // 生命周期只用于当前轮 UI，限制长度避免长任务无限增长前端状态。
                  return next.slice(-240);
                });
                agents.applyLifecycleEvent(lifecycleEvent);
                setAgentStatus(
                  lifecycleEvent.iteration > 0
                    ? `第 ${lifecycleEvent.iteration + 1} 轮返工 · ${lifecycleEvent.detail}`
                    : lifecycleEvent.detail,
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
                isInteractiveRequestPayload(packet.payload)
              ) {
                nextInteractiveRequest = packet.payload;
                setInteractiveRequest(packet.payload);
                setInteractiveAnswer("");
                if (packet.payload.source === "file_create_confirmation") {
                  agents.updateAgent("orchestrator", {
                    status: "running",
                    progress: 38,
                    currentTask: "等待确认是否新建缺失文件",
                  });
                } else if (
                  packet.payload.source === "risk_approval" ||
                  packet.payload.source === "mcp_tool_approval"
                ) {
                  agents.updateAgent("orchestrator", {
                    status: "running",
                    progress: 70,
                    currentTask: "等待用户批准高风险操作",
                  });
                } else {
                  agents.updateAgent("terminal", {
                    status: "running",
                    progress: 72,
                    currentTask: "等待用户提供终端交互输入",
                  });
                }
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

        const waitingMessage =
          nextInteractiveRequest?.source === "file_create_confirmation"
            ? "需要你确认是否新建缺失文件后才能继续。"
            : nextInteractiveRequest?.source === "risk_approval"
              ? "检测到高风险工作区写入，需要你批准后才能继续。"
              : nextInteractiveRequest?.source === "mcp_tool_approval"
                ? "MCP 工具需要你批准后才能执行。"
                : "终端正在等待你的选择。";
        const answer =
          finalTextRef.current ||
          (nextInteractiveRequest ? waitingMessage : "已停止生成。");
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
      attachedFiles,
      clearAfterSubmit,
      isParsingFile,
      isStreaming,
      interactiveRequest,
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
      await submitPrompt(prompt, [], { suppressVisibleUserMessage: true });
    },
    [interactiveAnswer, interactiveRequest, isStreaming, submitPrompt],
  );

  return {
    isStreaming,
    toolActivities,
    agentStatus,
    tokenInfo,
    agentLifecycleEvents,
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
