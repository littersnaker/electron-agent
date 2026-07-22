"use client";

import type { InteractiveRequest } from "../types/workspace";

interface InteractiveRequestPanelProps {
  request: InteractiveRequest;
  answer: string;
  onAnswerChange: (value: string) => void;
  onReply: (mode: "auto" | "llm" | "user", answer?: string) => void;
}

export default function InteractiveRequestPanel({
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
        boxShadow: "var(--shadow-soft), inset 0 1px 0 rgba(255,255,255,0.055)",
      }}
    >
      <div className="flex items-start gap-3 px-4 py-3.5">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]"
          style={{ background: "rgba(10,132,255,0.13)", color: "#64b5ff" }}
        >
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none">
            <path d="M5 6.5h14v11H5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="m8 10 2 2-2 2M12.5 14h3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
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

          <div className="mt-3 text-[11px] text-[var(--text-tertiary)]">运行命令</div>
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

      <div className="flex gap-2 border-t px-4 py-3" style={{ borderColor: "var(--border)" }}>
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
