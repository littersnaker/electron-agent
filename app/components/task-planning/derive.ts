// 模块说明：负责 derive 用户界面组件。
import type { AgentLifecycleEventPayload } from "../../types/workspace";
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
  return keys.some((key) => normalized.includes(key.toLocaleLowerCase()));
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

/**
 * 兼容没有 lifecycle 的媒体任务和旧后端。
 *
 * 与旧实现不同，优先使用“当前 active/error 阶段”作为流程光标。
 * 因此 Reviewer 已完成后 Worker 再次 active 时，后续阶段会重新变成 queued，
 * 不会因为历史最远 completed 阶段而继续显示 100%。
 */
function normalizeFallbackStatuses(
  directStatuses: PlanningStageStatus[],
  isStreaming: boolean,
): PlanningStageStatus[] {
  if (!isStreaming) return directStatuses;

  const activeIndex = directStatuses.reduce(
    (latest, status, index) =>
      status === "active" || status === "error" ? index : latest,
    -1,
  );

  if (activeIndex >= 0) {
    return directStatuses.map((status, index) => {
      if (index < activeIndex && status !== "error") return "completed";
      if (index > activeIndex) return "queued";
      return status;
    });
  }

  const furthestCompletedIndex = directStatuses.reduce(
    (latest, status, index) => (status === "completed" ? index : latest),
    -1,
  );

  return directStatuses.map((status, index) => {
    if (furthestCompletedIndex === -1) {
      return index === 0 ? "active" : "queued";
    }
    if (index < furthestCompletedIndex && status !== "error") {
      return "completed";
    }
    if (index > furthestCompletedIndex && status === "idle") {
      return "queued";
    }
    return status;
  });
}

function compareLifecycleEvents(
  left: AgentLifecycleEventPayload,
  right: AgentLifecycleEventPayload,
): number {
  const leftTime = Date.parse(left.createdAt || "");
  const rightTime = Date.parse(right.createdAt || "");
  const timeDiff =
    Number.isNaN(leftTime) || Number.isNaN(rightTime)
      ? 0
      : leftTime - rightTime;

  if (timeDiff !== 0) return timeDiff;
  return (left.sequence || 0) - (right.sequence || 0);
}

function findLifecycleStageIndex(
  definitions: PlanningStageDefinition[],
  event: AgentLifecycleEventPayload,
): number {
  return definitions.findIndex((definition) =>
    definition.lifecycleRoles?.includes(event.role),
  );
}

function lifecycleStatusToPlanningStatus(
  events: AgentLifecycleEventPayload[],
): PlanningStageStatus {
  if (!events.length) return "idle";

  const latestByAgent = new Map<string, AgentLifecycleEventPayload>();
  [...events].sort(compareLifecycleEvents).forEach((event) => {
    latestByAgent.set(event.agentId, event);
  });
  const statuses = Array.from(latestByAgent.values()).map(
    (event) => event.status,
  );

  if (statuses.some((status) => status === "FAILED")) return "error";
  if (
    statuses.some(
      (status) => status !== "COMPLETED" && status !== "FAILED",
    )
  ) {
    return "active";
  }
  return "completed";
}

function buildLifecycleStages(
  definitions: PlanningStageDefinition[],
  activities: ToolActivity[],
  lifecycleEvents: AgentLifecycleEventPayload[],
  isStreaming: boolean,
): PlanningStageView[] | null {
  const mappedEvents = [...lifecycleEvents]
    .filter((event) => findLifecycleStageIndex(definitions, event) >= 0)
    .sort(compareLifecycleEvents);

  if (!mappedEvents.length) return null;

  const latestEvent = mappedEvents[mappedEvents.length - 1];
  const currentStageIndex = findLifecycleStageIndex(definitions, latestEvent);

  return definitions.map((definition, index) => {
    const stageEvents = mappedEvents.filter((event) =>
      definition.lifecycleRoles?.includes(event.role),
    );
    const latestStageEvent = stageEvents[stageEvents.length - 1];
    const iteration = latestStageEvent?.iteration || 0;

    let status: PlanningStageStatus;
    if (index < currentStageIndex) {
      status = "completed";
    } else if (index > currentStageIndex) {
      status = isStreaming ? "queued" : "idle";
    } else {
      const currentIterationEvents = stageEvents.filter(
        (event) => event.iteration === latestEvent.iteration,
      );
      status = lifecycleStatusToPlanningStatus(
        currentIterationEvents.length ? currentIterationEvents : stageEvents,
      );
    }

    const detail =
      index === currentStageIndex && latestStageEvent
        ? `${
            latestStageEvent.iteration > 0
              ? `第 ${latestStageEvent.iteration + 1} 轮返工 · `
              : ""
          }${latestStageEvent.detail}`
        : definition.description;

    return {
      ...definition,
      status,
      progress:
        status === "completed" || status === "error"
          ? 100
          : status === "active"
            ? 58
            : 0,
      detail,
      activityCount: activities.filter((activity) =>
        matchesActivity(activity, definition.activityKeys),
      ).length,
      iteration,
    };
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
 *
 * Code Agent 优先消费后端 AGENT_LIFECYCLE；只有旧后端或媒体任务没有 lifecycle
 * 时才回退到 Agent/Tool 文案推断。
 */
export function buildPlanningStages(
  definitions: PlanningStageDefinition[],
  agents: AgentInstance[],
  activities: ToolActivity[],
  isStreaming: boolean,
  agentStatus?: string,
  lifecycleEvents: AgentLifecycleEventPayload[] = [],
): PlanningStageView[] {
  const lifecycleStages = buildLifecycleStages(
    definitions,
    activities,
    lifecycleEvents,
    isStreaming,
  );
  if (lifecycleStages) return lifecycleStages;

  const directStatuses = definitions.map((definition) =>
    resolveDirectStatus(definition, agents, activities),
  );
  const statuses = normalizeFallbackStatuses(directStatuses, isStreaming);

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
    iteration: 0,
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
