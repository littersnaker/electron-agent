// 模块说明：对话区内可折叠的线性步骤时间轴，所有 Agent 共用。
"use client";

import { useMemo, useState } from "react";
import type { ToolActivity } from "../AssistantMessageRow";

const COLORS = {
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  textSubtle: "var(--text-tertiary)",
  border: "var(--border)",
  green: "var(--accent-green)",
  red: "var(--accent-red)",
  amber: "var(--accent-amber)",
};

export function StepsTimeline({ steps }: { steps: ToolActivity[] }) {
  const [open, setOpen] = useState(false);
  const sorted = useMemo(
    () => [...steps].sort((a, b) => a.startedAt - b.startedAt),
    [steps],
  );
  if (sorted.length === 0) return null;

  return (
    <details
      className="rounded-[12px] border px-3 py-2"
      style={{ borderColor: COLORS.border, background: "var(--glass)" }}
      open={open}
    >
      <summary
        className="cursor-pointer select-none text-[11px] font-semibold"
        style={{ color: COLORS.text }}
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        步骤时间轴（{sorted.length}）
      </summary>
      <ol className="mt-2 space-y-1.5">
        {sorted.map((step) => {
          const failed = step.status === "error";
          const running = step.status === "running";
          const color = failed ? COLORS.red : running ? COLORS.amber : COLORS.green;
          const duration =
            step.endedAt && step.startedAt
              ? `${Math.max(0, Math.round((step.endedAt - step.startedAt) / 1000))}s`
              : running
                ? "进行中"
                : "";
          return (
            <li key={step.id} className="flex gap-2 text-[11px]">
              <span
                className="mt-1 h-2 w-2 shrink-0 rounded-full"
                style={{ background: color }}
              />
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium" style={{ color: COLORS.text }}>
                    {step.label || "工具调用"}
                  </span>
                  {duration ? (
                    <span style={{ color: COLORS.textSubtle }}>{duration}</span>
                  ) : null}
                </div>
                {step.detail ? (
                  <div
                    className="break-words text-[10px]"
                    style={{ color: COLORS.textMuted }}
                  >
                    {step.detail}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
