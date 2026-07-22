import type { ToolActivity } from "../AssistantMessageRow";
import type { AgentInstance, AgentKind } from "../AgentPanel";

export type PlanningStageStatus =
  | "idle"
  | "queued"
  | "active"
  | "completed"
  | "error";

export interface TaskPlanningPanelProps {
  agents: AgentInstance[];
  toolActivities?: ToolActivity[];
  agentStatus?: string;
  isStreaming: boolean;
  className?: string;
}

export interface PlanningStageDefinition {
  id: string;
  title: string;
  description: string;
  agentTypes: AgentKind[];
  activityKeys: string[];
}

export interface PlanningStageView extends PlanningStageDefinition {
  status: PlanningStageStatus;
  progress: number;
  detail: string;
  activityCount: number;
}

export interface PlanningSummary {
  active: PlanningStageView | undefined;
  completed: number;
  failed: boolean;
  overallProgress: number;
}
