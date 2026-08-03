// 模块说明：负责 TaskPlanningPanel 用户界面组件。
"use client";

import { useMemo } from "react";
import type { AgentLifecycleEventPayload } from "../types/workspace";
import QualityMetricsCard from "./task-planning/QualityMetricsCard";
import {
  AMAZON_LISTING_STAGE_DEFINITIONS,
  CODE_STAGE_DEFINITIONS,
  COMMERCE_RESEARCH_STAGE_DEFINITIONS,
  MEDIA_STAGE_DEFINITIONS,
  STATUS_META,
} from "./task-planning/config";
import {
  buildPlanningStages,
  buildPlanningSummary,
  buildWorkListProgress,
} from "./task-planning/derive";
import type {
  PlanningStageStatus,
  TaskPlanningPanelProps,
} from "./task-planning/types";

/**
 * 根据阶段状态渲染无文字依赖的轻量图标。
 *
 * 图标始终继承父级颜色，确保深浅主题和异常状态保持一致的视觉语义。
 */
function liveActionLabel(event: AgentLifecycleEventPayload): string {
  const detail = event.detail || "";
  if (detail.includes("读取")) return "正在读取";
  if (detail.includes("修改") || detail.includes("写入") || detail.includes("合并")) {
    return "正在修改";
  }
  return "正在处理";
}

function workIdFromAgent(agentId: string): string {
  const match = agentId.match(/:([A-Za-z0-9_-]{2,})$/);
  return match ? match[1] : agentId;
}

function StageIcon({ status }: { status: PlanningStageStatus }) {
  if (status === "completed") {
    return (
      <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none">
        <path
          d="m5 10.2 3.1 3.1L15.2 6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (status === "skipped") {
    return (
      <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none">
        <path
          d="M6 10h8"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (status === "error") {
    return (
      <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none">
        <path
          d="M10 5.2v5.4M10 14.3v.2"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (status === "active") {
    return <span className="h-2 w-2 animate-pulse rounded-full bg-current" />;
  }

  return <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />;
}

/**
 * 实时任务规划面板。
 *
 * 所有阶段数据都由 props 计算得到，不使用 useEffect + setState 同步派生状态。
 */
export default function TaskPlanningPanel({
  agents,
  toolActivities = [],
  lifecycleEvents = [],
  workListSnapshot = null,
  agentStatus,
  isStreaming,
  workflowMode,
  className = "",
}: TaskPlanningPanelProps) {
  const definitions =
    workflowMode === "commerce-listing"
      ? AMAZON_LISTING_STAGE_DEFINITIONS
      : workflowMode === "commerce-research"
        ? COMMERCE_RESEARCH_STAGE_DEFINITIONS
        : workflowMode === "chat"
          ? CODE_STAGE_DEFINITIONS
          : MEDIA_STAGE_DEFINITIONS;
  const stages = useMemo(
    () =>
      buildPlanningStages(
        definitions,
        agents,
        toolActivities,
        isStreaming,
        agentStatus,
        lifecycleEvents,
      ),
    [
      agentStatus,
      agents,
      definitions,
      isStreaming,
      lifecycleEvents,
      toolActivities,
    ],
  );
  const summary = useMemo(() => buildPlanningSummary(stages), [stages]);
  const workProgress = useMemo(
    () => buildWorkListProgress(workListSnapshot),
    [workListSnapshot],
  );
  const latestWorkEvents = useMemo(() => {
    const map = new Map<string, AgentLifecycleEventPayload>();
    lifecycleEvents.forEach((event) => {
      const match = event.agentId.match(/:([A-Za-z0-9_-]{2,})$/);
      const workId = match ? match[1] : null;
      if (!workId) return;
      const existing = map.get(workId);
      const existingTime = existing
        ? Date.parse(existing.createdAt) || 0
        : -1;
      const eventTime = Date.parse(event.createdAt) || 0;
      if (
        !existing ||
        eventTime > existingTime ||
        (eventTime === existingTime &&
          (event.sequence || 0) >= (existing.sequence || 0))
      ) {
        map.set(workId, event);
      }
    });
    return map;
  }, [lifecycleEvents]);
  const changedFiles = useMemo(() => {
    const set = new Set<string>();
    lifecycleEvents.forEach((event) => {
      if (
        event.role === "merge_agent" &&
        event.status?.toUpperCase() === "COMPLETED" &&
        event.currentFiles?.length
      ) {
        event.currentFiles.forEach((path) => set.add(path));
      }
    });
    workListSnapshot?.items?.forEach((item) => {
      (item.changedFiles || []).forEach((path) => set.add(path));
    });
    return Array.from(set);
  }, [lifecycleEvents, workListSnapshot]);
  const liveEditing = useMemo<AgentLifecycleEventPayload | null>(() => {
    let best: AgentLifecycleEventPayload | null = null;
    let bestTime = -1;
    latestWorkEvents.forEach((event) => {
      if (!event.currentFiles?.length) return;
      if (event.status?.toUpperCase() === "COMPLETED") return;
      const time = Date.parse(event.createdAt) || 0;
      if (time >= bestTime) {
        best = event;
        bestTime = time;
      }
    });
    return best;
  }, [latestWorkEvents]);
  const hasWorkList = Boolean(workProgress);
  const workFinished = workProgress?.finished || 0;
  const displayProgress = workProgress
    ? workProgress.overallProgress
    : summary.overallProgress;
  const displayFailed = workProgress
    ? workProgress.failed > 0
    : summary.failed;
  const statusText = hasWorkList
    ? workProgress?.failed
      ? `${workProgress.failed} 个 Work 失败，Planner 正在重规划`
      : workProgress?.runningItems.length
        ? workProgress.runningItems.length > 1
          ? `并行执行 ${workProgress.runningItems.length} 个 Work：${workProgress.activeWorkIds.join(", ")}`
          : workProgress.running?.title || "正在执行 WorkList"
        : workFinished === workProgress?.total
          ? "全部 Work 已完成"
          : workListSnapshot?.reason || "等待执行 WorkList"
    : summary.failed
      ? "流程存在异常，请检查当前阶段"
      : summary.active
        ? `正在执行：${summary.active.title}`
        : summary.completed === stages.length
          ? summary.skipped > 0
            ? `本轮已结束，跳过 ${summary.skipped} 个无需执行阶段`
            : "全部阶段已完成"
          : "等待新的项目任务";

  return (
    <section
      className={`task-planning-panel flex min-h-[300px] max-h-[46%] shrink-0 flex-col overflow-hidden rounded-[22px] border ${className}`}
      style={{
        background:
          "linear-gradient(145deg, var(--glass-strong), var(--glass-soft))",
        borderColor: "var(--border)",
        boxShadow:
          "var(--shadow-card), inset 0 1px 0 rgba(255,255,255,0.08)",
        backdropFilter: "blur(34px) saturate(155%)",
        WebkitBackdropFilter: "blur(34px) saturate(155%)",
      }}
    >
      <header className="shrink-0 px-4 pb-3 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border"
              style={{
                background: "rgba(10,132,255,0.13)",
                borderColor: "rgba(10,132,255,0.22)",
                color: "#64b5ff",
              }}
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
                <path
                  d="M5 4.2h10M5 8.1h10M5 12h6.5M5 15.9h4"
                  stroke="currentColor"
                  strokeWidth="1.55"
                  strokeLinecap="round"
                />
                <circle
                  cx="15.2"
                  cy="14.6"
                  r="2.2"
                  stroke="currentColor"
                  strokeWidth="1.45"
                />
              </svg>
            </span>
            <div className="min-w-0">
              <h2
                className="truncate text-[13px] font-semibold tracking-[-0.01em]"
                style={{ color: "var(--text-primary)" }}
              >
                任务规划
              </h2>
              <p
                className="mt-0.5 truncate text-[10px]"
                style={{ color: "var(--text-tertiary)" }}
              >
<<<<<<< HEAD
                {summary.failed
                  ? "流程存在异常，请检查当前阶段"
                  : summary.active
                    ? `正在执行：${summary.active.title}`
                    : summary.completed === stages.length
                      ? summary.skipped > 0
                        ? `本轮已结束，跳过 ${summary.skipped} 个无需执行阶段`
                        : "全部阶段已完成"
                      : "等待新的项目任务"}
=======
                {statusText}
>>>>>>> changePython
              </p>
            </div>
          </div>

          <span
            className="shrink-0 rounded-full px-2 py-1 font-mono text-[9px] tabular-nums"
            style={{
              color: displayFailed ? "var(--accent-red)" : "#64b5ff",
              background: displayFailed
                ? "rgba(255,69,58,0.11)"
                : "rgba(10,132,255,0.12)",
            }}
          >
            {displayProgress}%
          </span>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <div
            className="h-[5px] min-w-0 flex-1 overflow-hidden rounded-full"
            style={{ background: "var(--glass)" }}
          >
            <span
              className="block h-full rounded-full transition-[width] duration-500"
              style={{
                width: `${displayProgress}%`,
                background: displayFailed
                  ? "var(--accent-red)"
                  : "linear-gradient(90deg, #0a84ff, #bf5af2)",
              }}
            />
          </div>
          <span
            className="text-[9px] tabular-nums"
            style={{ color: "var(--text-tertiary)" }}
          >
            {hasWorkList
              ? `${workFinished}/${workProgress?.total || 0} Work`
              : `${summary.completed}/${stages.length} 阶段`}
          </span>
        </div>
      </header>

      <div
        className="mx-4 h-px shrink-0"
        style={{ background: "var(--border)" }}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {(liveEditing || changedFiles.length > 0) && (
          <div
            className="mb-3 rounded-[14px] border p-2"
            style={{ borderColor: "var(--border)", background: "var(--glass)" }}
          >
            {liveEditing && (
              <div className="flex items-center gap-2 px-1">
                <span
                  className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                  style={{ background: "#64b5ff" }}
                />
                <span
                  className="min-w-0 flex-1 truncate text-[9px] font-medium"
                  style={{ color: "#64b5ff" }}
                  title={(liveEditing.currentFiles || []).join("、")}
                >
                  {liveActionLabel(liveEditing)} {workIdFromAgent(liveEditing.agentId)} ·{" "}
                  {(liveEditing.currentFiles || []).join("、")}
                </span>
              </div>
            )}
            {changedFiles.length > 0 && (
              <div
                className={liveEditing ? "mt-2 border-t pt-1.5" : ""}
                style={{ borderColor: "var(--border)" }}
              >
                <p
                  className="px-1 text-[8px] font-semibold"
                  style={{ color: "var(--text-tertiary)" }}
                >
                  本次已修改 {changedFiles.length} 个文件
                </p>
                <div className="mt-1 max-h-24 space-y-0.5 overflow-y-auto px-1">
                  {changedFiles.map((path) => (
                    <div key={path} className="flex items-center gap-1.5">
                      <span
                        className="shrink-0 text-[8px]"
                        style={{ color: "var(--accent-green)" }}
                      >
                        ✓
                      </span>
                      <span
                        className="truncate font-mono text-[8px]"
                        style={{ color: "var(--text-secondary)" }}
                        title={path}
                      >
                        {path}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        {hasWorkList && workListSnapshot && (
          <div
            className="mb-3 space-y-1.5 rounded-[14px] border p-2"
            style={{ borderColor: "var(--border)", background: "var(--glass)" }}
          >
            <div className="flex items-center justify-between px-1">
              <span className="text-[9px] font-semibold" style={{ color: "var(--text-secondary)" }}>
                WorkList · revision {workListSnapshot.revision}
              </span>
              <span className="text-[8px]" style={{ color: "var(--text-tertiary)" }}>
                成功 {workListSnapshot.succeeded} · 失败 {workListSnapshot.failed}
                {workListSnapshot.scheduler?.maxParallel
                  ? ` · 并行 ${workListSnapshot.scheduler.maxParallel}`
                  : ""}
              </span>
            </div>
            {workListSnapshot.items.map((item) => {
              const failed = item.status === "failed";
              const completed = ["succeeded", "skipped"].includes(item.status);
              return (
                <div
                  key={item.id}
                  className="rounded-[9px] px-2 py-1.5"
                  style={{
                    background: failed ? "rgba(255,69,58,0.05)" : "transparent",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        background: failed
                          ? "var(--accent-red)"
                          : completed
                            ? "var(--accent-green)"
                            : item.status === "running"
                              ? "#64b5ff"
                              : "var(--text-quaternary)",
                      }}
                    />
                    <span
                      className="shrink-0 font-mono text-[8px]"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      {item.id}
                      {typeof item.priority === "number" ? `·P${item.priority}` : ""}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate text-[9px]"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {item.title}
                    </span>
                    <span
                      className="shrink-0 text-[8px]"
                      style={{
                        color: failed
                          ? "var(--accent-red)"
                          : "var(--text-tertiary)",
                      }}
                    >
                      {failed && item.attempts > 1
                        ? `failed · ${item.attempts} 次`
                        : item.status}
                    </span>
                  </div>
                  {(() => {
                    const liveEvent =
                      item.status === "running"
                        ? latestWorkEvents.get(item.id)
                        : null;
                    if (!liveEvent) return null;
                    const files = liveEvent.currentFiles?.length
                      ? liveEvent.currentFiles
                      : null;
                    return (
                      <p
                        className="mt-1 truncate pl-3.5 text-[8px] leading-[1.45]"
                        style={{
                          color: files ? "#64b5ff" : "var(--text-tertiary)",
                        }}
                        title={files ? files.join("、") : liveEvent.detail}
                      >
                        {files ? `正在修改：${files.join("、")}` : liveEvent.detail}
                      </p>
                    );
                  })()}
                  {failed && item.error && (
                    <p
                      className="mt-1 line-clamp-2 pl-3.5 text-[8px] leading-[1.45]"
                      style={{ color: "var(--text-tertiary)" }}
                      title={item.error}
                    >
                      {item.error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {workListSnapshot && (
          <QualityMetricsCard snapshot={workListSnapshot} />
        )}
        <div className="relative space-y-1.5">
          <span
            className="pointer-events-none absolute bottom-5 left-[18px] top-5 w-px"
            style={{ background: "var(--border)" }}
          />

          {stages.map((stage, index) => {
            const meta = STATUS_META[stage.status];
            const isActive = stage.status === "active";

            return (
              <article
                key={stage.id}
                className={
                  "planning-stage relative flex gap-3 rounded-[14px] border " +
                  "px-2.5 py-2.5 transition-all duration-300"
                }
                style={{
                  background: isActive
                    ? "rgba(10,132,255,0.09)"
                    : "transparent",
                  borderColor: isActive
                    ? "rgba(10,132,255,0.22)"
                    : "transparent",
                }}
              >
                <span
                  className={
                    "relative z-10 mt-0.5 flex h-[17px] w-[17px] shrink-0 " +
                    "items-center justify-center rounded-full border"
                  }
                  style={{
                    color: meta.color,
                    background: "var(--glass-solid)",
                    borderColor:
                      stage.status === "idle" || stage.status === "queued"
                        ? "var(--border-strong)"
                        : meta.color,
                    boxShadow: isActive
                      ? "0 0 0 4px rgba(10,132,255,0.10)"
                      : "none",
                  }}
                >
                  <StageIcon status={stage.status} />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="shrink-0 font-mono text-[9px] tabular-nums"
                        style={{ color: "var(--text-quaternary)" }}
                      >
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <h3
                        className="truncate text-[11px] font-semibold"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {stage.title}
                      </h3>
                    </div>
                    <span
                      className="shrink-0 rounded-full px-2 py-0.5 text-[8px] font-medium"
                      style={{ color: meta.color, background: meta.background }}
                    >
                      {meta.label}
                    </span>
                  </div>

                  <p
                    className="mt-1 line-clamp-2 text-[9px] leading-4"
                    style={{ color: "var(--text-secondary)" }}
                    title={stage.detail}
                  >
                    {stage.detail}
                  </p>

                  {(isActive || stage.activityCount > 0) && (
                    <div className="mt-2 flex items-center gap-2">
                      <div
                        className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full"
                        style={{ background: "var(--glass)" }}
                      >
                        <span
                          className="block h-full rounded-full transition-[width] duration-500"
                          style={{
                            width: `${stage.progress}%`,
                            background: meta.color,
                          }}
                        />
                      </div>
                      {stage.activityCount > 0 && (
                        <span
                          className="shrink-0 font-mono text-[8px]"
                          style={{ color: "var(--text-tertiary)" }}
                        >
                          {stage.activityCount} activity
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <style>{`
        @keyframes planningStageEnter {
          from { opacity: 0; transform: translateY(5px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .planning-stage { animation: planningStageEnter 260ms var(--ease-apple); }
      `}</style>
    </section>
  );
}
