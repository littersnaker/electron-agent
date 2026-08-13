// 模块说明：用户新增或修改自定义聊天模型的弹窗。
"use client";

import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import type {
  CustomModelInput,
  CustomModelRecord,
  MediaMode,
  MediaOutputKind,
  MediaProtocol,
} from "../lib/llm/custom-models";
import type { LlmProviderId } from "../lib/llm/types";

interface Props {
  initial?: CustomModelRecord;
  onClose: () => void;
  onSave: (input: CustomModelInput) => Promise<void>;
}

const PROVIDERS: ReadonlyArray<{ id: LlmProviderId; label: string }> = [
  { id: "qwen", label: "百炼 / DashScope" },
  { id: "openai", label: "OpenAI" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "glm", label: "智谱 GLM" },
  { id: "kimi", label: "Kimi / Moonshot" },
  { id: "doubao", label: "火山引擎 / 豆包" },
  { id: "gemini", label: "Google Gemini" },
];

const MEDIA_MODE_OPTIONS: ReadonlyArray<{
  id: MediaMode;
  label: string;
}> = [
  { id: "text-to-image", label: "文生图" },
  { id: "text-to-video", label: "文生视频" },
  { id: "image-edit", label: "图片编辑" },
];

const MEDIA_PROTOCOL_OPTIONS: ReadonlyArray<{
  id: MediaProtocol;
  label: string;
}> = [
  { id: "qwen-image-sync", label: "百炼图像/视频（DashScope）" },
  { id: "volcengine-image", label: "火山引擎图像（Volcengine）" },
  { id: "volcengine-video-async", label: "火山引擎视频异步（Volcengine）" },
];

/** 根据用户输入显示最终请求地址，避免把 Base URL 与完整接口混淆。 */
function endpointPreview(provider: LlmProviderId, baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/u, "");
  if (!base) return "留空时使用设置页或后端环境变量中的 Base URL";
  if (provider === "gemini") {
    return base.endsWith(":streamGenerateContent")
      ? base
      : `${base}/models/{model}:streamGenerateContent`;
  }
  return base.endsWith("/chat/completions")
    ? base
    : `${base}/chat/completions`;
}

/** 协议决定输出类型，避免用户分别选择产生冲突。 */
function protocolOutputKind(protocol: MediaProtocol): MediaOutputKind {
  if (protocol === "volcengine-video-async") return "video";
  if (protocol === "qwen-image-sync" || protocol === "volcengine-image") {
    return "image";
  }
  return "";
}

export default function CustomModelModal({ initial, onClose, onSave }: Props) {
  const [name, setName] = useState(initial?.name || "");
  const [provider, setProvider] = useState<LlmProviderId>(
    initial?.provider || "qwen",
  );
  const [model, setModel] = useState(initial?.model || "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || "");
  const [includeInAuto, setIncludeInAuto] = useState(
    initial?.includeInAuto ?? true,
  );
  const [autoPriority, setAutoPriority] = useState(
    initial?.autoPriority ?? 10,
  );
  const [supportsVision, setSupportsVision] = useState(
    initial?.supportsVision ?? false,
  );
  const [mediaModes, setMediaModes] = useState<MediaMode[]>(
    initial?.mediaModes || [],
  );
  const [mediaProtocol, setMediaProtocol] = useState<MediaProtocol>(
    initial?.mediaProtocol || "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const preview = useMemo(
    () => endpointPreview(provider, baseUrl),
    [baseUrl, provider],
  );

  const toggleMediaMode = (mode: MediaMode) => {
    setMediaModes((current) =>
      current.includes(mode)
        ? current.filter((item) => item !== mode)
        : [...current, mode],
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        provider,
        model: model.trim(),
        baseUrl: baseUrl.trim() || undefined,
        includeInAuto,
        autoPriority,
        supportsVision,
        mediaModes,
        mediaProtocol,
        mediaOutputKind: protocolOutputKind(mediaProtocol),
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存模型失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] -top-1/2 -translate-y-full flex items-center justify-center  p-4">
      <form
        onSubmit={(event) => void submit(event)}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-140 flex-col overflow-hidden rounded-[20px] border shadow-2xl"
        style={{
          background: "var(--glass-solid)",
          borderColor: "var(--border)",
          color: "var(--text-primary)",
        }}
      >
        {/* 标题区固定在弹窗顶部，表单滚动时仍可随时关闭。 */}
        <div className="flex shrink-0 items-start justify-between gap-4 px-5 pb-4 pt-5">
          <div>
            <h2 className="text-[16px] font-semibold">
              {initial ? "修改模型" : "添加模型"}
            </h2>
            <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
              model 值会原样保存到 SQLite，并原样发送给供应商，不会被程序改名。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-lg"
            aria-label="关闭添加模型弹窗"
          >
            ×
          </button>
        </div>

        {/*
          仅让表单内容区滚动，避免小窗口或系统缩放较大时，
          底部“取消/保存模型”按钮被裁切到 Electron 窗口之外。
        */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-[11px]">
            <span className="mb-1.5 block text-[var(--text-secondary)]">
              显示名称
            </span>
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-10 w-full rounded-xl border bg-transparent px-3 outline-none"
              style={{ borderColor: "var(--border)" }}
              placeholder="例如：我的百炼 Plus"
            />
          </label>
          <label className="text-[11px]">
            <span className="mb-1.5 block text-[var(--text-secondary)]">
              供应商 / Key 来源
            </span>
            <select
              value={provider}
              onChange={(event) =>
                setProvider(event.target.value as LlmProviderId)
              }
              className="h-10 w-full rounded-xl border bg-[var(--glass-solid)] px-3 outline-none"
              style={{ borderColor: "var(--border)" }}
            >
              {PROVIDERS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="mt-4 block text-[11px]">
          <span className="mb-1.5 block text-[var(--text-secondary)]">
            模型 model 值
          </span>
          <input
            required
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className="h-10 w-full rounded-xl border bg-transparent px-3 font-mono outline-none"
            style={{ borderColor: "var(--border)" }}
            placeholder="例如：qwen3.7-plus"
          />
        </label>

        <label className="mt-4 block text-[11px]">
          <span className="mb-1.5 block text-[var(--text-secondary)]">
            Base URL（可选）
          </span>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="h-10 w-full rounded-xl border bg-transparent px-3 font-mono outline-none"
            style={{ borderColor: "var(--border)" }}
            placeholder="https://.../compatible-mode/v1"
          />
          <span className="mt-1.5 block break-all text-[10px] text-[var(--text-tertiary)]">
            实际请求：{preview}
          </span>
          <span className="mt-1 block text-[10px] leading-4 text-[var(--text-tertiary)]">
            此处只覆盖当前自定义模型，优先级高于设置页和 .env.local；
            声明了媒体模式的模型会出现在媒体选择器中。
          </span>
        </label>

        <div
          className="mt-4 grid gap-3 rounded-xl border p-3"
          style={{ borderColor: "var(--border)" }}
        >
          <span className="text-[11px] text-[var(--text-secondary)]">
            媒体能力（勾选后可作为生图/生视频模型选择）
          </span>
          <div className="flex flex-wrap gap-3">
            {MEDIA_MODE_OPTIONS.map((option) => {
              const checked = mediaModes.includes(option.id);
              return (
                <label
                  key={option.id}
                  className="flex items-center gap-1.5 text-[11px]"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleMediaMode(option.id)}
                  />
                  {option.label}
                </label>
              );
            })}
          </div>
          {mediaModes.length > 0 && (
            <label className="block text-[11px]">
              <span className="mb-1.5 block text-[var(--text-secondary)]">
                媒体协议（决定走百炼还是火山引擎）
              </span>
              <select
                value={mediaProtocol}
                onChange={(event) =>
                  setMediaProtocol(event.target.value as MediaProtocol)
                }
                className="h-10 w-full rounded-xl border bg-[var(--glass-solid)] px-3 outline-none"
                style={{ borderColor: "var(--border)" }}
              >
                <option value="">请选择协议</option>
                {MEDIA_PROTOCOL_OPTIONS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div
          className="mt-4 grid gap-3 rounded-xl border p-3 sm:grid-cols-2"
          style={{ borderColor: "var(--border)" }}
        >
          <label className="flex items-center gap-2 text-[11px]">
            <input
              type="checkbox"
              checked={includeInAuto}
              onChange={(event) => setIncludeInAuto(event.target.checked)}
            />
            允许 Auto 自动尝试
          </label>
          <label className="flex items-center gap-2 text-[11px]">
            <input
              type="checkbox"
              checked={supportsVision}
              onChange={(event) => setSupportsVision(event.target.checked)}
            />
            支持图片理解 Vision
          </label>
          <label className="flex items-center gap-2 text-[11px] sm:col-span-2">
            Auto 优先级
            <input
              type="number"
              min={1}
              max={9999}
              value={autoPriority}
              onChange={(event) =>
                setAutoPriority(Number(event.target.value) || 10)
              }
              className="h-8 w-24 rounded-lg border bg-transparent px-2 outline-none"
              style={{ borderColor: "var(--border)" }}
            />
            <span className="text-[var(--text-tertiary)]">
              数字越小越先尝试
            </span>
          </label>
        </div>

          {error ? (
            <p className="mt-3 text-[11px] text-red-400">{error}</p>
          ) : null}
        </div>

        {/* 操作区始终固定在底部，不参与表单内容滚动。 */}
        <div
          className="flex shrink-0 justify-end gap-2 border-t px-5 py-4"
          style={{
            background: "var(--glass-solid)",
            borderColor: "var(--border)",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-xl border px-4 text-[11px]"
            style={{ borderColor: "var(--border)" }}
          >
            取消
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-9 rounded-xl bg-[var(--accent-blue)] px-4 text-[11px] font-semibold text-white disabled:opacity-50"
          >
            {saving ? "保存中…" : "保存模型"}
          </button>
        </div>
      </form>
    </div>
  );
}
