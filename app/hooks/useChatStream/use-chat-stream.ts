"use client";
/* eslint-disable max-lines */ // 统一 SSE 消费与多 Agent 路由，文件天然较长。
/**
 * 模块职责：聊天流式请求、SSE 消费和会话状态协调。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toMessageAttachments } from "../../constants/page-constants";
import type { AttachedFile, Message } from "../../constants/page-constants";
import { buildRetrievedAttachment } from "../../lib/rag/attachment-rag";
import { buildImageAttachmentsPayload, buildLlmRequestHeaders } from "../../lib/llm/client-request";
import { apiFetch } from "../../lib/api-client";
import type {
  AgentLifecycleEventPayload,
  InteractiveRequest,
  KnowledgeMetrics,
  KnowledgeSourceItem,
  KnowledgeSourcesPayload,
  StreamPacket,
  TokenInfo,
  ToolActivity,
  VisualVerifyPayload,
  WorkListSnapshotPayload,
} from "../../types/workspace";
import { inferAgentKind, MAX_CONTEXT_MESSAGES } from "../../utilities/agent-runtime";
import {
  applyInteractiveRequestAgents,
  buildInteractiveReplyPrompt,
  buildRequestUserContent,
  buildVisibleUserContent,
  describeWorkListSnapshot,
  isAgentLifecyclePayload,
  isInteractiveRequestPayload,
  isMediaResultPayload,
  isWorkListSnapshotPayload,
  interactiveWaitingMessage,
  readResponseError,
  validateCodeWorkspace,
} from "./chat-stream-helpers";
import type { SubmitPromptOptions, UseChatStreamOptions } from "./chat-stream-helpers";
import { useChatCheckpointBinding } from "./chat-checkpoint-binding";
export function useChatStream({
  activeSession,
  activeProject,
  messages,
  setMessages,
  setSessions,
  persistSession,
  apiKeys,
  endpointOverrides,
  selectedModel,
  codeAgentMode,
  attachedFiles,
  isParsingFile,
  clearAfterSubmit,
  agents,
}: UseChatStreamOptions) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolActivities, setToolActivities] = useState<ToolActivity[]>([]);
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSourceItem[] | null>(null);
  const [knowledgeSearched, setKnowledgeSearched] = useState(false);
  const [knowledgeMetrics, setKnowledgeMetrics] = useState<KnowledgeMetrics | null>(null);
  const [agentStatus, setAgentStatus] = useState("");
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [agentLifecycleEvents, setAgentLifecycleEvents] = useState<AgentLifecycleEventPayload[]>(
    [],
  );
  const [workListSnapshot, setWorkListSnapshot] = useState<WorkListSnapshotPayload | null>(null);
  const [interactiveRequest, setInteractiveRequest] = useState<InteractiveRequest | null>(null);
  const [interactiveAnswer, setInteractiveAnswer] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const finalTextRef = useRef("");
  const mediaAttachmentsRef = useRef<Message["attachments"] | undefined>(undefined);
  const imageResultRef = useRef<Message["imageResult"] | undefined>(undefined);
  const hasLifecycleRef = useRef(false);
  const checkpointBinding = useChatCheckpointBinding();
  useEffect(() => () => abortRef.current?.abort(), []);
  const stop = useCallback(() => abortRef.current?.abort(), []);

  /**
   * 视觉验证：启动项目预览 → Electron 截图 → GLM-4.6V 核对 → 结果追加为消息。
   * 由 VISUAL_VERIFY_REQUESTED 事件触发，fire-and-forget 不阻塞主流程。
   */
  const runVisualVerification = useCallback(
    async (payload: VisualVerifyPayload) => {
      const rootPath = activeProject?.rootPath;
      if (!rootPath || !activeSession || !window.electronAPI?.capturePage) return;
      setAgentStatus("正在启动预览并截图验证页面渲染…");
      try {
        const previewResponse = await apiFetch("/api/visual/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rootPath }),
        });
        if (!previewResponse.ok) return;
        const { url } = (await previewResponse.json()) as { url?: string };
        if (!url) return;
        const { base64 } = await window.electronAPI.capturePage(url);
        const verifyResponse = await apiFetch("/api/visual/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64: base64,
            mimeType: "image/png",
            taskSummary: payload.taskSummary || "",
            acceptance: [],
          }),
        });
        const result = (await verifyResponse.json()) as {
          ok?: boolean;
          content?: string;
          error?: string;
        };
        const content = result.ok
          ? `🖼️ 视觉验证：${result.content || "页面已渲染。"}`
          : `⚠️ 视觉验证失败：${result.error || "未知错误"}`;
        const verifyMessage: Message = { role: "assistant", content };
        setMessages((current) => [...current, verifyMessage]);
        setSessions((current) =>
          current.map((session) =>
            session.id === activeSession.id
              ? { ...session, messages: [...session.messages, verifyMessage] }
              : session,
          ),
        );
      } catch (error) {
        console.warn("[useChatStream] 视觉验证失败", error);
      } finally {
        setAgentStatus("");
      }
    },
    [activeProject?.rootPath, activeSession?.id, setMessages, setSessions],
  );
  const resetTransient = useCallback(() => {
    setToolActivities([]);
    setKnowledgeSources(null);
    setKnowledgeSearched(false);
    setKnowledgeMetrics(null);
    setAgentStatus("");
    setTokenInfo(null);
    setAgentLifecycleEvents([]);
    setWorkListSnapshot(null);
    setInteractiveRequest(null);
    setInteractiveAnswer("");
    mediaAttachmentsRef.current = undefined;
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
      checkpointBinding.capture(options);
      const visibleAttachments = toMessageAttachments(fileOverride);
      const suppressVisibleUserMessage = options.suppressVisibleUserMessage === true;
      const resumeExistingRun = options.resumeExistingRun === true;
      const lastMessage = messages[messages.length - 1];
      const visibleBaseMessages =
        resumeExistingRun && lastMessage?.role === "assistant"
          ? messages.slice(0, -1)
          : suppressVisibleUserMessage && interactiveRequest && lastMessage?.role === "assistant"
            ? messages.slice(0, -1)
            : messages;
      const workspaceError = validateCodeWorkspace(activeSession, activeProject);
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
          current.map((session) => (session.id === activeSession.id ? failedSession : session)),
        );
        void persistSession(activeSession, errorHistory, title).catch((error) => {
          console.warn("[useChatStream] 会话保存失败，重启后消息可能丢失", error);
        });
        clearAfterSubmit();
        await options.onCheckpointFinish?.({ status: "failed", error: workspaceError });
        return;
      }
      /**
       * RAG 只在提交瞬间执行一次。
       * 页面输入变化不会反复切片或检索，原始附件也不会被修改。
       */
      const retrievedFiles = fileOverride
        .map((attachment) => buildRetrievedAttachment(attachment, prompt))
        .filter((attachment): attachment is AttachedFile => Boolean(attachment));
      const requestUserContent = buildRequestUserContent(prompt, retrievedFiles);
      const visibleUserMessages: Message[] =
        suppressVisibleUserMessage || resumeExistingRun
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
      const requestMessages = resumeExistingRun
        ? visibleBaseMessages.map(({ role, content }) => ({ role, content }))
        : [
            ...messages.map(({ role, content }) => ({ role, content })),
            { role: "user" as const, content: requestUserContent },
          ];
      const title =
        suppressVisibleUserMessage || resumeExistingRun
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
        current.map((session) => (session.id === activeSession.id ? optimisticSession : session)),
      );
      setMessages(visibleHistory);
      void persistSession(activeSession, visibleHistory, title).catch((error) => {
        console.warn("[useChatStream] 会话保存失败，重启后消息可能丢失", error);
      });
      clearAfterSubmit();
      setIsStreaming(true);
      setToolActivities([]);
      agents.beginRun();
      setAgentStatus(
        activeSession.mode === "code" ? "Orchestrator 正在识别任务类型…" : "正在准备回答…",
      );
      setTokenInfo(null);
      setAgentLifecycleEvents([]);
      setWorkListSnapshot(null);
      hasLifecycleRef.current = false;
      setInteractiveAnswer("");
      let nextInteractiveRequest: InteractiveRequest | null = null;
      let checkpointResult: import("../../types/checkpoints").CheckpointFinishResult = {
        status: "completed",
      };
      finalTextRef.current = "";
      mediaAttachmentsRef.current = undefined;
      imageResultRef.current = undefined;
      const abortController = new AbortController();
      abortRef.current = abortController;
      const requestModel = options.modelOverride || selectedModel;
      try {
        const endpoint =
          activeSession.mode === "code"
            ? "/api/chat"
            : activeSession.mode === "media"
              ? "/api/media/chat"
              : activeSession.mode === "image"
                ? "/api/image/chat"
                : "/api/qa";
        let jinaApiKey = "";
        try {
          const credentialStore = await window.electronAPI?.credentials?.read();
          jinaApiKey = credentialStore?.["JINA_API_KEY"]?.trim() ?? "";
        } catch {
          // 读取失败时由服务端回退环境变量 JINA_API_KEY。
        }
        if (!jinaApiKey) {
          // 纯浏览器开发模式没有 Electron 凭证，回退 localStorage。
          jinaApiKey = window.localStorage.getItem("JINA_API_KEY")?.trim() ?? "";
        }
        const response = await apiFetch(endpoint, {
          method: "POST",
          headers: buildLlmRequestHeaders(apiKeys, requestModel, endpointOverrides, jinaApiKey),
          body: JSON.stringify({
            messages: requestMessages.slice(-MAX_CONTEXT_MESSAGES),
            attachments: buildImageAttachmentsPayload(fileOverride),
            sessionId: activeSession.id,
            workingDir: activeProject?.rootPath || "",
            projectId: activeProject?.id || "",
            selectedModel: requestModel,
            agentMode:
              activeSession.mode === "code"
                ? options.codeAgentModeOverride || codeAgentMode
                : undefined,
            checkpointId: options.checkpointId || "",
            resumeCheckpointId: options.resumeCheckpointId || "",
          }),
          signal: abortController.signal,
        });
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
              if (packet.type === "TOOL_STATUS" && typeof streamContent === "string") {
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
                packet.type === "KNOWLEDGE_SOURCES" &&
                packet.payload &&
                "sources" in packet.payload
              ) {
                const payload = packet.payload as KnowledgeSourcesPayload;
                setKnowledgeSources(payload.sources);
                setKnowledgeSearched(payload.searched);
                setKnowledgeMetrics({
                  recallK: payload.recallK,
                  candidateCount: payload.candidateCount,
                  topK: payload.topK,
                  reranked: payload.reranked,
                  avgScore: payload.avgScore,
                  hitRate: payload.hitRate,
                  topScore: payload.topScore,
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
                  agents.activateAgent(inferAgentKind(streamContent), streamContent);
                }
                continue;
              }
              if (packet.type === "WORKLIST_UPDATE" && isWorkListSnapshotPayload(packet.payload)) {
                setWorkListSnapshot(packet.payload);
                setAgentStatus(describeWorkListSnapshot(packet.payload));
                continue;
              }
              if (packet.type === "AGENT_LIFECYCLE" && isAgentLifecyclePayload(packet.payload)) {
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
              if (packet.type === "USAGE" && streamContent && typeof streamContent !== "string") {
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
                applyInteractiveRequestAgents(packet.payload, agents);
              }
              if (
                packet.type === "VISUAL_VERIFY_REQUESTED" &&
                packet.payload &&
                typeof packet.payload === "object" &&
                "frontendChanged" in packet.payload
              ) {
                void runVisualVerification(packet.payload as VisualVerifyPayload);
                continue;
              }
              if (
                packet.type === "IMAGE_RESULT" &&
                packet.payload &&
                typeof packet.payload === "object" &&
                "layers" in packet.payload &&
                "failures" in packet.payload
              ) {
                imageResultRef.current = packet.payload as Message["imageResult"];
                continue;
              }
              if (packet.type === "MEDIA_RESULT" && isMediaResultPayload(packet)) {
                if (packet.content) {
                  finalTextRef.current ||= packet.content;
                }
                mediaAttachmentsRef.current = packet.attachments;
              }
            } catch {
              // 忽略不完整的 SSE 帧，等待下一段数据补齐。
            }
          }
        }
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        checkpointResult = aborted
          ? { status: "interrupted", error: "用户停止或应用中断" }
          : {
              status: "failed",
              error: error instanceof Error ? error.message : "模型请求失败",
            };
        if (!aborted) {
          const message = error instanceof Error ? error.message : "模型请求失败";
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
          (nextInteractiveRequest
            ? interactiveWaitingMessage(nextInteractiveRequest)
            : "已停止生成。");
        const finalHistory: Message[] = [
          ...visibleHistory.slice(0, -1),
          {
            role: "assistant",
            content: answer,
            attachments: mediaAttachmentsRef.current,
            imageResult: imageResultRef.current,
          },
        ];
        const finalSession = {
          ...activeSession,
          title,
          messages: finalHistory,
        };
        setMessages(finalHistory);
        setSessions((current) =>
          current.map((session) => (session.id === activeSession.id ? finalSession : session)),
        );
        void persistSession(activeSession, finalHistory, title).catch((error) => {
          console.warn("[useChatStream] 会话保存失败，重启后消息可能丢失", error);
        });
        abortRef.current = null;
        setIsStreaming(false);
        setAgentStatus("");
        setInteractiveRequest(nextInteractiveRequest);
        await checkpointBinding.finalize(
          options,
          checkpointResult,
          answer,
          Boolean(nextInteractiveRequest),
        );
      }
    },
    [
      activeProject,
      activeSession,
      agents,
      apiKeys,
      attachedFiles,
      checkpointBinding,
      clearAfterSubmit,
      endpointOverrides,
      isParsingFile,
      isStreaming,
      interactiveRequest,
      messages,
      persistSession,
      selectedModel,
      codeAgentMode,
      setMessages,
      setSessions,
    ],
  );
  const handleInteractiveReply = useCallback(
    async (mode: "auto" | "llm" | "user", answer?: string) => {
      if (!interactiveRequest || isStreaming) return;
      const prompt = buildInteractiveReplyPrompt(
        interactiveRequest,
        mode,
        interactiveAnswer,
        answer,
      );
      setInteractiveAnswer("");
      await submitPrompt(prompt, [], checkpointBinding.replyOptions());
    },
    [checkpointBinding, interactiveAnswer, interactiveRequest, isStreaming, submitPrompt],
  );
  return {
    isStreaming,
    toolActivities,
    knowledgeSources,
    knowledgeSearched,
    knowledgeMetrics,
    agentStatus,
    tokenInfo,
    agentLifecycleEvents,
    workListSnapshot,
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
