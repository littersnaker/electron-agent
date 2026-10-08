// 模块说明：负责 useMediaGeneration 状态管理与业务编排。
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  AttachedFile,
  ChatSession,
  ImageEditFidelity,
  MediaMode,
  Message,
  TypographyPolicy,
} from "../constants/page-constants";
import {
  createWorkflow,
  createWorkflowSaver,
  recordWorkflowPacket,
  finishWorkflow,
  updateWorkflowMessage,
} from "../lib/message-workflow";
import { apiFetch } from "../lib/api-client";
import { toMessageAttachment } from "../constants/page-constants";
import { buildLlmRequestHeaders, buildMediaAttachmentPayload } from "../lib/llm/client-request";
import type { LlmCredentials, LlmEndpointOverrides } from "../lib/llm/types";
import type { TokenInfo } from "../types/workspace";
import type { CheckpointFinishResult } from "../types/checkpoints";
import type { AgentCoordinator } from "./useAgentCoordinator";

interface UseMediaGenerationOptions {
  activeSession?: ChatSession;
  messages: Message[];
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setSessions: Dispatch<SetStateAction<ChatSession[]>>;
  persistSession: (session: ChatSession, nextMessages: Message[], title?: string) => Promise<void>;
  apiKeys: LlmCredentials;
  endpointOverrides: LlmEndpointOverrides;
  selectedModel: string;
  attachedFile: AttachedFile | null;
  typographyPolicy: TypographyPolicy;
  imageEditFidelity: ImageEditFidelity;
  enableQualityGuard: boolean;
  isParsingFile: boolean;
  clearAfterSubmit: () => void;
  agents: AgentCoordinator;
}

interface MediaGenerateResponse {
  content?: string;
  attachments?: Message["attachments"];
  usage?: TokenInfo;
  quality?: {
    checked: boolean;
    passed: boolean;
    retried: boolean;
    reason?: string;
  };
  error?: string;
}

export interface MediaRunOptions {
  checkpointId?: string;
  resumeExistingRun?: boolean;
  attachmentOverride?: AttachedFile | null;
  modelOverride?: string;
  typographyPolicyOverride?: TypographyPolicy;
  imageEditFidelityOverride?: ImageEditFidelity;
  enableQualityGuardOverride?: boolean;
  onCheckpointFinish?: (result: CheckpointFinishResult) => void | Promise<void>;
}

function requiresAttachment(mode: MediaMode): boolean {
  return ["image-edit", "image-to-video", "reference-to-video", "video-edit"].includes(mode);
}

function maxAttachmentSizeBytes(mode: MediaMode): number | null {
  switch (mode) {
    case "image-edit":
      return 10 * 1024 * 1024;
    case "image-to-video":
    case "reference-to-video":
      return 20 * 1024 * 1024;
    case "video-edit":
      return 100 * 1024 * 1024;
    default:
      return null;
  }
}

function validateAttachmentForMode(
  mode: MediaMode,
  attachment: AttachedFile | null,
): string | null {
  if (!attachment) {
    return requiresAttachment(mode) ? "当前模式需要先上传素材。" : null;
  }

  if (
    (mode === "image-edit" || mode === "image-to-video" || mode === "reference-to-video") &&
    !attachment.type.startsWith("image/")
  ) {
    return "当前模式需要上传图片素材。";
  }

  if (mode === "video-edit" && !attachment.type.startsWith("video/")) {
    return "视频编辑模式需要上传视频素材。";
  }

  const maxSize = maxAttachmentSizeBytes(mode);
  if (maxSize && attachment.size && attachment.size > maxSize) {
    return `素材文件不能超过 ${Math.round(maxSize / 1024 / 1024)} MB。`;
  }

  return null;
}

function defaultPrompt(mode: MediaMode): string {
  switch (mode) {
    case "image-edit":
      return "请根据上传图片进行编辑";
    case "image-to-video":
      return "请让上传图片自然动起来";
    case "reference-to-video":
      return "请参考上传图片生成视频";
    case "video-edit":
      return "请根据要求编辑上传视频";
    case "text-to-video":
      return "请生成一段高质量视频";
    default:
      return "请生成一张高质量图片";
  }
}

function taskName(mode: MediaMode): string {
  switch (mode) {
    case "image-edit":
      return "图片编辑";
    case "text-to-video":
      return "文生视频";
    case "image-to-video":
      return "图生视频";
    case "reference-to-video":
      return "参考图生视频";
    case "video-edit":
      return "视频编辑";
    default:
      return "图片生成";
  }
}

export function useMediaGeneration({
  activeSession,
  messages,
  setMessages,
  setSessions,
  persistSession,
  apiKeys,
  endpointOverrides,
  selectedModel,
  attachedFile,
  typographyPolicy,
  imageEditFidelity,
  enableQualityGuard,
  isParsingFile,
  clearAfterSubmit,
  agents,
}: UseMediaGenerationOptions) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [status, setStatus] = useState("");
  const [usageInfo, setUsageInfo] = useState<TokenInfo | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  const stop = useCallback(() => abortRef.current?.abort("user"), []);
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsGenerating(false);
    setStatus("");
    setUsageInfo(null);
  }, []);

  const replaceSessionMessages = useCallback(
    async (session: ChatSession, nextMessages: Message[], title: string): Promise<void> => {
      const nextSession = { ...session, title, messages: nextMessages };

      setMessages(nextMessages);
      setSessions((current) =>
        current.map((item) => (item.id === session.id ? nextSession : item)),
      );
      await persistSession(session, nextMessages, title);
    },
    [persistSession, setMessages, setSessions],
  );

  const submit = useCallback(
    async (promptText: string, mode: MediaMode, options: MediaRunOptions = {}) => {
      if (!activeSession || activeSession.mode !== "qa" || isGenerating || isParsingFile) {
        return;
      }

      const prompt = promptText.trim();
      const effectiveAttachment =
        options.attachmentOverride === undefined ? attachedFile : options.attachmentOverride;
      if (!prompt && !effectiveAttachment) return;

      const attachmentError = validateAttachmentForMode(mode, effectiveAttachment);
      if (attachmentError) {
        const errorHistory: Message[] = [
          ...messages,
          { role: "user", content: prompt || defaultPrompt(mode) },
          { role: "assistant", content: `⚠️ ${attachmentError}` },
        ];
        const title =
          activeSession.title === "新对话"
            ? prompt.slice(0, 18) || "媒体生成"
            : activeSession.title;
        await replaceSessionMessages(activeSession, errorHistory, title);
        await options.onCheckpointFinish?.({
          status: "failed",
          error: attachmentError,
        });
        return;
      }

      const visiblePrompt = prompt || defaultPrompt(mode);
      const userMessage: Message = {
        role: "user",
        content: visiblePrompt,
        attachments: toMessageAttachment(effectiveAttachment),
      };
      const resumeExistingRun = options.resumeExistingRun === true;
      const lastMessage = messages[messages.length - 1];
      const baseMessages =
        resumeExistingRun && lastMessage?.role === "assistant" ? messages.slice(0, -1) : messages;
      let workflow = createWorkflow("media", resumeExistingRun ? lastMessage?.workflow : undefined);
      workflow = recordWorkflowPacket(workflow, {
        type: "TOOL_STATUS",
        content: `${taskName(mode)} · 等待模型返回结果`,
      });
      const optimisticHistory: Message[] = [
        ...baseMessages,
        ...(resumeExistingRun ? [] : [userMessage]),
        { role: "assistant", content: "", workflow, createdAt: new Date().toISOString() },
      ];
      const title =
        activeSession.title === "新对话"
          ? visiblePrompt.slice(0, 18) || "媒体生成"
          : activeSession.title;
      const optimisticSession = {
        ...activeSession,
        title,
        messages: optimisticHistory,
      };

      setMessages(optimisticHistory);
      setSessions((current) =>
        current.map((session) => (session.id === activeSession.id ? optimisticSession : session)),
      );
      clearAfterSubmit();

      setIsGenerating(true);
      setUsageInfo(null);
      setStatus(
        mode.includes("video")
          ? "Media Agent 正在提交视频任务并等待结果…"
          : "Media Agent 正在调用百炼图片模型…",
      );
      agents.beginMediaRun(taskName(mode));
      const saver = createWorkflowSaver((next) => persistSession(activeSession, next, title));
      void saver.flush(optimisticHistory).catch((error) => {
        console.warn("[useMediaGeneration] 会话保存失败", error);
      });

      const controller = new AbortController();
      abortRef.current = controller;
      let checkpointResult: CheckpointFinishResult = { status: "completed" };
      const requestModel = options.modelOverride || selectedModel;
      const requestTypographyPolicy = options.typographyPolicyOverride || typographyPolicy;
      const requestImageEditFidelity = options.imageEditFidelityOverride || imageEditFidelity;
      const requestQualityGuard = options.enableQualityGuardOverride ?? enableQualityGuard;

      try {
        const response = await apiFetch("/api/media/generate", {
          method: "POST",
          headers: buildLlmRequestHeaders(apiKeys, requestModel, endpointOverrides),
          body: JSON.stringify({
            prompt: visiblePrompt,
            mode,
            modelId: requestModel,
            typographyPolicy: requestTypographyPolicy,
            imageEditFidelity: requestImageEditFidelity,
            enableQualityGuard: requestQualityGuard,
            attachment: buildMediaAttachmentPayload(effectiveAttachment)?.[0],
            sessionId: activeSession.id,
            checkpointId: options.checkpointId || "",
          }),
          signal: controller.signal,
        });

        const payload = (await response.json()) as MediaGenerateResponse;
        if (!response.ok) {
          throw new Error(payload.error || "媒体生成失败");
        }

        setUsageInfo(
          payload.usage || {
            prompt: 0,
            completion: 0,
            total: payload.attachments?.length || 1,
            unit: mode.includes("video") ? "videos" : "images",
            label: mode.includes("video") ? "视频额度" : "图片额度",
          },
        );
        const reviewTask = payload.quality?.checked
          ? payload.quality.passed
            ? payload.quality.retried
              ? "首版未通过检查，自动重试后已通过重影检查"
              : "已通过重影、重复元素与无关改动检查"
            : `质量检查仍有风险：${payload.quality.reason || "请人工确认"}`
          : "模型已返回生成结果";
        agents.completeMediaRun(reviewTask);

        const finalHistory = updateWorkflowMessage(
          optimisticHistory,
          finishWorkflow(workflow, "completed", reviewTask),
          {
            content: payload.content || "生成完成。",
            attachments: payload.attachments,
          },
        );
        await saver
          .flush(finalHistory)
          .catch((error) => console.warn("[useMediaGeneration] 会话保存失败", error));
        setMessages(finalHistory);
        setSessions((current) =>
          current.map((session) =>
            session.id === activeSession.id
              ? { ...session, title, messages: finalHistory }
              : session,
          ),
        );
      } catch (error) {
        const aborted =
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError");
        checkpointResult = aborted
          ? { status: "interrupted", error: "用户停止或应用中断" }
          : {
              status: "failed",
              error: error instanceof Error ? error.message : "媒体生成失败",
            };
        const message = aborted
          ? "已停止生成。"
          : `⚠️ ${error instanceof Error ? error.message : "媒体生成失败"}`;
        agents.failMediaRun(message);

        const finalHistory = updateWorkflowMessage(
          optimisticHistory,
          finishWorkflow(
            workflow,
            aborted ? (controller.signal.reason === "user" ? "stopped" : "interrupted") : "failed",
            message,
          ),
          { content: message },
        );
        await saver
          .flush(finalHistory)
          .catch((error) => console.warn("[useMediaGeneration] 会话保存失败", error));
        setMessages(finalHistory);
        setSessions((current) =>
          current.map((session) =>
            session.id === activeSession.id
              ? { ...session, title, messages: finalHistory }
              : session,
          ),
        );
      } finally {
        abortRef.current = null;
        setIsGenerating(false);
        setStatus("");
        if (options.onCheckpointFinish) {
          await options.onCheckpointFinish(checkpointResult);
        }
      }
    },
    [
      activeSession,
      agents,
      apiKeys,
      attachedFile,
      clearAfterSubmit,
      enableQualityGuard,
      endpointOverrides,
      imageEditFidelity,
      isGenerating,
      isParsingFile,
      messages,
      replaceSessionMessages,
      persistSession,
      selectedModel,
      setMessages,
      setSessions,
      typographyPolicy,
    ],
  );

  return {
    isGenerating,
    status,
    usageInfo,
    submit,
    stop,
    reset,
  };
}

export type MediaGenerationController = ReturnType<typeof useMediaGeneration>;
