import type { ComposerMode } from "../../const/pageConst";
import type { AgentLifecycleEventPayload } from "../../types/workspace";
import type { ToolActivity } from "../AssistantMessageRow";
import type { AgentInstance, AgentKind } from "../AgentPanel";

export type PlanningStageStatus =
  | "idle"
  | "queued"
  | "active"
  | "completed"
  | "error";

export type TaskPlanningWorkflowMode = ComposerMode | "commerce";

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
  completed: number;
  failed: boolean;
  overallProgress: number;
}
