"use client";
/**
 * 工作台右侧信息面板：任务规划（常驻）+ 折叠的执行图/预览/Agent 状态。
 *
 * 从 page.tsx 抽离的独立面板，保持页面入口文件在 500 行以内；
 * 所有数据均由 props 传入，不持有业务状态。
 * 视觉降噪：次要面板默认收起（CollapsiblePanel），运行状态用摘要提示。
 */
import type { AgentLifecycleEventPayload, WorkListSnapshotPayload } from "../types/workspace";
import type { VisualReviewController } from "../hooks/useChatStream/use-visual-review";
import AgentPanel, { type AgentInstance } from "./AgentPanel";
import type { ToolActivity } from "./AssistantMessageRow";
import CollapsiblePanel from "./CollapsiblePanel";
import ExecutionGraphPanel from "./execution-graph/ExecutionGraphPanel";
import PreviewPanel from "./preview/PreviewPanel";
import TaskPlanningPanel from "./TaskPlanningPanel";
import type { TaskPlanningWorkflowMode } from "./task-planning/types";

interface AgentTaskPanelProps {
  /** 全部 Agent 实例状态 */
  agents: AgentInstance[];
  /** 当前工具活动列表 */
  toolActivities: ToolActivity[];
  /** Agent 生命周期事件（commerce 模式为空） */
  lifecycleEvents: AgentLifecycleEventPayload[];
  /** Code 模式的工作列表快照 */
  workListSnapshot: WorkListSnapshotPayload | null;
  /** 当前 Agent 状态摘要 */
  agentStatus: string | undefined;
  /** 是否正在流式执行 */
  isStreaming: boolean;
  /** 当前工作流模式 */
  workflowMode: TaskPlanningWorkflowMode;
  /** 视觉 Review 编排器（内置浏览器滚动截图 + 模型审查） */
  visualReview: VisualReviewController;
  /** 项目根目录，预览面板启动用 */
  projectRootPath: string;
  /** 用户配置的支持视觉的自定义模型 */
  visionModels: Array<{ id: string; name: string }>;
  /** 漫剧会话：展示角色库入口 */
  isMediaSession?: boolean;
  /** 打开角色库管理弹窗 */
  onOpenCharacterLibrary?: () => void;
}

function LibraryIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none">
      <path
        d="M10 3.2c.42 2.8 2.07 4.45 4.86 4.86-2.79.42-4.44 2.07-4.86 4.87-.42-2.8-2.07-4.45-4.86-4.87C7.93 7.65 9.58 6 10 3.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M14.6 12.4c.2 1.36 1 2.16 2.36 2.36-1.36.2-2.16 1-2.36 2.37-.2-1.36-1-2.17-2.36-2.37 1.36-.2 2.16-1 2.36-2.36Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 右侧固定面板：任务规划进度（常驻）+ 折叠的执行图/预览/Agent 状态。 */
export default function AgentTaskPanel({
  agents,
  toolActivities,
  lifecycleEvents,
  workListSnapshot,
  agentStatus,
  isStreaming,
  workflowMode,
  visualReview,
  projectRootPath,
  visionModels,
  isMediaSession = false,
  onOpenCharacterLibrary,
}: AgentTaskPanelProps) {
  const runningCount = agents.filter((agent) => agent.status === "running").length;
  const eventCount = lifecycleEvents.length;
  const previewActive = Boolean(
    visualReview?.status && visualReview.status !== "idle" && visualReview.status !== "done",
  );

  return (
    <aside className="hidden min-h-0 w-[360px] shrink-0 flex-col gap-3 overflow-y-auto lg:flex">
      <TaskPlanningPanel
        agents={agents}
        toolActivities={toolActivities}
        lifecycleEvents={lifecycleEvents}
        workListSnapshot={workListSnapshot}
        agentStatus={agentStatus}
        isStreaming={isStreaming}
        workflowMode={workflowMode}
      />

      {isMediaSession && onOpenCharacterLibrary && (
        <button
          type="button"
          onClick={onOpenCharacterLibrary}
          className="group flex shrink-0 items-center gap-2.5 rounded-[14px] border px-3 py-2 text-left transition-all duration-200 active:scale-[0.99] hover:brightness-[1.06]"
          style={{
            background: "color-mix(in srgb, var(--accent-blue-soft-strong) 72%, transparent)",
            borderColor: "var(--accent-blue-border)",
          }}
          title="管理角色设定图库（跨集复用）"
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border text-(--accent-blue-hover)"
            style={{
              background: "var(--accent-blue-soft-strong)",
              borderColor: "var(--accent-blue-border-strong)",
            }}
          >
            <LibraryIcon className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11.5px] font-semibold tracking-[-0.01em] text-(--text-primary)">
              角色库
            </span>
            <span className="block truncate text-[9px] text-(--text-tertiary)">
              设定图跨集复用 · 同描述只生成一次
            </span>
          </span>
          <span className="text-[10px] text-(--text-tertiary) transition-transform duration-200 group-hover:translate-x-0.5">
            →
          </span>
        </button>
      )}

      <CollapsiblePanel title="执行图" hint={eventCount > 0 ? `${eventCount}` : undefined}>
        <ExecutionGraphPanel lifecycleEvents={lifecycleEvents} toolActivities={toolActivities} />
      </CollapsiblePanel>

      <CollapsiblePanel
        title="Agent 状态"
        hint={runningCount > 0 ? `${runningCount} 运行中` : undefined}
      >
        <AgentPanel agents={agents} isStreaming={isStreaming} className="" />
      </CollapsiblePanel>

      <CollapsiblePanel
        title="页面预览"
        hint={previewActive ? "进行中" : undefined}
      >
        <PreviewPanel review={visualReview} rootPath={projectRootPath} visionModels={visionModels} />
      </CollapsiblePanel>
    </aside>
  );
}
