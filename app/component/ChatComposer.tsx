/* eslint-disable @next/next/no-img-element */
"use client";

import type { ChangeEvent, RefObject } from "react";
import TextareaAutosize from "react-textarea-autosize";
import {
  isImageAttachment,
  resolveAttachmentDataUrl,
} from "../const/pageConst";
import type { AttachedFile } from "../const/pageConst";
import type { ModelOption } from "../const/modelList";
import ModelSelector from "./ModelSelector";

interface ChatComposerProps {
  mode?: "qa" | "code";
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

export default function ChatComposer({
  mode,
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
  const showImagePreview = isImageAttachment(attachedFile);
  const imagePreviewUrl =
    attachedFile && showImagePreview
      ? resolveAttachmentDataUrl(attachedFile)
      : "";

  return (
    <>
      {attachedFile && (
        showImagePreview ? (
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
              <img
                src={imagePreviewUrl}
                alt={attachedFile.name}
                className="h-full w-full object-cover"
              />
            </div>

            <div className="flex min-w-0 flex-1 items-start justify-between gap-2 pt-1">
              <div className="min-w-0">
                <div
                  className="text-[10px] font-medium uppercase tracking-[0.08em]"
                  style={{ color: "var(--text-tertiary)" }}
                >
                  图片附件
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
                  {attachedFile.type || "image/*"}
                </div>
              </div>

              <button
                type="button"
                onClick={onRemoveFile}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[15px] transition-colors hover:bg-[var(--glass-hover)] hover:text-[var(--text-primary)]"
                style={{ color: "var(--text-tertiary)" }}
                aria-label="移除图片附件"
                title="移除图片"
              >
                ×
              </button>
            </div>
          </div>
        ) : (
          <div
            className="mb-2 flex items-center gap-2 rounded-[12px] border px-3 py-2 text-[11px]"
            style={{
              background: "var(--glass)",
              borderColor: "var(--border)",
              color: "var(--text-secondary)",
            }}
          >
            <span
              className="flex h-6 w-6 items-center justify-center rounded-lg"
              style={{
                background: "rgba(10,132,255,0.12)",
                color: "#64b5ff",
              }}
            >
              <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
                <path
                  d="m7 10.5 4.7-4.7a2.2 2.2 0 0 1 3.1 3.1L9 14.7a3.2 3.2 0 0 1-4.5-4.5l5.1-5.1"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span className="min-w-0 flex-1 truncate">
              {attachedFile.name}
            </span>
            <button
              type="button"
              onClick={onRemoveFile}
              className="flex h-6 w-6 items-center justify-center rounded-full text-[14px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--glass-hover)] hover:text-[var(--text-primary)]"
              aria-label="移除附件"
            >
              ×
            </button>
          </div>
        )
      )}

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept="image/*,application/pdf,text/*"
        onChange={onFileSelect}
      />

      <div
        className="rounded-[22px] border p-2.5 transition-all focus-within:border-[rgba(10,132,255,0.36)]"
        style={{
          background: "var(--composer-bg)",
          borderColor: "var(--border)",
          boxShadow: "var(--shadow-card), inset 0 1px 0 rgba(255,255,255,0.07)",
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
          placeholder={
            mode === "code"
              ? "描述要分析、创建或修改的项目任务…"
              : "输入你的问题…"
          }
          className="max-h-44 min-w-0 w-full resize-none bg-transparent px-2.5 pb-2 pt-1.5 text-[13px] leading-6 outline-none placeholder:text-[var(--text-quaternary)] disabled:opacity-50"
          style={{ color: "var(--text-primary)" }}
        />

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
              title="添加文件"
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
              disabled={disabled || (!input.trim() && !attachedFile)}
              className="flex h-9 w-9 items-center justify-center rounded-[11px] text-white transition-all active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-30"
              style={{
                background: "linear-gradient(180deg, var(--message-user-start), var(--message-user-end))",
                boxShadow: "0 8px 18px rgba(10,132,255,0.22), inset 0 1px 0 rgba(255,255,255,0.2)",
              }}
              title="发送"
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
                <path
                  d="M10 15.5v-11M5.5 9 10 4.5 14.5 9"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
