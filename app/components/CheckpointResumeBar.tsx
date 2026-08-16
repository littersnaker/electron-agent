"use client";

import type { AgentCheckpoint } from "../types/checkpoints";

interface CheckpointResumeBarProps {
  checkpoint: AgentCheckpoint;
  disabled?: boolean;
  onResume: () => void;
  onDiscard: () => void;
}

const KIND_LABELS: Record<AgentCheckpoint["agentKind"], string> = {
  qa: "QA Agent",
  code: "Code Agent",
  media: "Media Agent",
  commerce: "Commerce Agent",
  image: "Image Agent",
};

/** 显示上次中断任务，并提供恢复或放弃入口。 */
export default function CheckpointResumeBar({
  checkpoint,
  disabled = false,
  onResume,
  onDiscard,
}: CheckpointResumeBarProps) {
  const updatedAt = new Date(checkpoint.updatedAt).toLocaleString();
  return (
    <div
      className="mb-2 flex items-center gap-3 rounded-[14px] border px-3 py-2"
      style={{
        background: "color-mix(in srgb, var(--glass-solid) 88%, #0a84ff 12%)",
        borderColor: "rgba(10,132,255,0.28)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
      }}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[rgba(10,132,255,0.13)] text-[#64b5ff]">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
          <path
            d="M5 8a8 8 0 1 1-1 7M5 8V3M5 8h5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-semibold text-[var(--text-primary)]">
          可恢复：{checkpoint.label || KIND_LABELS[checkpoint.agentKind]}
        </div>
        <div className="truncate text-[9px] text-[var(--text-quaternary)]">
          {checkpoint.agentKind === "code"
            ? "会保留已成功 Work、已修改文件和验证记录"
            : "会从最后保存的请求重新继续"}
          {` · ${updatedAt}`}
        </div>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onDiscard}
        className="h-8 rounded-[9px] border px-3 text-[10px] font-semibold disabled:opacity-40"
        style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
      >
        放弃
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onResume}
        className="h-8 rounded-[9px] px-3 text-[10px] font-semibold text-white disabled:opacity-40"
        style={{ background: "linear-gradient(180deg, #168dff, #0879eb)" }}
      >
        恢复任务
      </button>
    </div>
  );
}
