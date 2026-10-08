// 模块说明：保存每轮工作的现有事件快照，并从快照派生聊天时间线。
import type { Message } from "../constants/page-constants";
import type {
  AgentLifecycleEventPayload,
  StreamPacket,
  ToolActivity,
  WorkListSnapshotPayload,
} from "../types/workspace";
import type { CommerceProgressEvent } from "./commerce/types";
import { CODE_STAGE_DEFINITIONS } from "../components/task-planning/config";
import { resolveToolMeta } from "../components/assistant-message-row/tool-activity-panel";
import { getCommerceProgressTitle } from "./commerce/progress-stages";

export type WorkflowStatus =
  "running" | "completed" | "failed" | "stopped" | "waiting" | "interrupted";
export type WorkflowStepStatus =
  "running" | "completed" | "error" | "stopped" | "waiting" | "interrupted" | "skipped";
export interface MessageWorkflow {
  id: string;
  mode: string;
  status: WorkflowStatus;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  detail: string;
  toolActivities: ToolActivity[];
  lifecycleEvents: AgentLifecycleEventPayload[];
  workListSnapshot?: WorkListSnapshotPayload;
}
export interface WorkflowStep extends Omit<ToolActivity, "status"> {
  status: WorkflowStepStatus;
  files?: string[];
  iteration?: number;
  toolName?: string;
}

/** 恢复同一轮工作时保留旧事件；新工作使用独立 ID。 */
export function createWorkflow(
  mode: string,
  previous?: MessageWorkflow,
  now = Date.now(),
): MessageWorkflow {
  return {
    id: previous?.id ?? crypto.randomUUID(),
    mode,
    status: "running",
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    detail: "",
    toolActivities: previous?.toolActivities ?? [],
    lifecycleEvents: previous?.lifecycleEvents ?? [],
    workListSnapshot: previous?.workListSnapshot,
  };
}

/** 更新对应消息，保留正文、附件和之后追加的 Review 卡片。 */
export function updateWorkflowMessage(
  messages: Message[],
  workflow: MessageWorkflow,
  patch: Partial<Message> = {},
): Message[] {
  return messages.map((message) =>
    message.workflow?.id === workflow.id ? { ...message, ...patch, workflow } : message,
  );
}

/** 顺序型工具/电商阶段开始下一步时结束前一步；同阶段重复更新不加行。 */
function updateActivity(
  workflow: MessageWorkflow,
  label: string,
  detail: string,
  key: string,
  now: number,
): MessageWorkflow {
  const last = workflow.toolActivities.at(-1);
  const activities = workflow.toolActivities.map((activity) =>
    activity.status === "running"
      ? { ...activity, status: "completed" as const, endedAt: now }
      : activity,
  );
  if (last?.status === "running" && (last.stageId ?? last.label) === key) {
    activities[activities.length - 1] = { ...last, label, detail };
  } else {
    activities.push({
      id: `${workflow.id}:${now}:${activities.length}`,
      label,
      detail,
      stageId: key,
      status: "running",
      startedAt: now,
    });
  }
  return { ...workflow, updatedAt: now, detail, toolActivities: activities };
}

/** 消费现有 SSE 事件；正文、内部推理和无工作事件的 QA 不进入时间线。 */
export function recordWorkflowPacket(
  workflow: MessageWorkflow,
  packet: StreamPacket,
  now = Date.now(),
): MessageWorkflow {
  const payload = packet.payload;
  if (
    packet.type === "STATUS" &&
    payload &&
    "stage" in payload &&
    "detail" in payload &&
    workflow.mode === "image"
  ) {
    const stage = String(payload.stage);
    const detail = String(payload.detail);
    if (stage === "error") return { ...workflow, updatedAt: now, status: "failed", detail };
    if (stage === "done") return { ...workflow, updatedAt: now, detail };
    return updateActivity(workflow, detail, detail, stage, now);
  }
  if (packet.type === "TOOL_STATUS" && typeof packet.content === "string") {
    const label = packet.content.trim();
    return label ? updateActivity(workflow, label, label, label, now) : workflow;
  }
  if (packet.type === "AGENT_LIFECYCLE" && payload && "agentId" in payload && "role" in payload) {
    const event = payload as AgentLifecycleEventPayload;
    if (workflow.lifecycleEvents.some((item) => item.id === event.id)) return workflow;
    const status = event.status.toUpperCase();
    return {
      ...workflow,
      updatedAt: now,
      detail: event.detail,
      status: ["CANCELED", "CANCELLED", "STOPPED"].includes(status)
        ? "stopped"
        : ["FAILED", "ERROR"].includes(status)
          ? "failed"
          : status.includes("WAIT") || ["BLOCKED", "PAUSED"].includes(status)
            ? "waiting"
            : "running",
      lifecycleEvents: [...workflow.lifecycleEvents, event],
    };
  }
  if (packet.type === "WORKLIST_UPDATE" && payload && "items" in payload) {
    const snapshot = payload as WorkListSnapshotPayload;
    return {
      ...workflow,
      updatedAt: now,
      workListSnapshot: snapshot,
      detail:
        snapshot.items.find((item) => item.status === "running")?.title ||
        workflow.detail ||
        "工作清单已更新",
    };
  }
  if (packet.type === "COMMERCE_PROGRESS" && payload && "stage" in payload && "detail" in payload) {
    const event = payload as CommerceProgressEvent;
    if (event.stage === "done") return { ...workflow, updatedAt: now, detail: event.detail };
    const mode = workflow.mode === "commerce-listing" ? "listing" : "research";
    return updateActivity(
      { ...workflow, status: "running" },
      getCommerceProgressTitle(mode, event.stage),
      event.detail,
      event.stage,
      now,
    );
  }
  if (packet.type === "INTERACTIVE_REQUEST" && payload && "prompt" in payload) {
    return {
      ...workflow,
      status: "waiting",
      updatedAt: now,
      detail: payload.prompt || "等待确认后继续",
    };
  }
  if (packet.type === "AGENT_ERROR") {
    return {
      ...workflow,
      status: "failed",
      updatedAt: now,
      detail:
        packet.agent?.currentTask ||
        packet.agent?.task ||
        (typeof packet.content === "string" ? packet.content : "执行失败"),
    };
  }
  if (packet.type === "STATUS" && typeof packet.content === "string" && workflow.mode !== "qa") {
    // 有生命周期事件时避免把同一阶段再次作为状态行重复展示。
    return workflow.lifecycleEvents.length
      ? { ...workflow, updatedAt: now, detail: packet.content }
      : updateActivity(workflow, packet.content, packet.content, packet.content, now);
  }
  if (packet.type?.startsWith("AGENT_") && packet.agent && !workflow.lifecycleEvents.length) {
    const agent = packet.agent;
    const label =
      agent.currentTask || agent.task || (typeof packet.content === "string" ? packet.content : "");
    if (label)
      return updateActivity(
        workflow,
        agent.name || label,
        label,
        agent.id || agent.name || label,
        now,
      );
  }
  return workflow;
}

/** 只在成功结束时补齐运行步骤；中断、失败与等待保留不同状态。 */
export function finishWorkflow(
  workflow: MessageWorkflow,
  status: WorkflowStatus,
  detail = "",
  now = Date.now(),
): MessageWorkflow {
  const failed =
    workflow.status === "failed" ||
    workflow.workListSnapshot?.items.some((item) => item.status === "failed");
  const finalStatus =
    status === "completed" && failed
      ? "failed"
      : status === "completed" && ["waiting", "stopped", "interrupted"].includes(workflow.status)
        ? workflow.status
        : status;
  return {
    ...workflow,
    status: finalStatus,
    detail: detail || workflow.detail,
    updatedAt: now,
    endedAt: now,
    toolActivities: workflow.toolActivities.map((activity) =>
      activity.status === "running" && ["completed", "failed"].includes(finalStatus)
        ? { ...activity, status: finalStatus === "failed" ? "error" : "completed", endedAt: now }
        : activity,
    ),
  };
}

/** 历史快照没有活跃请求时显示中断，避免重启后无限转圈。 */
export function workflowDisplayStatus(workflow: MessageWorkflow, isLive: boolean): WorkflowStatus {
  return workflow.status === "running" && !isLive ? "interrupted" : workflow.status;
}

/** 用现有阶段名解释角色；媒体事件按实际动作保留，代码阶段合并重复进度。 */
export function deriveWorkflowSteps(workflow: MessageWorkflow, isLive = false): WorkflowStep[] {
  const steps: WorkflowStep[] = workflow.toolActivities.map((activity) => ({
    ...activity,
    label: resolveToolMeta(activity.label).title,
  }));
  for (const event of workflow.lifecycleEvents) {
    const key = `${event.agentId}:${event.role}:${event.iteration}:${event.toolName ?? ""}`;
    const isMedia = event.role === "media_agent";
    // ponytail: 线性扫描适合本地任务，超长轨迹再增加阶段索引。
    const index = steps.map((step) => step.stageId).lastIndexOf(key);
    const last = isMedia ? steps.at(-1) : steps[index];
    const sameStage =
      last?.stageId === key &&
      (isMedia
        ? last.detail === event.detail
        : last.status === "running" || event.status.toUpperCase() !== "RUNNING");
    const status = event.status.toUpperCase();
    const stepStatus: WorkflowStepStatus = ["CANCELED", "CANCELLED", "STOPPED"].includes(status)
      ? "stopped"
      : ["FAILED", "ERROR"].includes(status)
        ? "error"
        : status.includes("WAIT") || ["BLOCKED", "PAUSED"].includes(status)
          ? "waiting"
          : status === "SKIPPED"
            ? "skipped"
            : ["COMPLETED", "SUCCEEDED", "DONE"].includes(status)
              ? "completed"
              : "running";
    const title = CODE_STAGE_DEFINITIONS.find((stage) =>
      stage.lifecycleRoles?.includes(event.role),
    )?.title;
    const timestamp = Date.parse(event.createdAt) || workflow.updatedAt;
    const step: WorkflowStep = {
      id: event.id,
      label: event.toolName
        ? resolveToolMeta(event.toolName).title
        : title || event.detail || event.role,
      detail: event.detail,
      stageId: key,
      status: stepStatus,
      startedAt: timestamp,
      endedAt: stepStatus === "running" ? undefined : timestamp,
      files: event.currentFiles,
      iteration: event.iteration,
      toolName: event.toolName,
    };
    if (sameStage && last) {
      steps[isMedia ? steps.length - 1 : index] = {
        ...step,
        id: last.id,
        startedAt: last.startedAt,
        files: [...new Set([...(last.files ?? []), ...(event.currentFiles ?? [])])],
      };
    } else {
      // 媒体节点是顺序动作，同一 Agent 下一动作到达即结束前一动作；并行镜头不推断完成。
      if (
        isMedia &&
        last?.status === "running" &&
        last.stageId === key &&
        !/分镜\s*\d/.test(last.detail || "")
      ) {
        steps[steps.length - 1] = { ...last, status: "completed", endedAt: timestamp };
      }
      steps.push(step);
    }
  }
  const status = workflowDisplayStatus(workflow, isLive);
  return steps
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((step) =>
      step.status === "running" && status !== "running"
        ? {
            ...step,
            status: status === "failed" ? "error" : status,
            endedAt: workflow.endedAt ?? workflow.updatedAt,
          }
        : step,
    );
}

/** 合并一秒内的消息快照并串行保存，最终保存不会被较旧请求覆盖。 */
export function createWorkflowSaver(save: (messages: Message[]) => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Message[] | undefined;
  let chain = Promise.resolve();
  const enqueue = (messages: Message[]) => {
    const request = chain.then(() => save(messages));
    chain = request.catch((error) => console.warn("[Workflow] 会话保存失败", error));
    return request;
  };
  return {
    schedule(messages: Message[]) {
      pending = messages;
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        const latest = pending;
        pending = undefined;
        if (latest) void enqueue(latest).catch(() => {});
      }, 1000);
    },
    flush(messages: Message[]) {
      clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      return enqueue(messages);
    },
  };
}
