// 模块说明：视觉 Review 编排——启动预览 → 自动滚动截图 → 降采样 → 视觉模型审查 → 卡片回调。
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api-client";
import { buildLlmRequestHeaders } from "../../lib/llm/client-request";
import { AUTO_MODEL_ID } from "../../lib/llm/registry/models";
import type { LlmCredentials, LlmEndpointOverrides } from "../../lib/llm/types";
import type { VisualAuditCardData, VisualReviewCardData } from "../../constants/page-constants";

/** 单次 Review 最多截取的帧数，与后端 MAX_REVIEW_FRAMES 一致。 */
const MAX_FRAMES = 6;
/** 全站巡检默认覆盖的页面数上限（每页独立一次视觉模型调用）。 */
const MAX_AUDIT_PAGES = 6;
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

/** 全站巡检中单页的实时结果（面板逐页刷新）。 */
export interface VisualAuditPageResult {
  /** 页面完整 URL（localhost dev server）。 */
  url: string;
  /** 展示用的路径（pathname + hash 路由）。 */
  path: string;
  /** 截图成功且已拿到结论。 */
  content: string;
  frameCount: number;
  /** 页面加载/截图失败原因；正常页为空。 */
  captureError: string;
  /** 视觉模型调用失败原因；正常页为空。 */
  reviewError: string;
  status: "captured" | "reviewed" | "captureFailed" | "reviewFailed";
}

export interface VisualAuditStartOptions {
  rootPath: string;
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
  /** 允许视觉 Review（截图发送给云端视觉模型）；设置弹窗可关。 */
  settingsEnabled: boolean;
  /** Code Agent 完成后自动触发视觉 Review；仅总开关开启时生效。 */
  autoEnabled: boolean;
  /** 设置加载完成后为 true，避免初始默认值造成开关闪动。 */
  settingsLoaded: boolean;
  /** 设置弹窗直接写穿的开关更新；同时持久化到 Electron 偏好/localStorage。 */
  updateSettings: (patch: { settingsEnabled?: boolean; autoEnabled?: boolean }) => void;
  startReview: (options: VisualReviewStartOptions) => Promise<void>;
  /** 全站巡检：BFS 发现同源页面，逐页截图并逐页调用视觉模型。 */
  auditSite: (options: VisualAuditStartOptions) => Promise<void>;
  /** 巡检结果（面板逐页刷新）与进度；auditRunning 表示巡检进行中。 */
  auditResults: VisualAuditPageResult[];
  auditProgress: { current: number; total: number } | null;
  auditRunning: boolean;
  stopPreview: () => Promise<void>;
  reset: () => void;
}

interface UseVisualReviewOptions {
  apiKeys: LlmCredentials;
  endpointOverrides: LlmEndpointOverrides;
  /** Review 完成后由调用方（useChatStream）决定如何把卡片写进消息流。 */
  onReviewComplete?: (card: VisualReviewCardData) => void;
  /** 巡检完成后由调用方决定如何把巡检卡片写进消息流。 */
  onAuditComplete?: (card: VisualAuditCardData) => void;
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

/** 视觉 Review 设置的 localStorage 兜底键（纯浏览器开发模式无 Electron 偏好）。 */
const SETTINGS_STORAGE_KEY = "VISUAL_REVIEW_SETTINGS";

interface VisualReviewSettings {
  settingsEnabled: boolean;
  autoEnabled: boolean;
}

const DEFAULT_SETTINGS: VisualReviewSettings = { settingsEnabled: true, autoEnabled: true };

/** 从 Electron 偏好读取设置；浏览器模式回退 localStorage，异常时用默认值。 */
async function loadSettings(): Promise<VisualReviewSettings> {
  let fallbackRaw: string | null = null;
  try {
    fallbackRaw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
  } catch {
    // localStorage 不可用时直接用默认值。
  }
  const preferences = await window.electronAPI?.preferences?.read().catch(() => undefined);
  const enabled =
    preferences?.visualReviewEnabled ?? parseStoredFlag(fallbackRaw, "settingsEnabled");
  const auto = preferences?.visualReviewAutoEnabled ?? parseStoredFlag(fallbackRaw, "autoEnabled");
  return {
    settingsEnabled: enabled ?? DEFAULT_SETTINGS.settingsEnabled,
    autoEnabled: auto ?? DEFAULT_SETTINGS.autoEnabled,
  };
}

/** 从 localStorage JSON 里读单个布尔字段。 */
function parseStoredFlag(
  raw: string | null,
  field: "settingsEnabled" | "autoEnabled",
): boolean | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed[field] === "boolean" ? (parsed[field] as boolean) : undefined;
  } catch {
    return undefined;
  }
}

/** 视觉 Review 全流程编排；由 useChatStream 组合并对外透出。 */
export function useVisualReview({
  apiKeys,
  endpointOverrides,
  onReviewComplete,
  onAuditComplete,
}: UseVisualReviewOptions): VisualReviewController {
  const [previewUrl, setPreviewUrl] = useState("");
  const [frames, setFrames] = useState<VisualReviewFrame[]>([]);
  const [reviewText, setReviewText] = useState("");
  const [reviewModel, setReviewModel] = useState("");
  const [status, setStatus] = useState<VisualReviewStatus>("idle");
  const [error, setError] = useState("");
  const [settings, setSettings] = useState<VisualReviewSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [auditResults, setAuditResults] = useState<VisualAuditPageResult[]>([]);
  const [auditProgress, setAuditProgress] = useState<{ current: number; total: number } | null>(
    null,
  );
  const [auditRunning, setAuditRunning] = useState(false);
  // 串行保护：上一轮 Review 未结束时忽略新的触发，避免 dev server 与截图互相踩踏。
  const runningRef = useRef(false);
  // startReview 闭包内读最新开关，避免设置刚改完仍走旧值。
  const settingsRef = useRef(settings);
  useEffect(() => {
    // 在 effect 中同步 ref，避免 render 期写 ref（react-hooks purity）。
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((loaded) => {
      if (cancelled) return;
      setSettings(loaded);
      setSettingsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateSettings = useCallback((patch: Partial<VisualReviewSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      // 写穿：Electron 偏好为主（字段名与偏好文件对齐），localStorage 兜底。
      void window.electronAPI?.preferences
        ?.write({
          visualReviewEnabled: next.settingsEnabled,
          visualReviewAutoEnabled: next.autoEnabled,
        })
        .catch(() => undefined);
      try {
        window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // 忽略持久化失败。
      }
      return next;
    });
  }, []);

  const startReview = useCallback(
    async ({ rootPath, taskSummary = "", modelId = "" }: VisualReviewStartOptions) => {
      if (runningRef.current) return;
      if (!settingsRef.current.settingsEnabled) {
        setStatus("error");
        setError("视觉 Review 已在设置中关闭");
        return;
      }
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

  /** 单页视觉 Review 调用；返回结论文本与模型，失败抛错由调用方按页兜底。 */
  const reviewOnePage = useCallback(
    async (
      framesForReview: Array<{ base64: string }>,
      taskSummary: string,
      modelId: string,
    ): Promise<{ content: string; model: string }> => {
      const reviewResponse = await apiFetch("/api/visual/review", {
        method: "POST",
        headers: buildLlmRequestHeaders(apiKeys, modelId || AUTO_MODEL_ID, endpointOverrides),
        body: JSON.stringify({
          frames: framesForReview.map((frame) => ({
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
      if (!result.ok) throw new Error(result.error || "视觉 Review 失败");
      return { content: result.content || "", model: result.model || "" };
    },
    [apiKeys, endpointOverrides],
  );

  /** 全站巡检：BFS 发现同源页面 → 逐页滚动截图 → 逐页视觉 Review → 聚合卡片。 */
  const auditSite = useCallback(
    async ({ rootPath, modelId = "" }: VisualAuditStartOptions) => {
      if (runningRef.current) return;
      if (!settingsRef.current.settingsEnabled) {
        setStatus("error");
        setError("视觉 Review 已在设置中关闭");
        return;
      }
      if (!rootPath) {
        setStatus("error");
        setError("没有打开的项目，无法启动预览");
        return;
      }
      if (!window.electronAPI?.auditSite) {
        setStatus("error");
        setError("当前环境不支持巡检（需要桌面应用）");
        return;
      }
      runningRef.current = true;
      setAuditRunning(true);
      setError("");
      setAuditResults([]);
      setAuditProgress(null);
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
        const audit = await window.electronAPI.auditSite(url, MAX_AUDIT_PAGES, MAX_FRAMES);
        const results: VisualAuditPageResult[] = audit.pages.map((page) => {
          const parsed = new URL(page.url);
          return {
            url: page.url,
            path: `${parsed.pathname}${parsed.hash}${parsed.search}`,
            content: "",
            frameCount: page.frames.length,
            captureError: page.error,
            reviewError: "",
            status: page.error ? "captureFailed" : "captured",
          };
        });
        setAuditResults([...results]);
        setAuditProgress({ current: 0, total: results.length });

        let lastModel = "";
        for (let index = 0; index < results.length; index += 1) {
          const page = audit.pages[index];
          setAuditProgress({ current: index + 1, total: results.length });
          if (page.error || !page.frames.length) continue;
          setStatus("reviewing");
          try {
            const framesForReview = await Promise.all(
              page.frames.map((frame) => downscaleBase64(frame.base64, REVIEW_FRAME_WIDTH, 0.8)),
            );
            const review = await reviewOnePage(
              framesForReview.map((base64) => ({ base64 })),
              `全站巡检 · 页面 ${results[index].path}`,
              modelId,
            );
            lastModel = review.model || lastModel;
            results[index] = {
              ...results[index],
              content: review.content,
              status: "reviewed",
            };
          } catch (caught) {
            results[index] = {
              ...results[index],
              status: "reviewFailed",
              reviewError: caught instanceof Error ? caught.message : "视觉 Review 失败",
            };
          }
          setAuditResults([...results]);
        }
        setStatus("done");
        setAuditProgress(null);
        onAuditComplete?.({
          url,
          model: lastModel,
          createdAt: new Date().toISOString(),
          pages: await Promise.all(
            results.map(async (result, pageIndex) => ({
              path: result.path,
              frameCount: result.frameCount,
              status: result.status,
              content: result.content,
              captureError: result.captureError,
              reviewError: result.reviewError,
              thumbnails: await Promise.all(
                (audit.pages[pageIndex]?.frames ?? []).map((frame) =>
                  downscaleBase64(frame.base64, THUMBNAIL_WIDTH, 0.7),
                ),
              ),
            })),
          ),
        });
      } catch (caught) {
        setStatus("error");
        setError(caught instanceof Error ? caught.message : "全站巡检失败");
        setAuditProgress(null);
      } finally {
        setAuditRunning(false);
        runningRef.current = false;
      }
    },
    [apiKeys, endpointOverrides, onAuditComplete, reviewOnePage],
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
    setAuditResults([]);
    setAuditProgress(null);
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
    settingsEnabled: settings.settingsEnabled,
    autoEnabled: settings.autoEnabled,
    settingsLoaded,
    updateSettings,
    startReview,
    auditSite,
    auditResults,
    auditProgress,
    auditRunning,
    stopPreview,
    reset,
  };
}
