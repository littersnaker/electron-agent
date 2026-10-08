// 模块说明：聊天内的工作步骤；实时显示近期动作，完成后折叠为可追溯摘要。
"use client";
import { useId, useMemo } from "react";
import {
  deriveWorkflowSteps,
  workflowDisplayStatus,
  type MessageWorkflow,
  type WorkflowStatus,
} from "../../lib/message-workflow";

const STATUS_LABELS: Record<WorkflowStatus, string> = {
  running: "正在处理",
  completed: "已完成",
  failed: "执行失败",
  stopped: "已停止",
  waiting: "等待确认",
  interrupted: "已中断",
};

export type WorkflowDisclosure = { status: WorkflowStatus; open: boolean };

export function StepsTimeline({
  workflow,
  isLive = false,
  choice = null,
  onToggle,
}: {
  workflow?: MessageWorkflow;
  isLive?: boolean;
  choice?: WorkflowDisclosure | null;
  onToggle?: (choice: WorkflowDisclosure) => void;
}) {
  const id = useId();
  const steps = useMemo(
    () => (workflow ? deriveWorkflowSteps(workflow, isLive) : []),
    [workflow, isLive],
  );
  if (
    !workflow ||
    (!steps.length &&
      !workflow.workListSnapshot?.items.length &&
      !["waiting", "failed"].includes(workflow.status))
  )
    return null;
  const status = workflowDisplayStatus(workflow, isLive);
  const expanded = choice?.status === status && choice.open;
  const showRecent = status === "running" && choice?.open !== false;
  const visible = expanded ? steps : showRecent ? steps.slice(-3) : [];
  const elapsed = Math.max(
    0,
    Math.round(((workflow.endedAt ?? workflow.updatedAt) - workflow.startedAt) / 1000),
  );
  const attention = ["failed", "waiting", "stopped", "interrupted"].includes(status);
  const reason =
    status === "interrupted" && workflow.status === "running"
      ? "上次工作未正常结束，可通过现有恢复入口继续。"
      : workflow.detail;
  const workItems = workflow.workListSnapshot?.items ?? [];

  return (
    <section className="min-w-0 text-[12px] leading-5" aria-label="工作流程">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 text-(--text-secondary)" role="status" aria-live="polite">
          <span
            className="font-medium"
            style={{ color: status === "failed" ? "var(--accent-red)" : "var(--text-primary)" }}
          >
            {STATUS_LABELS[status]}
          </span>
          {status === "running" ? (
            <span className="break-words"> · {workflow.detail || steps.at(-1)?.label}</span>
          ) : (
            <span>
              {" "}
              · {steps.length || workItems.length} 个步骤 · 用时 {elapsed} 秒
            </span>
          )}
        </div>
        <button
          type="button"
          aria-expanded={Boolean(expanded)}
          aria-controls={id}
          onClick={() => onToggle?.({ status, open: !expanded })}
          className="shrink-0 rounded px-1 text-[11px] text-(--text-tertiary) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-blue)"
        >
          {expanded ? "收起详情" : "展开详情"}
        </button>
      </div>
      {attention && reason && <p className="mt-1 break-words text-(--text-secondary)">{reason}</p>}
      <div id={id}>
        {visible.length > 0 && (
          <ol className="mt-2 space-y-2 border-l border-(--border) pl-3">
            {visible.map((step) => {
              const color =
                step.status === "error"
                  ? "var(--accent-red)"
                  : step.status === "completed"
                    ? "var(--accent-green)"
                    : "var(--text-tertiary)";
              const glyph =
                step.status === "completed"
                  ? "✓"
                  : step.status === "error"
                    ? "!"
                    : step.status === "running"
                      ? "◌"
                      : "–";
              return (
                <li key={step.id} className="flex min-w-0 items-start gap-2">
                  <span
                    aria-hidden="true"
                    className={step.status === "running" ? "motion-safe:animate-pulse" : ""}
                    style={{ color }}
                  >
                    {glyph}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-(--text-secondary)">
                      <span className="sr-only">
                        {step.status === "error"
                          ? "失败"
                          : step.status === "completed"
                            ? "完成"
                            : step.status === "running"
                              ? "进行中"
                              : step.status === "waiting"
                                ? "等待确认"
                                : step.status === "skipped"
                                  ? "跳过"
                                  : "中断"}
                        ：
                      </span>
                      {step.label}
                      {Boolean(step.iteration) && (
                        <span className="ml-2 text-[11px] text-(--text-tertiary)">
                          第 {step.iteration! + 1} 轮返工
                        </span>
                      )}
                      {expanded && step.endedAt !== undefined && (
                        <span className="ml-2 text-[11px] text-(--text-tertiary)">
                          {Math.max(0, Math.round((step.endedAt - step.startedAt) / 1000))} 秒
                        </span>
                      )}
                    </div>
                    {step.detail && step.detail !== step.label && (
                      <p className="break-words text-[11px] text-(--text-tertiary)">
                        {step.detail}
                      </p>
                    )}
                    {expanded &&
                      step.files?.map((file) => (
                        <p
                          key={file}
                          className="break-all font-mono text-[11px] text-(--text-tertiary)"
                        >
                          {file}
                        </p>
                      ))}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {expanded && status === "completed" && workflow.detail && (
          <p className="mt-2 break-words text-[11px] text-(--text-secondary)">{workflow.detail}</p>
        )}
        {expanded && workItems.length > 0 && (
          <div className="mt-3 border-t border-(--border) pt-2">
            <p className="mb-1 font-medium text-(--text-secondary)">工作清单</p>
            <ul className="space-y-2">
              {workItems.map((item) => (
                <li key={item.id} className="break-words text-(--text-secondary)">
                  <span className="mr-2">
                    {item.status === "succeeded"
                      ? "✓"
                      : item.status === "failed"
                        ? "!"
                        : item.status === "running"
                          ? "◌"
                          : "–"}
                  </span>
                  {item.title}
                  <span className="ml-2 text-[11px] text-(--text-tertiary)">
                    {
                      {
                        pending: "待处理",
                        running: "进行中",
                        paused: "已暂停",
                        succeeded: "完成",
                        failed: "失败",
                        skipped: "跳过",
                      }[item.status]
                    }
                  </span>
                  {item.attempts > 1 && (
                    <span className="ml-2 text-[11px] text-(--text-tertiary)">
                      第 {item.attempts} 次尝试
                    </span>
                  )}
                  {(item.error || item.summary) && (
                    <p className="pl-4 text-[11px] text-(--text-tertiary)">
                      {item.error || item.summary}
                    </p>
                  )}
                  {item.changedFiles?.map((file) => (
                    <p
                      key={file}
                      className="break-all pl-4 font-mono text-[11px] text-(--text-tertiary)"
                    >
                      {file}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
