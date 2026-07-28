// 模块说明：负责 general agent actions 状态管理与业务编排。
"use client";

import { useCallback } from "react";
import { createIdleAgents } from "../../components/AgentPanel";
import type {
  AgentInstance,
  AgentKind,
  AgentStatus,
} from "../../components/AgentPanel";
import type {
  AgentEventPayload,
  AgentLifecycleEventPayload,
  InteractiveRequest,
  StreamPacketType,
} from "../../types/workspace";
import { createRunAgents, normalizeAgentKind } from "../../utilities/agent-runtime";
import type { AgentStateSetter } from "./types";

const LIFECYCLE_ROLE_TO_AGENT: Record<string, AgentKind> = {
  router: "orchestrator",
  search_agent: "researcher",
  memory_agent: "researcher",
  file_agent: "researcher",
  context_merge: "orchestrator",
  high_level_planner: "planner",
  task_planner: "planner",
  modify_worker: "coder",
  merge_agent: "orchestrator",
  reviewer_agent: "reviewer",
  reflection_agent: "reviewer",
  memory_consolidation_agent: "orchestrator",
  verification_agent: "terminal",
  final_report_agent: "orchestrator",
};

function lifecycleToAgentStatus(
  status: string,
): { status: AgentStatus; progress: number } {
  const terminalStatus = {
    COMPLETED: { status: "completed", progress: 100 },
    FAILED: { status: "error", progress: 100 },
    CREATED: { status: "queued", progress: 0 },
  } as const;
  if (status in terminalStatus) {
    return terminalStatus[status as keyof typeof terminalStatus];
  }
  if (
    status === "PLANNING" ||
    status === "REVIEWING" ||
    status === "REFLECTING"
  ) {
    return { status: "thinking", progress: 46 };
  }
  if (status === "READY_TO_MERGE") return { status: "running", progress: 88 };
  if (status === "BLOCKED") return { status: "running", progress: 72 };
  return { status: "running", progress: 58 };
}

/** 通用聊天与代码任务相关的 Agent 状态动作。 */
export function useGeneralAgentActions(setAgents: AgentStateSetter) {
  const resetAgents = useCallback(() => setAgents(createIdleAgents()), [setAgents]);
  const beginRun = useCallback(() => setAgents(createRunAgents()), [setAgents]);

  const updateAgent = useCallback(
    (kind: AgentKind, patch: Partial<Omit<AgentInstance, "id" | "type">>) => {
      setAgents((current) =>
        current.map((agent) =>
          agent.type === kind
            ? { ...agent, ...patch, updatedAt: Date.now() }
            : agent,
        ),
      );
    },
    [setAgents],
  );

  const activateAgent = useCallback(
    (kind: AgentKind, task: string) => {
      const now = Date.now();
      setAgents((current) =>
        current.map((agent) => {
          if (agent.type === kind) {
            return {
              ...agent,
              status: "running" as const,
              progress: Math.max(agent.progress, agent.progress >= 90 ? 90 : 24),
              currentTask: task || agent.currentTask,
              updatedAt: now,
            };
          }
          if (
            agent.type !== "orchestrator" &&
            ["running", "thinking"].includes(agent.status)
          ) {
            return {
              ...agent,
              status: "completed" as const,
              progress: 100,
              updatedAt: now,
            };
          }
          if (agent.type === "orchestrator") {
            return {
              ...agent,
              status: "running" as const,
              progress: Math.max(agent.progress, 32),
              currentTask: `协调 ${task || "当前步骤"}`,
              updatedAt: now,
            };
          }
          return agent;
        }),
      );
    },
    [setAgents],
  );

  const applyAgentEvent = useCallback(
    (
      eventType: StreamPacketType | undefined,
      payload?: AgentEventPayload,
      fallbackText = "",
    ) => {
      if (!payload && !fallbackText) return;
      const kind = normalizeAgentKind(payload?.type || payload?.id);
      const task = payload?.currentTask || payload?.task || fallbackText;
      const status: AgentStatus =
        payload?.status ||
        (eventType === "AGENT_FINISH"
          ? "completed"
          : eventType === "AGENT_ERROR"
            ? "error"
            : eventType === "AGENT_START"
              ? "running"
              : "thinking");
      const progress = Math.max(
        0,
        Math.min(
          100,
          payload?.progress ??
            (status === "completed" || status === "error" ? 100 : 48),
        ),
      );
      setAgents((current) =>
        current.map((agent) =>
          agent.id === payload?.id || agent.type === kind
            ? {
                ...agent,
                name: payload?.name || agent.name,
                status,
                progress,
                currentTask: task || agent.currentTask,
                updatedAt: Date.now(),
              }
            : agent,
        ),
      );
    },
    [setAgents],
  );

  const applyLifecycleEvent = useCallback(
    (event: AgentLifecycleEventPayload) => {
      const kind = LIFECYCLE_ROLE_TO_AGENT[event.role] || "orchestrator";
      const mapped = lifecycleToAgentStatus(event.status);
      const retryRound = event.iteration > 0 ? event.iteration + 1 : 0;
      const taskPrefix = retryRound > 0 ? `第 ${retryRound} 轮返工 · ` : "";
      const now = Date.now();

      setAgents((current) =>
        current.map((agent) => {
          const shouldResetReview =
            event.iteration > 0 &&
            ["coder", "orchestrator"].includes(kind) &&
            (agent.type === "terminal" || agent.type === "reviewer");
          if (shouldResetReview) {
            return {
              ...agent,
              status: "queued" as const,
              progress: 0,
              currentTask:
                agent.type === "terminal"
                  ? "等待返工合并后重新验证"
                  : "等待返工验证完成后重新审查",
              updatedAt: now,
            };
          }
          if (agent.type === kind) {
            const isActive =
              mapped.status === "running" || mapped.status === "thinking";
            return {
              ...agent,
              status: mapped.status,
              progress: isActive
                ? Math.max(agent.progress > 95 ? 0 : agent.progress, mapped.progress)
                : mapped.progress,
              currentTask: `${taskPrefix}${event.detail}`,
              updatedAt: now,
            };
          }
          if (agent.type === "orchestrator" && kind !== "orchestrator") {
            return {
              ...agent,
              status: "running" as const,
              progress: Math.max(agent.progress, 32),
              currentTask: `协调 ${taskPrefix}${event.detail}`,
              updatedAt: now,
            };
          }
          return agent;
        }),
      );
    },
    [setAgents],
  );

  const markFinalResponse = useCallback(() => {
    const now = Date.now();
    setAgents((current) =>
      current.map((agent) => {
        if (agent.type === "orchestrator") {
          return {
            ...agent,
            status: "running" as const,
            progress: Math.max(agent.progress, 88),
            currentTask: "汇总已执行步骤并生成最终回答",
            updatedAt: now,
          };
        }
        return ["running", "thinking"].includes(agent.status)
          ? { ...agent, status: "completed" as const, progress: 100, updatedAt: now }
          : agent;
      }),
    );
  }, [setAgents]);

  const failRunningAgents = useCallback(() => {
    const now = Date.now();
    setAgents((current) =>
      current.map((agent) =>
        ["running", "thinking"].includes(agent.status)
          ? {
              ...agent,
              status: "error" as const,
              progress: 100,
              currentTask: "当前 Agent 执行失败",
              updatedAt: now,
            }
          : agent,
      ),
    );
  }, [setAgents]);

  const finalizeAgents = useCallback(
    (interactiveRequest: InteractiveRequest | null) => {
      const now = Date.now();
      setAgents((current) =>
        current.map((agent) => {
          if (agent.status === "error") return agent;
          if (
            interactiveRequest?.source === "file_create_confirmation" &&
            agent.type === "orchestrator"
          ) {
            return {
              ...agent,
              status: "running" as const,
              progress: Math.max(agent.progress, 38),
              currentTask: "等待确认是否新建缺失文件",
              updatedAt: now,
            };
          }
          if (
            interactiveRequest &&
            interactiveRequest.source !== "file_create_confirmation" &&
            agent.type === "terminal"
          ) {
            return {
              ...agent,
              status: "running" as const,
              progress: Math.max(agent.progress, 72),
              currentTask: "等待用户输入后继续执行",
              updatedAt: now,
            };
          }
          if (agent.type === "orchestrator") {
            return {
              ...agent,
              status: "completed" as const,
              progress: 100,
              currentTask: "本轮协作已完成",
              updatedAt: now,
            };
          }
          return ["running", "thinking"].includes(agent.status)
            ? { ...agent, status: "completed" as const, progress: 100, updatedAt: now }
            : agent;
        }),
      );
    },
    [setAgents],
  );

  return {
    resetAgents,
    beginRun,
    updateAgent,
    activateAgent,
    applyAgentEvent,
    applyLifecycleEvent,
    markFinalResponse,
    failRunningAgents,
    finalizeAgents,
  };
}
