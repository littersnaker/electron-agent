"use client";

import { useCallback, useMemo, useState } from "react";
import { createIdleAgents } from "../component/AgentPanel";
import type {
  AgentInstance,
  AgentKind,
  AgentStatus,
} from "../component/AgentPanel";
import type {
  AgentEventPayload,
  InteractiveRequest,
  StreamPacketType,
} from "../types/workspace";
import { createRunAgents, normalizeAgentKind } from "../utils/agentRuntime";

export function useAgentCoordinator() {
  const [agents, setAgents] = useState<AgentInstance[]>(() => createIdleAgents());

  const runningAgentCount = useMemo(
    () =>
      agents.filter((agent) =>
        ["running", "thinking"].includes(agent.status),
      ).length,
    [agents],
  );

  const resetAgents = useCallback(() => {
    setAgents(createIdleAgents());
  }, []);

  const beginRun = useCallback(() => {
    setAgents(createRunAgents());
  }, []);

  const updateAgent = useCallback(
    (
      kind: AgentKind,
      patch: Partial<Omit<AgentInstance, "id" | "type">>,
    ) => {
      setAgents((current) =>
        current.map((agent) =>
          agent.type === kind
            ? { ...agent, ...patch, updatedAt: Date.now() }
            : agent,
        ),
      );
    },
    [],
  );

  const activateAgent = useCallback((kind: AgentKind, task: string) => {
    setAgents((current) =>
      current.map((agent) => {
        if (agent.type === kind) {
          return {
            ...agent,
            status: "running" as const,
            progress: Math.max(agent.progress, agent.progress >= 90 ? 90 : 24),
            currentTask: task || agent.currentTask,
            updatedAt: Date.now(),
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
            updatedAt: Date.now(),
          };
        }

        if (agent.type === "orchestrator") {
          return {
            ...agent,
            status: "running" as const,
            progress: Math.max(agent.progress, 32),
            currentTask: `协调 ${task || "当前步骤"}`,
            updatedAt: Date.now(),
          };
        }

        return agent;
      }),
    );
  }, []);

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
    [],
  );

  /**
   * 模型开始输出最终答案时，只结束已经实际运行过的子 Agent。
   *
   * `createRunAgents()` 会把尚未启动的阶段标记为 queued。旧实现会把
   * queued 一并改成 completed，导致工作区查询或只读查询看起来像执行了
   * Planner、Worker、终端和审查。这里保留未参与阶段的原状态。
   */
  const markFinalResponse = useCallback(() => {
    setAgents((current) =>
      current.map((agent) => {
        if (agent.type === "orchestrator") {
          return {
            ...agent,
            status: "running" as const,
            progress: Math.max(agent.progress, 88),
            currentTask: "汇总已执行步骤并生成最终回答",
            updatedAt: Date.now(),
          };
        }

        if (["running", "thinking"].includes(agent.status)) {
          return {
            ...agent,
            status: "completed" as const,
            progress: 100,
            updatedAt: Date.now(),
          };
        }

        return agent;
      }),
    );
  }, []);

  const failRunningAgents = useCallback(() => {
    setAgents((current) =>
      current.map((agent) =>
        ["running", "thinking"].includes(agent.status)
          ? {
              ...agent,
              status: "error" as const,
              progress: 100,
              currentTask: "当前 Agent 执行失败",
              updatedAt: Date.now(),
            }
          : agent,
      ),
    );
  }, []);

  /**
   * 一轮流式请求结束后收束 Agent 状态。
   *
   * - 报错 Agent 保留 error；
   * - 终端交互存在时，终端继续保持运行；
   * - Orchestrator 总是完成本轮协调；
   * - 只有 running / thinking 的 Agent 才会转为 completed；
   * - idle / queued Agent 没有参与本轮流程，因此保持原状态。
   */
  const finalizeAgents = useCallback(
    (interactiveRequest: InteractiveRequest | null) => {
      setAgents((current) =>
        current.map((agent) => {
          if (agent.status === "error") return agent;

          if (interactiveRequest && agent.type === "terminal") {
            return {
              ...agent,
              status: "running" as const,
              progress: Math.max(agent.progress, 72),
              currentTask: "等待用户输入后继续执行",
              updatedAt: Date.now(),
            };
          }

          if (agent.type === "orchestrator") {
            return {
              ...agent,
              status: "completed" as const,
              progress: 100,
              currentTask: "本轮协作已完成",
              updatedAt: Date.now(),
            };
          }

          if (["running", "thinking"].includes(agent.status)) {
            return {
              ...agent,
              status: "completed" as const,
              progress: 100,
              updatedAt: Date.now(),
            };
          }

          return agent;
        }),
      );
    },
    [],
  );

  return {
    agents,
    runningAgentCount,
    resetAgents,
    beginRun,
    updateAgent,
    activateAgent,
    applyAgentEvent,
    markFinalResponse,
    failRunningAgents,
    finalizeAgents,
  };
}

export type AgentCoordinator = ReturnType<typeof useAgentCoordinator>;
