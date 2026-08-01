// 模块说明：负责 types 用户界面组件。
import type { ComposerMode } from "../../constants/page-constants";
import type { CommerceWorkflowMode } from "../../lib/commerce/listing/types";
import type { AgentLifecycleEventPayload } from "../../types/workspace";
import type { ToolActivity } from "../AssistantMessageRow";
import type { AgentInstance, AgentKind } from "../AgentPanel";

export type PlanningStageStatus =
  | "idle"
  | "queued"
  | "active"
  | "completed"
  | "skipped"
  | "error";

export type TaskPlanningWorkflowMode =
  | ComposerMode
  | `commerce-${CommerceWorkflowMode}`;

export interface TaskPlanningPanelProps {
  agents: AgentInstance[];
  toolActivities?: ToolActivity[];
  lifecycleEvents?: AgentLifecycleEventPayload[];
  agentStatus?: string;
  isStreaming: boolean;
  workflowMode: TaskPlanningWorkflowMode;
  className?: string;
}

export interface PlanningStageDefinition {
  id: string;
  title: string;
  description: string;
  agentTypes: AgentKind[];
  activityKeys: string[];
  /** Commerce 等无 lifecycle 工作流使用的稳定阶段 ID。 */
  activityStageIds?: string[];
  /** 后端真实 lifecycle role；媒体阶段可留空并继续走旧的前端派生逻辑。 */
  lifecycleRoles?: string[];
}

export interface PlanningStageView extends PlanningStageDefinition {
  status: PlanningStageStatus;
  progress: number;
  detail: string;
  activityCount: number;
  iteration: number;
}

export interface PlanningSummary {
  active: PlanningStageView | undefined;
  /** 已完成和已跳过阶段的总数，用于表示本轮流程是否已经收束。 */
  completed: number;
  /** 本轮未触发、但在任务结束时明确收束的阶段数。 */
  skipped: number;
  failed: boolean;
  overallProgress: number;
}
