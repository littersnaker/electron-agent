"use client";
/**
 * 模块职责：聊天输入器组件及附件交互。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { useCallback, useRef } from "react";
import type { ChangeEvent, ClipboardEvent } from "react";
import TextareaAutosize from "react-textarea-autosize";
import {
  collectClipboardAttachments,
  collectDroppedAttachments,
  createFilePickerCandidates,
} from "../../utilities/attachment-input";
import { useComposerDrop } from "../../hooks/use-composer-drop";
import ModelSelector from "../ModelSelector";
import { CommerceControls } from "./commerce-controls";
import { AttachmentList } from "./attachment-list";
import {
  IMAGE_EDIT_FIDELITY_OPTIONS,
  MODE_TABS,
  TYPOGRAPHY_OPTIONS,
  requiresAttachment,
  resolveAccept,
  resolvePlaceholder,
  resolveSubmitLabel,
} from "./chat-composer-config";
import type { ChatComposerProps } from "./chat-composer-config";

export function ChatComposer({
  mode,
  commerceMarketplace = "US",
  commerceWorkflowMode = "research",
  onCommerceWorkflowModeChange,
  onCommerceMarketplaceChange,
  commerceDataSourceState = "none",
  onOpenServiceSettings,
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
  attachedFiles,
  onRemoveFile,
  onAddAttachments,
  attachmentError,
  isParsingFile,
  isStreaming,
  fileInputRef,
  models,
  selectedModel,
  onSelectModel,
  onSubmit,
}: ChatComposerProps) {
  const disabled = isStreaming || isParsingFile;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentsEnabled = mode !== "commerce";
  const isMediaComposer = mode === "qa" && composerMode !== "chat";
  const submitDisabled =
    disabled ||
    (mode === "commerce"
      ? !input.trim()
      : !input.trim() && attachedFiles.length === 0) ||
    (isMediaComposer &&
      requiresAttachment(composerMode) &&
      attachedFiles.length === 0);

  const resolveIngestionOptions = useCallback(
    () => ({
      strategy: isMediaComposer ? ("replace" as const) : ("append" as const),
      maxFiles: isMediaComposer ? 1 : 32,
      maxTotalBytes: isMediaComposer
        ? 512 * 1024 * 1024
        : 64 * 1024 * 1024,
    }),
    [isMediaComposer],
  );

  /** 纯文字媒体模式接收到素材后自动切换到对应编辑/图生模式。 */
  const resolveModeFromFile = useCallback(
    (file: File | undefined) => {
      if (!file || mode !== "qa") return;
      if (composerMode === "text-to-image" && file.type.startsWith("image/")) {
        onComposerModeChange("image-edit");
      } else if (composerMode === "text-to-video") {
        if (file.type.startsWith("image/")) {
          onComposerModeChange("image-to-video");
        } else if (file.type.startsWith("video/")) {
          onComposerModeChange("video-edit");
        }
      }
    },
    [composerMode, mode, onComposerModeChange],
  );

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const candidates = createFilePickerCandidates(event.target.files || []);
    resolveModeFromFile(candidates[0]?.file);
    await onAddAttachments(candidates, resolveIngestionOptions());
    event.target.value = "";
  };

  const handlePaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachmentsEnabled || disabled) return;

    const candidates = collectClipboardAttachments(event.clipboardData);
    if (candidates.length === 0) return;

    event.preventDefault();
    resolveModeFromFile(candidates[0]?.file);
    await onAddAttachments(candidates, resolveIngestionOptions());
  };

  const handleDroppedFiles = useCallback(
    async (dataTransfer: DataTransfer): Promise<void> => {
      const candidates = await collectDroppedAttachments(dataTransfer);
      resolveModeFromFile(candidates[0]?.file);
      await onAddAttachments(candidates, resolveIngestionOptions());
    },
    [onAddAttachments, resolveIngestionOptions, resolveModeFromFile],
  );

  const { activeDropKind, isDragActive, dropHandlers } = useComposerDrop({
    input,
    disabled,
    allowFiles: attachmentsEnabled,
    textareaRef,
    onInputChange,
    onFileDrop: handleDroppedFiles,
  });

  return (
    <>
      {mode === "qa" && (
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
                      ? "var(--selection-bg-strong)"
                      : "transparent",
                    color: active
                      ? "var(--selection-text)"
                      : "var(--text-tertiary)",
                    boxShadow: active ? "var(--selection-shadow)" : "none",
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

      {mode !== "commerce" && (
        <AttachmentList
          attachments={attachedFiles}
          onRemove={onRemoveFile}
          label={composerMode === "chat" ? "附件" : "生成素材"}
        />
      )}

      {mode !== "commerce" && (
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept={resolveAccept(composerMode)}
          multiple={!isMediaComposer}
          onChange={(event) => void handleFileChange(event)}
        />
      )}

      {attachmentError && mode !== "commerce" && (
        <div className="mb-2 rounded-[10px] border border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-[9px] text-amber-300">
          {attachmentError}
        </div>
      )}

      {mode === "qa" &&
        (composerMode === "text-to-image" || composerMode === "image-edit") && (
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

      {mode === "qa" && composerMode === "image-edit" && (
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
                      ? "var(--selection-bg)"
                      : "transparent",
                    borderColor: selected
                      ? "var(--selection-border)"
                      : "var(--border)",
                    color: selected
                      ? "var(--selection-text)"
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
              className="mt-0.5 h-3.5 w-3.5 disabled:opacity-40"
              style={{ accentColor: "var(--accent-blue)" }}
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

      {mode === "commerce" && (
        <CommerceControls
          workflowMode={commerceWorkflowMode}
          onWorkflowModeChange={onCommerceWorkflowModeChange}
          marketplaceCode={commerceMarketplace}
          onMarketplaceChange={onCommerceMarketplaceChange}
          dataSourceState={commerceDataSourceState}
          onOpenServiceSettings={onOpenServiceSettings}
          disabled={disabled}
        />
      )}

      <div
        className="relative rounded-[22px] border p-2.5 transition-all focus-within:border-[var(--accent-blue-border-strong)]"
        style={{
          background: isDragActive
            ? "color-mix(in srgb, var(--composer-bg) 82%, var(--accent-blue) 18%)"
            : "var(--composer-bg)",
          borderColor: isDragActive ? "var(--accent-blue)" : "var(--border)",
          boxShadow:
            "var(--shadow-card), inset 0 1px 0 rgba(255,255,255,0.07)",
          backdropFilter: "blur(30px) saturate(145%)",
          WebkitBackdropFilter: "blur(30px) saturate(145%)",
        }}
        onDragEnter={dropHandlers.onDragEnter}
        onDragOver={dropHandlers.onDragOver}
        onDragLeave={dropHandlers.onDragLeave}
        onDrop={(event) => void dropHandlers.onDrop(event)}
      >
        {isDragActive && (
          <div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-[18px] border border-dashed border-[var(--accent-blue)] bg-[color-mix(in_srgb,var(--composer-bg)_82%,transparent)] text-[11px] font-semibold text-[var(--accent-blue)] backdrop-blur-sm">
            {activeDropKind === "text"
              ? "松开以插入文字"
              : "松开以添加图片、文件或文件夹"}
          </div>
        )}
        <TextareaAutosize
          ref={textareaRef}
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onPaste={(event) => void handlePaste(event)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
          minRows={2}
          maxRows={7}
          disabled={disabled}
          placeholder={resolvePlaceholder(mode, composerMode, commerceWorkflowMode)}
          className="max-h-44 min-w-0 w-full resize-none bg-transparent px-2.5 pb-2 pt-1.5 text-[13px] leading-6 outline-none placeholder:text-[var(--text-quaternary)] disabled:opacity-50"
          style={{ color: "var(--text-primary)" }}
        />

        {mode === "qa" && composerMode !== "chat" && (
          <div
            className="px-2.5 pb-2 text-[10px]"
            style={{ color: "var(--text-tertiary)" }}
          >
            选择模式和模型后直接生成；图片结果会保存到会话并支持下载。
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {mode !== "commerce" && (
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
            )}
            {mode !== "commerce" && (
              <span className="hidden text-[9px] text-[var(--text-quaternary)] sm:inline">
                粘贴图片 / 拖入文件夹 / 选中文字后拖入 · Enter 发送
              </span>
            )}
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
                  mode === "commerce" || composerMode === "chat"
                    ? "linear-gradient(180deg, var(--message-user-start), var(--message-user-end))"
                    : "linear-gradient(180deg, #a86df5, #7d4ce5)",
                boxShadow:
                  mode === "commerce" || composerMode === "chat"
                    ? "var(--primary-button-shadow)"
                    : "0 8px 18px rgba(125,76,229,0.24), inset 0 1px 0 rgba(255,255,255,0.2)",
              }}
              title={resolveSubmitLabel(mode, composerMode, commerceWorkflowMode)}
            >
              {resolveSubmitLabel(mode, composerMode, commerceWorkflowMode)}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
