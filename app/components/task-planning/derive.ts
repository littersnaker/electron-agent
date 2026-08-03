// 模块说明：负责 derive 用户界面组件。
import type {
  AgentLifecycleEventPayload,
  WorkListSnapshotPayload,
} from "../../types/workspace";
import type { ToolActivity } from "../AssistantMessageRow";
import type { AgentInstance } from "../AgentPanel";
import type {
  PlanningStageDefinition,
  PlanningStageStatus,
  PlanningStageView,
  PlanningSummary,
} from "./types";

function matchesActivity(
  activity: ToolActivity,
  definition: PlanningStageDefinition,
): boolean {
  // Commerce 进度事件携带稳定 stageId 时优先精确匹配，不再依赖中文文案猜测。
  if (
    activity.stageId &&
    definition.activityStageIds?.includes(activity.stageId)
  ) {
    return true;
  }

  // 旧会话、媒体任务和 Code Agent 继续使用兼容性的文案关键字匹配。
  const normalized = activity.label.toLocaleLowerCase();
  return definition.activityKeys.some((key) =>
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
    matchesActivity(activity, definition),
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
  const statuses = Array.from(latestByAgent.values()).map((event) =>
    event.status.toUpperCase(),
  );

  if (statuses.some((status) => ["FAILED", "ERROR"].includes(status))) {
    return "error";
  }
  if (
    statuses.some(
      (status) => !["COMPLETED", "FAILED", "ERROR"].includes(status),
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
        matchesActivity(activity, definition),
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
  if (["completed", "skipped", "error"].includes(status)) return 100;
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
    .filter((activity) => matchesActivity(activity, definition))
    .sort((left, right) => right.startedAt - left.startedAt)[0];
  if (latestActivity) return latestActivity.detail || latestActivity.label;

  const activeTask = agents
    .filter((agent) => definition.agentTypes.includes(agent.type))
    .map((agent) => agent.currentTask?.trim())
    .find((task) => task && !task.startsWith("等待"));
  if (activeTask) return activeTask;
  if (status === "active" && agentStatus?.trim()) return agentStatus.trim();
  return definition.description;
}

/**
 * 判断当前一轮任务是否已经真正结束。
 *
 * 这里不能只看 isStreaming：交互确认弹窗出现时 SSE 已结束，但 Agent 仍处于
 * running 状态，流程并没有完成。只有存在本轮执行痕迹、没有运行中节点且没有
 * 错误时，才把未触发阶段收束为 skipped。
 */
function isSuccessfulTerminalRun(
  agents: AgentInstance[],
  activities: ToolActivity[],
  lifecycleEvents: AgentLifecycleEventPayload[],
  isStreaming: boolean,
): boolean {
  if (isStreaming) return false;

  const hasRunEvidence =
    agents.some((agent) => ["completed", "error"].includes(agent.status)) ||
    activities.length > 0 ||
    lifecycleEvents.length > 0;
  const hasRunningWork =
    agents.some((agent) => ["running", "thinking"].includes(agent.status)) ||
    activities.some((activity) => activity.status === "running");
  const hasFailure =
    agents.some((agent) => agent.status === "error") ||
    activities.some((activity) => activity.status === "error") ||
<<<<<<< HEAD
    lifecycleEvents.some((event) => event.status === "FAILED");
=======
    lifecycleEvents.some((event) =>
      ["FAILED", "ERROR"].includes(event.status.toUpperCase()),
    );
>>>>>>> changePython

  return hasRunEvidence && !hasRunningWork && !hasFailure;
}

/**
 * 成功结束后，把本轮没有触发的可选阶段标记为“已跳过”。
 *
 * 普通问答通常只需要 Orchestrator，不会运行代码修改、工程验证等阶段。旧逻辑
 * 仍把这些阶段保留为 queued/idle，最终只显示 3/8（38%）。使用 skipped 后，
 * 既能保持“这些步骤没有执行”的事实，也能让整轮任务正确收束到 100%。
 */
function finalizeSuccessfulStages(
  stages: PlanningStageView[],
  agents: AgentInstance[],
  activities: ToolActivity[],
  lifecycleEvents: AgentLifecycleEventPayload[],
  isStreaming: boolean,
): PlanningStageView[] {
  if (!isSuccessfulTerminalRun(agents, activities, lifecycleEvents, isStreaming)) {
    return stages;
  }

  return stages.map((stage) => {
    if (stage.status === "completed") return stage;
    return {
      ...stage,
      status: "skipped" as const,
      progress: 100,
      detail: `本轮未触发“${stage.title}”，任务结束时已自动跳过`,
    };
  });
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
  if (lifecycleStages) {
    return finalizeSuccessfulStages(
      lifecycleStages,
      agents,
      activities,
      lifecycleEvents,
      isStreaming,
    );
  }

  const directStatuses = definitions.map((definition) =>
    resolveDirectStatus(definition, agents, activities),
  );
  const statuses = normalizeFallbackStatuses(directStatuses, isStreaming);
  const fallbackStages = definitions.map((definition, index) => ({
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
      matchesActivity(activity, definition),
    ).length,
    iteration: 0,
  }));

  return finalizeSuccessfulStages(
    fallbackStages,
    agents,
    activities,
    lifecycleEvents,
    isStreaming,
  );
}

export function buildPlanningSummary(
  stages: PlanningStageView[],
): PlanningSummary {
  return {
    active: stages.find((stage) => stage.status === "active"),
    completed: stages.filter((stage) =>
      ["completed", "skipped"].includes(stage.status),
    ).length,
    skipped: stages.filter((stage) => stage.status === "skipped").length,
    failed: stages.some((stage) => stage.status === "error"),
    overallProgress: Math.round(
      stages.reduce((total, stage) => total + stage.progress, 0) /
        Math.max(stages.length, 1),
    ),
  };
}
/**
 * 从后端完整 WorkList 快照重新计算真实进度。
 * 不直接信任传入百分比，避免旧后端或乱序 SSE 让右侧进度倒退/虚高。
 */
export function buildWorkListProgress(snapshot: WorkListSnapshotPayload | null) {
  if (!snapshot || snapshot.total <= 0) return null;
  const finished = snapshot.items.filter((item) =>
    ["succeeded", "skipped"].includes(item.status),
  ).length;
  const failed = snapshot.items.filter((item) => item.status === "failed").length;
  const runningItems = snapshot.items.filter((item) => item.status === "running");
  const running = runningItems[0];
  return {
    finished,
    total: snapshot.items.length,
    failed,
    running,
    runningItems,
    activeWorkIds: snapshot.scheduler?.activeWorkIds || runningItems.map((item) => item.id),
    maxParallel: snapshot.scheduler?.maxParallel || 1,
    overallProgress: Math.round(
      (finished / Math.max(snapshot.items.length, 1)) * 100,
    ),
  };
}
