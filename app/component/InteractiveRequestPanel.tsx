"use client";

import type { InteractiveRequest } from "../types/workspace";

interface InteractiveRequestPanelProps {
  request: InteractiveRequest;
  answer: string;
  onAnswerChange: (value: string) => void;
  onReply: (mode: "auto" | "llm" | "user", answer?: string) => void;
}

function FileCreateConfirmationCard({
  request,
  onReply,
}: Pick<InteractiveRequestPanelProps, "request" | "onReply">) {
  const createOption =
    request.options.find((option) => option.value === "create") ||
    request.options[0];
  const cancelOption =
    request.options.find((option) => option.value === "cancel") ||
    request.options[1];

  return (
    <section
      className="mb-3 overflow-hidden rounded-[22px] border"
      style={{
        background: "color-mix(in srgb, var(--glass-strong) 92%, transparent)",
        borderColor: "color-mix(in srgb, var(--border) 82%, white 18%)",
        boxShadow:
          "0 18px 55px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.10)",
        backdropFilter: "blur(32px) saturate(150%)",
        WebkitBackdropFilter: "blur(32px) saturate(150%)",
      }}
      aria-live="polite"
    >
      <div className="flex items-start gap-3.5 px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border"
          style={{
            background: "rgba(10,132,255,0.11)",
            borderColor: "rgba(10,132,255,0.18)",
            color: "#0a84ff",
          }}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
            <path
              d="M7 3.75h6.8L18 7.95v12.3H7z"
              stroke="currentColor"
              strokeWidth="1.55"
              strokeLinejoin="round"
            />
            <path
              d="M13.75 3.9v4.25h4.05M12.5 11v6M9.5 14h6"
              stroke="currentColor"
              strokeWidth="1.55"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>

        <div className="min-w-0 flex-1">
          <p
            className="text-[13px] font-semibold tracking-[-0.01em]"
            style={{ color: "var(--text-primary)" }}
          >
            {request.title || "没有找到目标文件"}
          </p>
          <p
            className="mt-1 text-[12px] font-medium leading-5"
            style={{ color: "var(--text-secondary)" }}
          >
            {request.prompt}
          </p>
          {request.description && (
            <p
              className="mt-1.5 max-w-[720px] text-[11px] leading-[1.65]"
              style={{ color: "var(--text-tertiary)" }}
            >
              {request.description}
            </p>
          )}

          {request.filePath && (
            <div
              className="mt-3 inline-flex max-w-full items-center rounded-[8px] border px-2.5 py-1.5 font-mono text-[10px]"
              style={{
                background: "var(--glass-black)",
                borderColor: "var(--border)",
                color: "var(--text-secondary)",
              }}
            >
              <span className="truncate">{request.filePath}</span>
            </div>
          )}
        </div>
      </div>

      <div
        className="flex items-center justify-end gap-2 border-t px-4 py-3 sm:px-5"
        style={{ borderColor: "var(--border)" }}
      >
        <button
          type="button"
          onClick={() => onReply("user", cancelOption?.value || "cancel")}
          className="h-9 rounded-[10px] border px-3.5 text-[11px] font-semibold transition-[background,transform] hover:bg-[var(--glass-hover)] active:scale-[0.98]"
          style={{
            background: "var(--glass)",
            borderColor: "var(--border)",
            color: "var(--text-secondary)",
          }}
        >
          {cancelOption?.label || "暂不新建"}
        </button>
        <button
          type="button"
          onClick={() => onReply("user", createOption?.value || "create")}
          className="h-9 rounded-[10px] px-3.5 text-[11px] font-semibold text-white shadow-[0_5px_18px_rgba(10,132,255,0.24)] transition-[filter,transform] hover:brightness-105 active:scale-[0.98]"
          style={{ background: "#0a84ff" }}
        >
          {createOption?.label || "新建并继续"}
        </button>
      </div>
    </section>
  );
}

function TerminalInteractiveCard({
  request,
  answer,
  onAnswerChange,
  onReply,
}: InteractiveRequestPanelProps) {
  return (
    <section
      className="mb-3 overflow-hidden rounded-[20px] border"
      style={{
        background: "linear-gradient(180deg, var(--glass), var(--glass-soft))",
        borderColor: "rgba(10,132,255,0.22)",
        boxShadow:
          "var(--shadow-soft), inset 0 1px 0 rgba(255,255,255,0.055)",
      }}
    >
      <div className="flex items-start gap-3 px-4 py-3.5">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]"
          style={{ background: "rgba(10,132,255,0.13)", color: "#64b5ff" }}
        >
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none">
            <path
              d="M5 6.5h14v11H5z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path
              d="m8 10 2 2-2 2M12.5 14h3.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-semibold">终端需要你的选择</div>
              <div className="mt-0.5 text-[10px] text-[var(--text-tertiary)]">
                第 {request.promptRound} 次交互 · 保持当前进程
              </div>
            </div>
            <span
              className="rounded-full px-2 py-1 font-mono text-[9px] uppercase"
              style={{ background: "rgba(10,132,255,0.11)", color: "#64b5ff" }}
            >
              {request.mode}
            </span>
          </div>

          <div className="mt-3 text-[11px] text-[var(--text-tertiary)]">
            运行命令
          </div>
          <div
            className="mt-1 rounded-[10px] border px-3 py-2 font-mono text-[11px] leading-5"
            style={{
              background: "var(--glass-black)",
              borderColor: "var(--border)",
              color: "var(--text-primary)",
            }}
          >
            {request.command}
          </div>

          <div className="mt-3 whitespace-pre-wrap text-[12px] leading-5 text-[var(--text-secondary)]">
            {request.prompt}
          </div>
        </div>
      </div>

      <div
        className="mx-4 max-h-40 overflow-auto whitespace-pre-wrap rounded-[12px] border p-3 font-mono text-[10px] leading-5"
        style={{
          background: "var(--glass-black)",
          borderColor: "var(--border)",
          color: "var(--text-secondary)",
        }}
      >
        {request.recentOutput || "终端正在等待更多输出…"}
      </div>

      <div className="flex flex-wrap gap-2 px-4 pb-3 pt-3">
        {request.options.map((option, index) => (
          <button
            key={`${request.id}-${option.value}`}
            type="button"
            onClick={() => onReply("user", option.value)}
            className="rounded-[10px] border px-3 py-2 text-[11px] font-medium transition-all hover:-translate-y-px active:translate-y-0"
            style={{
              background:
                index === 0
                  ? "linear-gradient(180deg, #168dff, #0879eb)"
                  : "var(--glass)",
              borderColor:
                index === 0 ? "rgba(10,132,255,0.46)" : "var(--border)",
              color: index === 0 ? "white" : "var(--text-secondary)",
            }}
          >
            {option.label}
          </button>
        ))}

        <button
          type="button"
          onClick={() => onReply("auto")}
          className="rounded-[10px] border px-3 py-2 text-[11px] font-medium transition-colors hover:bg-[var(--glass-hover)]"
          style={{
            background: "var(--glass)",
            borderColor: "var(--border)",
            color: "var(--text-secondary)",
          }}
        >
          自动选择
        </button>

        <button
          type="button"
          onClick={() => onReply("llm")}
          className="rounded-[10px] border px-3 py-2 text-[11px] font-medium transition-colors hover:bg-[var(--glass-hover)]"
          style={{
            background: "var(--glass)",
            borderColor: "var(--border)",
            color: "var(--text-secondary)",
          }}
        >
          交给 Agent
        </button>
      </div>

      <div
        className="flex gap-2 border-t px-4 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <input
          value={answer}
          onChange={(event) => onAnswerChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onReply("user");
            }
          }}
          placeholder="输入自定义回答，留空表示发送回车"
          className="h-9 min-w-0 flex-1 rounded-[10px] border bg-[var(--glass-black)] px-3 text-[11px] outline-none placeholder:text-[var(--text-quaternary)] focus:border-[#0a84ff]"
          style={{ borderColor: "var(--border)", color: "var(--text-primary)" }}
        />
        <button
          type="button"
          onClick={() => onReply("user")}
          className="h-9 rounded-[10px] px-3 text-[11px] font-semibold text-white transition-all active:scale-[0.98]"
          style={{ background: "#0a84ff" }}
        >
          发送输入
        </button>
      </div>
    </section>
  );
}

/**
 * 统一的交互请求面板。
 *
 * 缺失文件确认使用简洁的 Apple 风格双按钮卡片；现有 PTY/CLI 交互保持原来的
 * 终端信息密度，两类请求共用同一个 SSE/回复通道，不需要额外接口。
 */
export default function InteractiveRequestPanel(
  props: InteractiveRequestPanelProps,
) {
  if (props.request.source === "file_create_confirmation") {
    return (
      <FileCreateConfirmationCard
        request={props.request}
        onReply={props.onReply}
      />
    );
  }

  return <TerminalInteractiveCard {...props} />;
}
