"use client";
/**
 * 工作台右侧信息面板：任务规划 + 页面预览 + Agent 状态。
 *
 * 从 page.tsx 抽离的独立面板，保持页面入口文件在 500 行以内；
 * 所有数据均由 props 传入，不持有业务状态。
 */
import type { AgentLifecycleEventPayload, WorkListSnapshotPayload } from "../types/workspace";
import type { VisualReviewController } from "../hooks/useChatStream/use-visual-review";
import AgentPanel, { type AgentInstance } from "./AgentPanel";
import type { ToolActivity } from "./AssistantMessageRow";
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

/** 右侧固定面板：任务规划进度 + 页面预览 + Agent 状态卡。 */
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
  return (
    <aside className="hidden min-h-0 w-[360px] shrink-0 flex-col gap-4 overflow-y-auto lg:flex">
      <TaskPlanningPanel
        agents={agents}
        toolActivities={toolActivities}
        lifecycleEvents={lifecycleEvents}
        workListSnapshot={workListSnapshot}
        agentStatus={agentStatus}
        isStreaming={isStreaming}
        workflowMode={workflowMode}
      />
      <ExecutionGraphPanel lifecycleEvents={lifecycleEvents} toolActivities={toolActivities} />
      {isMediaSession && onOpenCharacterLibrary && (
        <button
          type="button"
          onClick={onOpenCharacterLibrary}
          className="group flex items-center gap-3 rounded-[15px] border px-3 py-2.5 text-left transition-all active:scale-[0.99]"
          style={{
            background: "linear-gradient(145deg, var(--accent-blue-soft-strong), var(--accent-blue-soft))",
            borderColor: "var(--accent-blue-border)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.055)",
          }}
          title="管理角色设定图库（跨集复用）"
        >
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border text-[14px]"
            style={{
              background: "var(--accent-blue-soft-strong)",
              borderColor: "var(--accent-blue-border-strong)",
            }}
          >
            🧝
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-semibold tracking-[-0.01em] text-(--text-primary)">
              角色库
            </span>
            <span className="mt-0.5 block truncate text-[9px] text-(--text-tertiary)">
              角色设定图跨集复用，同描述只生成一次
            </span>
          </span>
          <span className="text-[10px] text-(--text-tertiary) transition-transform group-hover:translate-x-0.5">
            →
          </span>
        </button>
      )}
      <PreviewPanel review={visualReview} rootPath={projectRootPath} visionModels={visionModels} />
      <AgentPanel agents={agents} isStreaming={isStreaming} className="shrink-0" />
    </aside>
  );
}
