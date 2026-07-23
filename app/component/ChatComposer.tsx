/* eslint-disable @next/next/no-img-element */
"use client";

import type { ChangeEvent, RefObject } from "react";
import TextareaAutosize from "react-textarea-autosize";
import {
  isImageAttachment,
  isVideoAttachment,
  resolveAttachmentDataUrl,
} from "../const/pageConst";
import type {
  AttachedFile,
  ComposerMode,
  ImageEditFidelity,
  MediaMode,
  TypographyPolicy,
} from "../const/pageConst";
import type { ModelOption } from "../const/modelList";
import ModelSelector from "./ModelSelector";

interface ChatComposerProps {
  mode?: "qa" | "code";
  composerMode: ComposerMode;
  onComposerModeChange: (mode: ComposerMode) => void;
  typographyPolicy: TypographyPolicy;
  onTypographyPolicyChange: (policy: TypographyPolicy) => void;
  imageEditFidelity: ImageEditFidelity;
  onImageEditFidelityChange: (fidelity: ImageEditFidelity) => void;
  enableQualityGuard: boolean;
  onEnableQualityGuardChange: (enabled: boolean) => void;
  input: string;
  onInputChange: (value: string) => void;
  attachedFile: AttachedFile | null;
  onRemoveFile: () => void;
  isParsingFile: boolean;
  isStreaming: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileSelect: (event: ChangeEvent<HTMLInputElement>) => void;
  models: readonly ModelOption[];
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  onSubmit: () => void;
}

const TYPOGRAPHY_OPTIONS: ReadonlyArray<{
  value: TypographyPolicy;
  label: string;
  description: string;
}> = [
  {
    value: "avoid-generated-text",
    label: "无字底图（推荐）",
    description: "禁止模型生成文字，预留后期排版区域。",
  },
  {
    value: "strict-short-text",
    label: "严格短文案",
    description: "只允许模型绘制明确提供的短文字。",
  },
  {
    value: "model-default",
    label: "模型默认",
    description: "不附加文字限制，可能出现歪字或乱码。",
  },
];


const IMAGE_EDIT_FIDELITY_OPTIONS: ReadonlyArray<{
  value: ImageEditFidelity;
  label: string;
  description: string;
}> = [
  {
    value: "precise",
    label: "精准修改（推荐）",
    description: "关闭提示词扩写，只改目标区域，适合 UI、商品图和文字替换。",
  },
  {
    value: "balanced",
    label: "平衡编辑",
    description: "保留主体与布局，允许目标附近做必要的局部重绘。",
  },
  {
    value: "creative",
    label: "创意重构",
    description: "允许明显重绘，适合风格迁移和重新设计。",
  },
];

const MODE_TABS: ReadonlyArray<{
  value: ComposerMode;
  label: string;
  description: string;
}> = [
  { value: "chat", label: "问答", description: "文字问答与图片理解" },
  { value: "text-to-image", label: "生图", description: "文字生成图片" },
  { value: "image-edit", label: "改图", description: "上传图片后按指令编辑" },
  { value: "text-to-video", label: "文生视频", description: "文字生成视频" },
  { value: "image-to-video", label: "图生视频", description: "首帧图片生成视频" },
  {
    value: "reference-to-video",
    label: "参考生视频",
    description: "参考主体图片生成视频",
  },
  { value: "video-edit", label: "视频编辑", description: "上传视频后进行编辑" },
];

function requiresAttachment(mode: MediaMode): boolean {
  return [
    "image-edit",
    "image-to-video",
    "reference-to-video",
    "video-edit",
  ].includes(mode);
}

function resolveAccept(composerMode: ComposerMode): string {
  switch (composerMode) {
    case "image-edit":
    case "image-to-video":
    case "reference-to-video":
      return "image/*";
    case "video-edit":
      return "video/*";
    case "text-to-image":
      return "image/*";
    case "text-to-video":
      return "image/*,video/*";
    default:
      return "image/*,application/pdf,text/*";
  }
}

function resolvePlaceholder(
  sessionMode: "qa" | "code" | undefined,
  composerMode: ComposerMode,
): string {
  if (sessionMode === "code") {
    return "描述要分析、创建或修改的项目任务…";
  }

  switch (composerMode) {
    case "text-to-image":
      return "描述要生成的图片，例如：极简电商主图，浅灰背景，产品居中，柔和科技感打光…";
    case "image-edit":
      return "上传图片并描述修改要求，例如：保留产品不变，把背景改为浅灰摄影棚并增强金属质感…";
    case "text-to-video":
      return "描述要生成的视频镜头、动作和风格…";
    case "image-to-video":
      return "上传一张首帧图片，再描述镜头运动和主体动作…";
    case "reference-to-video":
      return "上传参考图片，再描述主体在视频中的场景和动作…";
    case "video-edit":
      return "上传视频并描述风格转换、元素替换或局部编辑要求…";
    default:
      return "输入你的问题…";
  }
}

function resolveSubmitLabel(composerMode: ComposerMode): string {
  return composerMode === "chat" ? "发送" : "开始生成";
}

export default function ChatComposer({
  mode,
  composerMode,
  onComposerModeChange,
  typographyPolicy,
  onTypographyPolicyChange,
  imageEditFidelity,
  onImageEditFidelityChange,
  enableQualityGuard,
  onEnableQualityGuardChange,
  input,
  onInputChange,
  attachedFile,
  onRemoveFile,
  isParsingFile,
  isStreaming,
  fileInputRef,
  onFileSelect,
  models,
  selectedModel,
  onSelectModel,
  onSubmit,
}: ChatComposerProps) {
  const disabled = isStreaming || isParsingFile;
  const imagePreview = isImageAttachment(attachedFile);
  const videoPreview = isVideoAttachment(attachedFile);
  const previewUrl =
    attachedFile && (imagePreview || videoPreview)
      ? resolveAttachmentDataUrl(attachedFile)
      : "";
  const submitDisabled =
    disabled ||
    (!input.trim() && !attachedFile) ||
    (composerMode !== "chat" &&
      requiresAttachment(composerMode) &&
      !attachedFile);

  /**
   * 在纯文字生成模式上传素材时，自动切换到对应的图生/编辑模式。
   * 这样用户不会误以为上传的素材参与了生成，交互也更接近 Codex 绘图。
   */
  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (file && mode !== "code") {
      if (composerMode === "text-to-image" && file.type.startsWith("image/")) {
        onComposerModeChange("image-edit");
      } else if (composerMode === "text-to-video") {
        if (file.type.startsWith("image/")) {
          onComposerModeChange("image-to-video");
        } else if (file.type.startsWith("video/")) {
          onComposerModeChange("video-edit");
        }
      }
    }

    onFileSelect(event);
  };

  return (
    <>
      {mode !== "code" && (
        <div
          className="mb-3 overflow-x-auto rounded-[16px] border p-1.5"
          style={{
            background: "var(--glass-soft)",
            borderColor: "var(--border)",
          }}
        >
          <div className="flex min-w-max gap-1">
            {MODE_TABS.map((tab) => {
              const active = composerMode === tab.value;
              return (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => onComposerModeChange(tab.value)}
                  className="rounded-[11px] px-3 py-2 text-left transition-all"
                  style={{
                    background: active
                      ? "var(--glass-hover)"
                      : "transparent",
                    color: active
                      ? "var(--text-primary)"
                      : "var(--text-tertiary)",
                    boxShadow: active
                      ? "inset 0 1px 0 rgba(255,255,255,0.06)"
                      : "none",
                  }}
                  title={tab.description}
                >
                  <div className="text-[11px] font-semibold">{tab.label}</div>
                  <div className="mt-0.5 text-[9px] opacity-70">
                    {tab.description}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {attachedFile && (
        <div
          className="mb-2 flex items-start gap-3 rounded-[16px] border p-2.5"
          style={{
            background: "var(--glass)",
            borderColor: "var(--border)",
            color: "var(--text-secondary)",
          }}
        >
          <div
            className="relative h-24 w-24 shrink-0 overflow-hidden rounded-[12px] border"
            style={{
              background: "var(--glass-black)",
              borderColor: "var(--border)",
            }}
          >
            {imagePreview ? (
              <img
                src={previewUrl}
                alt={attachedFile.name}
                className="h-full w-full object-cover"
              />
            ) : videoPreview ? (
              <video
                src={previewUrl}
                className="h-full w-full object-cover"
                muted
              />
            ) : (
              <div className="flex h-full items-center justify-center text-[11px] text-[var(--text-tertiary)]">
                文件
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-1 items-start justify-between gap-2 pt-1">
            <div className="min-w-0">
              <div
                className="text-[10px] font-medium uppercase tracking-[0.08em]"
                style={{ color: "var(--text-tertiary)" }}
              >
                {composerMode === "chat" ? "附件" : "生成素材"}
              </div>
              <div
                className="mt-1 truncate text-[12px] font-medium"
                style={{ color: "var(--text-primary)" }}
                title={attachedFile.name}
              >
                {attachedFile.name}
              </div>
              <div
                className="mt-1 text-[10px]"
                style={{ color: "var(--text-tertiary)" }}
              >
                {attachedFile.type || "application/octet-stream"}
              </div>
            </div>

            <button
              type="button"
              onClick={onRemoveFile}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[15px] transition-colors hover:bg-[var(--glass-hover)] hover:text-[var(--text-primary)]"
              style={{ color: "var(--text-tertiary)" }}
              aria-label="移除附件"
              title="移除附件"
            >
              ×
            </button>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept={resolveAccept(composerMode)}
        onChange={handleFileChange}
      />

      {(composerMode === "text-to-image" || composerMode === "image-edit") && (
        <div
          className="mb-2 flex flex-wrap items-center gap-2 rounded-[14px] border px-3 py-2"
          style={{
            background: "var(--glass-soft)",
            borderColor: "var(--border)",
          }}
        >
          <span className="text-[10px] font-medium text-[var(--text-tertiary)]">
            图片文字策略
          </span>
          {TYPOGRAPHY_OPTIONS.map((option) => {
            const selected = typographyPolicy === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onTypographyPolicyChange(option.value)}
                className="rounded-full border px-2.5 py-1 text-[10px] transition-colors"
                style={{
                  background: selected ? "rgba(191,90,242,0.14)" : "transparent",
                  borderColor: selected ? "rgba(191,90,242,0.35)" : "var(--border)",
                  color: selected ? "var(--text-primary)" : "var(--text-tertiary)",
                }}
                title={option.description}
              >
                {option.label}
              </button>
            );
          })}
          <span className="w-full text-[9px] leading-4 text-[var(--text-quaternary)]">
            AI 生成图中的文字已经是像素，CSS 无法修正歪字。商业图建议先生成无字底图，再使用真实字体叠加。
          </span>
        </div>
      )}

      {composerMode === "image-edit" && (
        <div
          className="mb-2 rounded-[14px] border px-3 py-2.5"
          style={{
            background: "var(--glass-soft)",
            borderColor: "var(--border)",
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-medium text-[var(--text-tertiary)]">
              编辑保真
            </span>
            {IMAGE_EDIT_FIDELITY_OPTIONS.map((option) => {
              const selected = imageEditFidelity === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onImageEditFidelityChange(option.value)}
                  className="rounded-full border px-2.5 py-1 text-[10px] transition-colors"
                  style={{
                    background: selected
                      ? "rgba(10,132,255,0.13)"
                      : "transparent",
                    borderColor: selected
                      ? "rgba(10,132,255,0.32)"
                      : "var(--border)",
                    color: selected
                      ? "var(--text-primary)"
                      : "var(--text-tertiary)",
                  }}
                  title={option.description}
                >
                  {option.label}
                </button>
              );
            })}
          </div>

          <label className="mt-2 flex cursor-pointer items-start gap-2 text-[10px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={enableQualityGuard && imageEditFidelity !== "creative"}
              onChange={(event) =>
                onEnableQualityGuardChange(event.target.checked)
              }
              disabled={imageEditFidelity === "creative"}
              className="mt-0.5 h-3.5 w-3.5 accent-[#0a84ff] disabled:opacity-40"
            />
            <span>
              生成后检查重影、重复元素和无关改动；发现明显问题时自动重试一次。
              <span className="ml-1 text-[var(--text-quaternary)]">
                自动重试会额外消耗 1 次图片额度，视觉检查会消耗少量 Token。
              </span>
            </span>
          </label>

          <div className="mt-1.5 text-[9px] leading-4 text-[var(--text-quaternary)]">
            UI 截图、商品图、按钮/标题文字替换请使用“精准修改”。模型仍属于生成式编辑，无法保证像素级完全不变。
          </div>
        </div>
      )}

      <div
        className="rounded-[22px] border p-2.5 transition-all focus-within:border-[rgba(10,132,255,0.36)]"
        style={{
          background: "var(--composer-bg)",
          borderColor: "var(--border)",
          boxShadow:
            "var(--shadow-card), inset 0 1px 0 rgba(255,255,255,0.07)",
          backdropFilter: "blur(30px) saturate(145%)",
          WebkitBackdropFilter: "blur(30px) saturate(145%)",
        }}
      >
        <TextareaAutosize
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
          minRows={2}
          maxRows={7}
          disabled={disabled}
          placeholder={resolvePlaceholder(mode, composerMode)}
          className="max-h-44 min-w-0 w-full resize-none bg-transparent px-2.5 pb-2 pt-1.5 text-[13px] leading-6 outline-none placeholder:text-[var(--text-quaternary)] disabled:opacity-50"
          style={{ color: "var(--text-primary)" }}
        />

        {composerMode !== "chat" && (
          <div
            className="px-2.5 pb-2 text-[10px]"
            style={{ color: "var(--text-tertiary)" }}
          >
            选择模式和模型后直接生成；图片结果会保存到会话并支持下载。
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="flex h-9 w-9 items-center justify-center rounded-[11px] border transition-colors hover:bg-[var(--glass-hover)] disabled:opacity-40"
              style={{
                background: "var(--glass)",
                borderColor: "var(--border)",
                color: "var(--text-secondary)",
              }}
              title={composerMode === "chat" ? "添加文件" : "上传生成素材"}
            >
              {isParsingFile ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/15 border-t-current/60" />
              ) : (
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
                  <path
                    d="m7 10.5 4.7-4.7a2.2 2.2 0 0 1 3.1 3.1L9 14.7a3.2 3.2 0 0 1-4.5-4.5l5.1-5.1"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            </button>
            <span className="hidden text-[9px] text-[var(--text-quaternary)] sm:inline">
              Enter 发送 · Shift+Enter 换行
            </span>
          </div>

          <div className="flex items-center gap-2">
            <ModelSelector
              models={models}
              selectedModel={selectedModel}
              onSelect={onSelectModel}
            />
            <button
              type="button"
              onClick={onSubmit}
              disabled={submitDisabled}
              className="flex h-9 min-w-9 items-center justify-center rounded-[11px] px-3 text-[11px] font-semibold text-white transition-all active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-30"
              style={{
                background:
                  composerMode === "chat"
                    ? "linear-gradient(180deg, var(--message-user-start), var(--message-user-end))"
                    : "linear-gradient(180deg, #a86df5, #7d4ce5)",
                boxShadow:
                  composerMode === "chat"
                    ? "0 8px 18px rgba(10,132,255,0.22), inset 0 1px 0 rgba(255,255,255,0.2)"
                    : "0 8px 18px rgba(125,76,229,0.24), inset 0 1px 0 rgba(255,255,255,0.2)",
              }}
              title={resolveSubmitLabel(composerMode)}
            >
              {resolveSubmitLabel(composerMode)}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
