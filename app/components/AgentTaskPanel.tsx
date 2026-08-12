"use client";
/**
 * 工作台右侧信息面板：任务规划 + Agent 状态。
 *
 * 从 page.tsx 抽离的独立面板，保持页面入口文件在 500 行以内；
 * 所有数据均由 props 传入，不持有业务状态。
 */
import type {
  AgentLifecycleEventPayload,
  WorkListSnapshotPayload,
} from "../types/workspace";
import AgentPanel, { type AgentInstance } from "./AgentPanel";
import type { ToolActivity } from "./AssistantMessageRow";
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
}

/** 右侧固定面板：任务规划进度 + Agent 状态卡。 */
export default function AgentTaskPanel({
  agents,
  toolActivities,
  lifecycleEvents,
  workListSnapshot,
  agentStatus,
  isStreaming,
  workflowMode,
}: AgentTaskPanelProps) {
  return (
    <aside className="hidden min-h-0 w-[360px] shrink-0 flex-col gap-4 xl:flex">
      <TaskPlanningPanel
        agents={agents}
        toolActivities={toolActivities}
        lifecycleEvents={lifecycleEvents}
        workListSnapshot={workListSnapshot}
        agentStatus={agentStatus}
        isStreaming={isStreaming}
        workflowMode={workflowMode}
      />
      <AgentPanel
        agents={agents}
        isStreaming={isStreaming}
        className="min-h-0 flex-1"
      />
    </aside>
  );
}
