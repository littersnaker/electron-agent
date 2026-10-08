"use client";
/**
 * 模块职责：聊天流式请求、SSE 消费和会话状态协调。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toMessageAttachments } from "../../constants/page-constants";
import type {
  AttachedFile,
  Message,
  VisualAuditCardData,
  VisualReviewCardData,
} from "../../constants/page-constants";
import { useVisualReview } from "./use-visual-review";
import { buildRetrievedAttachment } from "../../lib/rag/attachment-rag";
import { buildImageAttachmentsPayload, buildLlmRequestHeaders } from "../../lib/llm/client-request";
import {
  createWorkflow,
  createWorkflowSaver,
  recordWorkflowPacket,
  finishWorkflow,
  updateWorkflowMessage,
  type MessageWorkflow,
} from "../../lib/message-workflow";
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
  mediaImageModelId,
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
  const workflowRef = useRef<MessageWorkflow | null>(null);
  const runMessagesRef = useRef<Message[]>([]);
  const saverRef = useRef<ReturnType<typeof createWorkflowSaver> | null>(null);
  // 文本与事件每帧合并提交，避免逐分包重解析整段 Markdown。
  const streamFrameRef = useRef<number | null>(null);
  const finalResponseMarkedRef = useRef(false);
  const scheduleStreamFlush = useCallback(() => {
    if (streamFrameRef.current !== null) return;
    streamFrameRef.current = window.requestAnimationFrame(() => {
      streamFrameRef.current = null;
      const workflow = workflowRef.current;
      if (!workflow) return;
      runMessagesRef.current = updateWorkflowMessage(runMessagesRef.current, workflow, {
        content: finalTextRef.current,
      });
      saverRef.current?.schedule(runMessagesRef.current);
      setMessages((current) =>
        updateWorkflowMessage(current, workflow, { content: finalTextRef.current }),
      );
    });
  }, [setMessages]);
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (streamFrameRef.current !== null) {
        window.cancelAnimationFrame(streamFrameRef.current);
        streamFrameRef.current = null;
      }
    };
  }, []);
  const checkpointBinding = useChatCheckpointBinding();
  const stop = useCallback(() => abortRef.current?.abort("user"), []);

  /**
   * 视觉 Review 留档：完成后把缩略图 + 结论组装成卡片消息写进会话流。
   * 截图与模型调用在 useVisualReview 内完成，这里只负责持久化表现层。
   */
  const appendVisualReviewCard = useCallback(
    (card: VisualReviewCardData) => {
      const cardMessage: Message = {
        role: "assistant",
        content: `🖼️ 视觉 Review（${card.frameCount} 帧，${card.model || "自动路由"}）：`,
        createdAt: card.createdAt,
        visualReview: card,
      };
      runMessagesRef.current = [...runMessagesRef.current, cardMessage];
      setMessages((current) => [...current, cardMessage]);
      setSessions((current) =>
        current.map((session) =>
          session.id === activeSession?.id
            ? { ...session, messages: [...session.messages, cardMessage] }
            : session,
        ),
      );
    },
    [activeSession?.id, setMessages, setSessions],
  );
  /**
   * 全站巡检留档：多页面逐页结论组装成巡检卡片消息写进会话流。
   */
  const appendVisualAuditCard = useCallback(
    (card: VisualAuditCardData) => {
      const reviewed = card.pages.filter((page) => page.status === "reviewed").length;
      const cardMessage: Message = {
        role: "assistant",
        content: `🔍 全站巡检（${card.pages.length} 页，${reviewed} 页完成 Review，${
          card.model || "自动路由"
        }）：`,
        createdAt: card.createdAt,
        visualAudit: card,
      };
      runMessagesRef.current = [...runMessagesRef.current, cardMessage];
      setMessages((current) => [...current, cardMessage]);
      setSessions((current) =>
        current.map((session) =>
          session.id === activeSession?.id
            ? { ...session, messages: [...session.messages, cardMessage] }
            : session,
        ),
      );
    },
    [activeSession?.id, setMessages, setSessions],
  );
  const visualReview = useVisualReview({
    apiKeys,
    endpointOverrides,
    onReviewComplete: appendVisualReviewCard,
    onAuditComplete: appendVisualAuditCard,
  });
  /**
   * Code Agent review 阶段请求视觉验证：前端有改动即自动跑全站巡检。
   * 设置里关闭「自动视觉验证」时跳过；总开关关闭时 startReview 内部也会拦截。
   */
  const runVisualVerification = useCallback(
    async (payload: VisualVerifyPayload) => {
      const rootPath = activeProject?.rootPath;
      if (!rootPath || !activeSession) return;
      if (!visualReview.settingsLoaded || !visualReview.autoEnabled) {
        console.info("[useChatStream] 自动视觉验证已在设置中关闭，跳过");
        return;
      }
      setAgentStatus("正在自动全站巡检：发现页面 → 逐页截图 → 视觉 Review…");
      try {
        // 前端文件有改动即触发全站巡检：改动可能影响任意路由，不只首页。
        await visualReview.auditSite({
          rootPath,
          taskSummary: payload.taskSummary || "",
        });
      } finally {
        setAgentStatus("");
      }
    },
    [activeProject?.rootPath, activeSession, setAgentStatus, visualReview],
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
                createdAt: new Date().toISOString(),
              },
            ];
        const errorHistory: Message[] = [
          ...visibleBaseMessages,
          ...visibleErrorUserMessage,
          {
            role: "assistant",
            content: `⚠️ ${workspaceError}`,
            createdAt: new Date().toISOString(),
          },
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
                createdAt: new Date().toISOString(),
              },
            ];
      const workflow = createWorkflow(
        activeSession.mode,
        resumeExistingRun || (suppressVisibleUserMessage && interactiveRequest)
          ? lastMessage?.workflow
          : undefined,
      );
      workflowRef.current = workflow;
      const visibleHistory: Message[] = [
        ...visibleBaseMessages,
        ...visibleUserMessages,
        { role: "assistant", content: "", createdAt: new Date().toISOString(), workflow },
      ];
      runMessagesRef.current = visibleHistory;
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
      saverRef.current = createWorkflowSaver((next) => persistSession(activeSession, next, title));
      const optimisticSession = {
        ...activeSession,
        title,
        messages: visibleHistory,
      };
      setSessions((current) =>
        current.map((session) => (session.id === activeSession.id ? optimisticSession : session)),
      );
      setMessages(visibleHistory);
      void saverRef.current.flush(visibleHistory).catch((error) => {
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
      finalResponseMarkedRef.current = false;
      if (streamFrameRef.current !== null) {
        // 上一轮流里可能还挂着未触发的帧，开新流前作废。
        window.cancelAnimationFrame(streamFrameRef.current);
        streamFrameRef.current = null;
      }
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
            mediaImageModelId: mediaImageModelId || undefined,
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
              const streamContent =
                packet.content ??
                (packet.payload && "content" in packet.payload
                  ? packet.payload.content
                  : packet.type === "STATUS" && packet.payload && "detail" in packet.payload
                    ? packet.payload.detail
                    : undefined);
              if (workflowRef.current) {
                const next = recordWorkflowPacket(workflowRef.current, packet);
                if (next !== workflowRef.current) {
                  workflowRef.current = next;
                  setToolActivities(next.toolActivities);
                  scheduleStreamFlush();
                }
              }
              if (packet.type === "TEXT" && typeof streamContent === "string") {
                finalTextRef.current += streamContent;
                setAgentStatus("");
                if (!finalResponseMarkedRef.current) {
                  // 编排器“最终回复中”状态标记一次即可，无需每个分包都刷。
                  finalResponseMarkedRef.current = true;
                  agents.markFinalResponse();
                }
                scheduleStreamFlush();
                continue;
              }
              if (packet.type === "TOOL_STATUS" && typeof streamContent === "string") {
                const label = streamContent.trim();
                if (!hasLifecycleRef.current) {
                  agents.activateAgent(inferAgentKind(label), label);
                }
                setAgentStatus("Agent 正在执行工具调用…");
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
                  return next;
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
        const aborted =
          abortController.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError");
        checkpointResult = aborted
          ? {
              status: "interrupted",
              error: abortController.signal.reason === "user" ? "用户已停止当前任务" : "应用中断",
            }
          : {
              status: "failed",
              error: error instanceof Error ? error.message : "模型请求失败",
            };
        if (!aborted) {
          const message = error instanceof Error ? error.message : "模型请求失败";
          finalTextRef.current ||= `⚠️ ${message}`;
          agents.failRunningAgents();
        }
      } finally {
        // 取消尾帧，保留最终消息元数据。
        if (streamFrameRef.current !== null) {
          window.cancelAnimationFrame(streamFrameRef.current);
          streamFrameRef.current = null;
        }
        agents.finalizeAgents(nextInteractiveRequest);
        const answer =
          finalTextRef.current ||
          (nextInteractiveRequest
            ? interactiveWaitingMessage(nextInteractiveRequest)
            : "已停止生成。");
        const finished = finishWorkflow(
          workflowRef.current ?? workflow,
          abortController.signal.aborted
            ? abortController.signal.reason === "user"
              ? "stopped"
              : "interrupted"
            : checkpointResult.status === "failed" || answer.startsWith("⚠️")
              ? "failed"
              : nextInteractiveRequest
                ? "waiting"
                : "completed",
          nextInteractiveRequest
            ? interactiveWaitingMessage(nextInteractiveRequest)
            : checkpointResult.error || "",
        );
        workflowRef.current = finished;
        setToolActivities(finished.toolActivities);
        const finalHistory = updateWorkflowMessage(runMessagesRef.current, finished, {
          content: answer,
          attachments: mediaAttachmentsRef.current,
          imageResult: imageResultRef.current,
        });
        runMessagesRef.current = finalHistory;
        const finalSession = {
          ...activeSession,
          title,
          messages: finalHistory,
        };
        setMessages(finalHistory);
        setSessions((current) =>
          current.map((session) => (session.id === activeSession.id ? finalSession : session)),
        );
        await saverRef.current?.flush(finalHistory).catch((error) => {
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
      runVisualVerification,
      scheduleStreamFlush,
      selectedModel,
      codeAgentMode,
      mediaImageModelId,
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
    visualReview,
  };
}
export type ChatStreamController = ReturnType<typeof useChatStream>;
