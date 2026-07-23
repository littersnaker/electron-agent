import type { ToolActivity } from "../AssistantMessageRow";
import type { AgentInstance } from "../AgentPanel";
import type {
  PlanningStageDefinition,
  PlanningStageStatus,
  PlanningStageView,
  PlanningSummary,
} from "./types";

function matchesActivity(activity: ToolActivity, keys: string[]): boolean {
  const normalized = activity.label.toLocaleLowerCase();
  return keys.some((key) =>
    normalized.includes(key.toLocaleLowerCase()),
  );
}

function resolveDirectStatus(
  definition: PlanningStageDefinition,
  agents: AgentInstance[],
  activities: ToolActivity[],
): PlanningStageStatus {
  const relatedAgents = agents.filter((agent) =>
    definition.agentTypes.includes(agent.type),
  );
  const relatedActivities = activities.filter((activity) =>
    matchesActivity(activity, definition.activityKeys),
  );

  if (
    relatedAgents.some((agent) => agent.status === "error") ||
    relatedActivities.some((activity) => activity.status === "error")
  ) {
    return "error";
  }
  if (
    relatedAgents.some((agent) =>
      ["running", "thinking"].includes(agent.status),
    ) ||
    relatedActivities.some((activity) => activity.status === "running")
  ) {
    return "active";
  }
  if (
    relatedAgents.some((agent) => agent.status === "completed") ||
    relatedActivities.some((activity) => activity.status === "completed")
  ) {
    return "completed";
  }
  if (relatedAgents.some((agent) => agent.status === "queued")) {
    return "queued";
  }
  return "idle";
}

function normalizeSequentialStatuses(
  directStatuses: PlanningStageStatus[],
  isStreaming: boolean,
): PlanningStageStatus[] {
  const furthestSignalIndex = directStatuses.reduce(
    (furthest, status, index) =>
      ["active", "completed", "error"].includes(status) ? index : furthest,
    -1,
  );

  return directStatuses.map((status, index) => {
    if (index < furthestSignalIndex && status !== "error") {
      return "completed";
    }
    if (!isStreaming) return status;
    if (furthestSignalIndex === -1) {
      return index === 0 ? "active" : "queued";
    }
    if (index > furthestSignalIndex && status === "idle") {
      return "queued";
    }
    return status;
  });
}

function resolveProgress(
  status: PlanningStageStatus,
  definition: PlanningStageDefinition,
  agents: AgentInstance[],
): number {
  if (status === "completed" || status === "error") return 100;
  if (status === "idle" || status === "queued") return 0;

  const relatedProgress = agents
    .filter((agent) => definition.agentTypes.includes(agent.type))
    .map((agent) => agent.progress)
    .filter((progress) => progress > 0);
  if (!relatedProgress.length) return 52;

  const average =
    relatedProgress.reduce((total, value) => total + value, 0) /
    relatedProgress.length;
  return Math.max(12, Math.min(96, Math.round(average)));
}

function resolveDetail(
  definition: PlanningStageDefinition,
  status: PlanningStageStatus,
  agents: AgentInstance[],
  activities: ToolActivity[],
  agentStatus?: string,
): string {
  const latestActivity = [...activities]
    .filter((activity) => matchesActivity(activity, definition.activityKeys))
    .sort((left, right) => right.startedAt - left.startedAt)[0];
  if (latestActivity) return latestActivity.label;

  const activeTask = agents
    .filter((agent) => definition.agentTypes.includes(agent.type))
    .map((agent) => agent.currentTask?.trim())
    .find((task) => task && !task.startsWith("等待"));
  if (activeTask) return activeTask;
  if (status === "active" && agentStatus?.trim()) return agentStatus.trim();
  return definition.description;
}

/**
 * 根据指定阶段定义派生任务规划视图。
 * 媒体和代码使用不同 definitions，避免右侧面板显示错误流程。
 */
export function buildPlanningStages(
  definitions: PlanningStageDefinition[],
  agents: AgentInstance[],
  activities: ToolActivity[],
  isStreaming: boolean,
  agentStatus?: string,
): PlanningStageView[] {
  const directStatuses = definitions.map((definition) =>
    resolveDirectStatus(definition, agents, activities),
  );
  const statuses = normalizeSequentialStatuses(directStatuses, isStreaming);

  return definitions.map((definition, index) => ({
    ...definition,
    status: statuses[index],
    progress: resolveProgress(statuses[index], definition, agents),
    detail: resolveDetail(
      definition,
      statuses[index],
      agents,
      activities,
      agentStatus,
    ),
    activityCount: activities.filter((activity) =>
      matchesActivity(activity, definition.activityKeys),
    ).length,
  }));
}

export function buildPlanningSummary(
  stages: PlanningStageView[],
): PlanningSummary {
  return {
    active: stages.find((stage) => stage.status === "active"),
    completed: stages.filter((stage) => stage.status === "completed").length,
    failed: stages.some((stage) => stage.status === "error"),
    overallProgress: Math.round(
      stages.reduce((total, stage) => total + stage.progress, 0) /
        Math.max(stages.length, 1),
    ),
  };
}
