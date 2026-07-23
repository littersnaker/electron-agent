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
} from "../const/pageConst";
import { toMessageAttachment } from "../const/pageConst";
import {
  buildLlmRequestHeaders,
  buildMediaAttachmentPayload,
} from "../lib/llm/client-request";
import type { LlmCredentials } from "../lib/llm/types";
import type { TokenInfo } from "../types/workspace";
import type { AgentCoordinator } from "./useAgentCoordinator";

interface UseMediaGenerationOptions {
  activeSession?: ChatSession;
  messages: Message[];
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setSessions: Dispatch<SetStateAction<ChatSession[]>>;
  persistSession: (
    session: ChatSession,
    nextMessages: Message[],
    title?: string,
  ) => Promise<void>;
  apiKeys: LlmCredentials;
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

function requiresAttachment(mode: MediaMode): boolean {
  return [
    "image-edit",
    "image-to-video",
    "reference-to-video",
    "video-edit",
  ].includes(mode);
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
    (mode === "image-edit" ||
      mode === "image-to-video" ||
      mode === "reference-to-video") &&
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
  const progressTimerRef = useRef<number | null>(null);
  const progressRef = useRef(18);

  const stopProgressTimer = useCallback(() => {
    if (progressTimerRef.current) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      stopProgressTimer();
    },
    [stopProgressTimer],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    stopProgressTimer();
  }, [stopProgressTimer]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    stopProgressTimer();
    setIsGenerating(false);
    setStatus("");
    setUsageInfo(null);
  }, [stopProgressTimer]);

  const replaceSessionMessages = useCallback(
    async (
      session: ChatSession,
      nextMessages: Message[],
      title: string,
    ): Promise<void> => {
      const nextSession = { ...session, title, messages: nextMessages };

      setMessages(nextMessages);
      setSessions((current) =>
        current.map((item) =>
          item.id === session.id ? nextSession : item,
        ),
      );
      await persistSession(session, nextMessages, title);
    },
    [persistSession, setMessages, setSessions],
  );

  /**
   * 服务端媒体接口不是 SSE，因此前端用“阶段进度”平滑推进到 88%。
   * 真正拿到文件后再一次性设为 100%，避免图片已出来但右侧仍显示 0%。
   */
  const startProgressTimer = useCallback(
    (mode: MediaMode) => {
      stopProgressTimer();
      progressRef.current = 18;
      progressTimerRef.current = window.setInterval(() => {
        const increment = mode.includes("video") ? 3 : 6;
        progressRef.current = Math.min(88, progressRef.current + increment);
        const currentProgress = progressRef.current;
        agents.updateMediaProgress(
          currentProgress,
          currentProgress < 40
            ? "正在提交百炼媒体任务"
            : currentProgress < 72
              ? "模型正在生成内容"
              : mode === "image-edit" && enableQualityGuard
                ? "正在检查重影、重复元素和无关改动"
                : "正在下载并整理生成结果",
        );
      }, mode.includes("video") ? 2500 : 1200);
    },
    [agents, enableQualityGuard, stopProgressTimer],
  );

  const submit = useCallback(
    async (promptText: string, mode: MediaMode) => {
      if (
        !activeSession ||
        activeSession.mode === "code" ||
        isGenerating ||
        isParsingFile
      ) {
        return;
      }

      const prompt = promptText.trim();
      if (!prompt && !attachedFile) return;

      const attachmentError = validateAttachmentForMode(mode, attachedFile);
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
        return;
      }

      const visiblePrompt = prompt || defaultPrompt(mode);
      const userMessage: Message = {
        role: "user",
        content: visiblePrompt,
        attachments: toMessageAttachment(attachedFile),
      };
      const optimisticHistory: Message[] = [
        ...messages,
        userMessage,
        { role: "assistant", content: "" },
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
        current.map((session) =>
          session.id === activeSession.id ? optimisticSession : session,
        ),
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
      startProgressTimer(mode);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch("/api/media/generate", {
          method: "POST",
          headers: buildLlmRequestHeaders(apiKeys, selectedModel),
          body: JSON.stringify({
            prompt: visiblePrompt,
            mode,
            modelId: selectedModel,
            typographyPolicy,
            imageEditFidelity,
            enableQualityGuard,
            attachment: buildMediaAttachmentPayload(attachedFile)?.[0],
          }),
          signal: controller.signal,
        });

        const payload = (await response.json()) as MediaGenerateResponse;
        if (!response.ok) {
          throw new Error(payload.error || "媒体生成失败");
        }

        stopProgressTimer();
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
          : "已检查结果文件并确认可以预览/下载";
        agents.completeMediaRun(reviewTask);

        const finalHistory: Message[] = [
          ...optimisticHistory.slice(0, -1),
          {
            role: "assistant",
            content: payload.content || "生成完成。",
            attachments: payload.attachments,
          },
        ];
        await replaceSessionMessages(activeSession, finalHistory, title);
      } catch (error) {
        stopProgressTimer();
        const aborted = error instanceof DOMException && error.name === "AbortError";
        const message = aborted
          ? "已停止生成。"
          : `⚠️ ${error instanceof Error ? error.message : "媒体生成失败"}`;
        agents.failMediaRun(message);

        const finalHistory: Message[] = [
          ...optimisticHistory.slice(0, -1),
          { role: "assistant", content: message },
        ];
        await replaceSessionMessages(activeSession, finalHistory, title);
      } finally {
        abortRef.current = null;
        setIsGenerating(false);
        setStatus("");
      }
    },
    [
      activeSession,
      agents,
      apiKeys,
      attachedFile,
      clearAfterSubmit,
      enableQualityGuard,
      imageEditFidelity,
      isGenerating,
      isParsingFile,
      messages,
      replaceSessionMessages,
      selectedModel,
      setMessages,
      setSessions,
      startProgressTimer,
      stopProgressTimer,
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
