/**
 * 模块职责：异步视频任务轮询与统一媒体生成入口。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { getMediaModelDefinition } from "../catalog";
import type { MediaGenerateRequest, MediaGenerateResult } from "../types";
import { AsyncTaskPayload, buildVideoInput } from "./dashscope-upload";
import { VIDEO_ENDPOINT_PATH, generateQwenImage, getApiBase, getQwenApiKey, readJsonResponse } from "./dashscope-image";
export function extractVideoUrl(payload: AsyncTaskPayload): string | undefined {
  return (
    payload.output?.video_url ||
    payload.output?.results?.find((item) => item.video_url || item.url)
      ?.video_url ||
    payload.output?.results?.find((item) => item.video_url || item.url)?.url
  );
}

export function createAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    // eslint-disable-next-line prefer-const
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handleAbort = () => {
      if (timer) clearTimeout(timer);
      reject(createAbortError());
    };

    timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

/**
 * 不同视频模型接受的 parameters 并不完全相同。
 * 按模型族输出最小兼容参数，避免把 Wan 专属字段传给 HappyHorse 编辑模型。
 */
export function buildVideoParameters(
  request: MediaGenerateRequest,
): Record<string, unknown> {
  if (request.mode === "video-edit") {
    return {
      resolution: "720P",
      watermark: false,
      audio_setting: "auto",
    };
  }

  const base = {
    resolution: "720P",
    ratio: "16:9",
    duration: 5,
    watermark: false,
  };

  return request.modelId.includes("happyhorse")
    ? base
    : { ...base, prompt_extend: true };
}

export async function waitForVideoTask(
  apiKey: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + 6 * 60 * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw createAbortError();

    const response = await fetch(`${getApiBase()}/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal,
    });
    const payload = await readJsonResponse<AsyncTaskPayload>(response);
    const status = payload.output?.task_status?.toUpperCase();

    if (status === "SUCCEEDED") {
      const videoUrl = extractVideoUrl(payload);
      if (!videoUrl) throw new Error("视频任务成功，但没有返回 video_url。");
      return videoUrl;
    }

    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      throw new Error(payload.message || `视频任务结束，状态：${status}`);
    }

    await delay(5000, signal);
  }

  throw new Error("等待视频生成超时。任务可能仍在百炼后台运行，请稍后重试。");
}

/**
 * 调用百炼异步视频接口并轮询结果。
 * 视频文件较大，不写入 SQLite；UI 下载时通过同源下载代理转发。
 */
export async function generateDashScopeVideo(
  request: MediaGenerateRequest,
): Promise<MediaGenerateResult> {
  const model = getMediaModelDefinition(request.modelId);
  if (!model) throw new Error(`未注册的媒体模型：${request.modelId}`);
  const apiKey = getQwenApiKey(request);
  const input = await buildVideoInput(request, model.model, apiKey);

  const response = await fetch(`${getApiBase()}${VIDEO_ENDPOINT_PATH}`, {
    method: "POST",
    signal: request.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
      // 使用临时 oss:// URL 时必须启用资源解析；其他模式携带该头也无副作用。
      "X-DashScope-OssResourceResolve": "enable",
    },
    body: JSON.stringify({
      model: model.model,
      input,
      parameters: buildVideoParameters(request),
    }),
  });

  const submitted = await readJsonResponse<AsyncTaskPayload>(response);
  const taskId = submitted.output?.task_id;
  if (!taskId) throw new Error("百炼视频任务提交成功，但没有返回 task_id。");

  const videoUrl = await waitForVideoTask(apiKey, taskId, request.signal);
  const fileName = `dashscope-video-${Date.now()}.mp4`;

  return {
    content: `已使用 ${model.name} 完成视频生成。视频临时地址通常只保留 24 小时，请及时下载。`,
    attachments: [
      {
        name: fileName,
        downloadName: fileName,
        type: "video/mp4",
        assetKind: "video",
        url: videoUrl,
      },
    ],
    usage: {
      prompt: 0,
      completion: 0,
      total: 1,
      unit: "videos",
      label: "视频额度",
    },
  };
}

export async function generateMedia(
  request: MediaGenerateRequest,
): Promise<MediaGenerateResult> {
  const model = getMediaModelDefinition(request.modelId);
  if (!model) throw new Error(`未注册的媒体模型：${request.modelId}`);
  if (!model.modes.includes(request.mode)) {
    throw new Error(`${model.name} 不支持 ${request.mode} 模式。`);
  }

  return model.protocol === "qwen-image-sync"
    ? generateQwenImage(request)
    : generateDashScopeVideo(request);
}
