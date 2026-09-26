// 模块说明：视觉 Review 编排——启动预览 → 自动滚动截图 → 降采样 → 视觉模型审查 → 卡片回调。
"use client";

import { useCallback, useRef, useState } from "react";
import { apiFetch } from "../../lib/api-client";
import { buildLlmRequestHeaders } from "../../lib/llm/client-request";
import { AUTO_MODEL_ID } from "../../lib/llm/registry/models";
import type { LlmCredentials, LlmEndpointOverrides } from "../../lib/llm/types";
import type { VisualReviewCardData } from "../../constants/page-constants";

/** 单次 Review 最多截取的帧数，与后端 MAX_REVIEW_FRAMES 一致。 */
const MAX_FRAMES = 6;
/** 发给视觉模型的降采样宽度：文本可读，六帧总体积约 1MB。 */
const REVIEW_FRAME_WIDTH = 1152;
/** 聊天卡片缩略图宽度：只做留档展示。 */
const THUMBNAIL_WIDTH = 480;

export type VisualReviewStatus =
  "idle" | "previewStarting" | "capturing" | "reviewing" | "done" | "error";

/** 面板展示用的一帧：review 用降采样图，放大查看用原帧。 */
export interface VisualReviewFrame {
  /** 降采样后的 JPEG Base64（无 data: 前缀），发给后端。 */
  base64: string;
  /** 原始 PNG Base64，仅供面板放大预览，不进消息。 */
  fullBase64: string;
  offsetTop: number;
}

export interface VisualReviewStartOptions {
  /** 项目根目录；缺省时无法启动预览。 */
  rootPath: string;
  /** 任务摘要（自动触发时来自 Code Agent review 事件）。 */
  taskSummary?: string;
  /** 显式指定视觉模型；缺省走网关按能力自动路由。 */
  modelId?: string;
}

export interface VisualReviewController {
  previewUrl: string;
  frames: VisualReviewFrame[];
  reviewText: string;
  reviewModel: string;
  status: VisualReviewStatus;
  error: string;
  /** Electron 环境才具备截图能力；纯浏览器模式只能看 iframe 预览。 */
  canCapture: boolean;
  isBusy: boolean;
  startReview: (options: VisualReviewStartOptions) => Promise<void>;
  stopPreview: () => Promise<void>;
  reset: () => void;
}

interface UseVisualReviewOptions {
  apiKeys: LlmCredentials;
  endpointOverrides: LlmEndpointOverrides;
  /** Review 完成后由调用方（useChatStream）决定如何把卡片写进消息流。 */
  onReviewComplete?: (card: VisualReviewCardData) => void;
}

/** 把 PNG Base64 用 canvas 降采样成 JPEG Base64；失败时原样返回。 */
function downscaleBase64(base64: string, targetWidth: number, quality: number): Promise<string> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const scale = Math.min(1, targetWidth / Math.max(1, image.width));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) {
          resolve(base64);
          return;
        }
        context.drawImage(image, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
      } catch {
        resolve(base64);
      }
    };
    image.onerror = () => resolve(base64);
    image.src = `data:image/png;base64,${base64}`;
  });
}

/** 视觉 Review 全流程编排；由 useChatStream 组合并对外透出。 */
export function useVisualReview({
  apiKeys,
  endpointOverrides,
  onReviewComplete,
}: UseVisualReviewOptions): VisualReviewController {
  const [previewUrl, setPreviewUrl] = useState("");
  const [frames, setFrames] = useState<VisualReviewFrame[]>([]);
  const [reviewText, setReviewText] = useState("");
  const [reviewModel, setReviewModel] = useState("");
  const [status, setStatus] = useState<VisualReviewStatus>("idle");
  const [error, setError] = useState("");
  // 串行保护：上一轮 Review 未结束时忽略新的触发，避免 dev server 与截图互相踩踏。
  const runningRef = useRef(false);

  const startReview = useCallback(
    async ({ rootPath, taskSummary = "", modelId = "" }: VisualReviewStartOptions) => {
      if (runningRef.current) return;
      if (!rootPath) {
        setStatus("error");
        setError("没有打开的项目，无法启动预览");
        return;
      }
      if (!window.electronAPI?.capturePageScroll) {
        setStatus("error");
        setError("当前环境不支持截图（需要桌面应用）");
        return;
      }
      runningRef.current = true;
      setError("");
      try {
        setStatus("previewStarting");
        const previewResponse = await apiFetch("/api/visual/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rootPath }),
        });
        if (!previewResponse.ok) {
          throw new Error((await previewResponse.json().catch(() => ({}))).error || "预览启动失败");
        }
        const { url } = (await previewResponse.json()) as { url?: string };
        if (!url) throw new Error("预览地址为空");
        setPreviewUrl(url);

        setStatus("capturing");
        const capture = await window.electronAPI.capturePageScroll(url, MAX_FRAMES);
        const captured: VisualReviewFrame[] = [];
        for (const frame of capture.frames) {
          captured.push({
            fullBase64: frame.base64,
            base64: await downscaleBase64(frame.base64, REVIEW_FRAME_WIDTH, 0.8),
            offsetTop: frame.offsetTop,
          });
        }
        setFrames(captured);

        setStatus("reviewing");
        const reviewResponse = await apiFetch("/api/visual/review", {
          method: "POST",
          // 与聊天请求同源的凭证头，自定义模型供应商 Key 从这里到达网关。
          headers: buildLlmRequestHeaders(apiKeys, modelId || AUTO_MODEL_ID, endpointOverrides),
          body: JSON.stringify({
            frames: captured.map((frame) => ({
              imageBase64: frame.base64,
              mimeType: "image/jpeg",
            })),
            taskSummary,
            modelId,
          }),
        });
        const result = (await reviewResponse.json()) as {
          ok?: boolean;
          content?: string;
          model?: string;
          error?: string;
        };
        if (!result.ok) {
          throw new Error(result.error || "视觉 Review 失败");
        }
        setReviewText(result.content || "");
        setReviewModel(result.model || "");
        setStatus("done");
        onReviewComplete?.({
          url,
          frameCount: captured.length,
          // 卡片只存缩略图，控制会话持久化体积。
          thumbnails: await Promise.all(
            captured.map((frame) => downscaleBase64(frame.fullBase64, THUMBNAIL_WIDTH, 0.7)),
          ),
          content: result.content || "",
          model: result.model || "",
          createdAt: new Date().toISOString(),
        });
      } catch (caught) {
        setStatus("error");
        setError(caught instanceof Error ? caught.message : "视觉 Review 失败");
      } finally {
        runningRef.current = false;
      }
    },
    [apiKeys, endpointOverrides, onReviewComplete],
  );

  const stopPreview = useCallback(async () => {
    try {
      await apiFetch("/api/visual/preview/stop", { method: "POST" });
    } catch {
      // dev server 回收失败不阻塞界面，进程会随应用退出被系统回收。
    }
  }, []);

  const reset = useCallback(() => {
    setFrames([]);
    setReviewText("");
    setReviewModel("");
    setStatus("idle");
    setError("");
  }, []);

  return {
    previewUrl,
    frames,
    reviewText,
    reviewModel,
    status,
    error,
    canCapture: Boolean(window.electronAPI?.capturePageScroll),
    isBusy: status === "previewStarting" || status === "capturing" || status === "reviewing",
    startReview,
    stopPreview,
    reset,
  };
}
