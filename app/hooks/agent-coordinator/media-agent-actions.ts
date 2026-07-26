// 模块说明：负责 media agent actions 状态管理与业务编排。
"use client";

import { useCallback } from "react";
import { createIdleAgents } from "../../components/AgentPanel";
import type { AgentStateSetter } from "./types";

/** 媒体生成任务相关的 Agent 状态动作。 */
export function useMediaAgentActions(setAgents: AgentStateSetter) {
  const beginMediaRun = useCallback(
    (taskName: string) => {
      const now = Date.now();
      setAgents(
        createIdleAgents().map((agent) => {
          if (agent.type === "orchestrator") {
            return {
              ...agent,
              status: "running" as const,
              progress: 12,
              currentTask: `识别并编排${taskName}`,
              updatedAt: now,
            };
          }
          if (agent.type === "media") {
            return {
              ...agent,
              status: "running" as const,
              progress: 8,
              currentTask: `准备${taskName}模型请求`,
              updatedAt: now,
            };
          }
          if (agent.type === "reviewer") {
            return {
              ...agent,
              status: "queued" as const,
              progress: 0,
              currentTask: "等待生成结果后进行检查",
              updatedAt: now,
            };
          }
          return agent;
        }),
      );
    },
    [setAgents],
  );

  const updateMediaProgress = useCallback(
    (progress: number, task: string) => {
      const safeProgress = Math.max(8, Math.min(90, Math.round(progress)));
      const now = Date.now();
      setAgents((current) =>
        current.map((agent) => {
          if (agent.type === "orchestrator") {
            return {
              ...agent,
              status: "running" as const,
              progress: Math.min(88, Math.max(agent.progress, safeProgress - 8)),
              currentTask: "协调媒体模型并等待结果返回",
              updatedAt: now,
            };
          }
          if (agent.type === "media") {
            const completed = safeProgress >= 78;
            return {
              ...agent,
              status: completed ? ("completed" as const) : ("running" as const),
              progress: completed ? 100 : Math.max(agent.progress, safeProgress),
              currentTask: completed
                ? "媒体内容已生成，正在交给 Reviewer 检查"
                : task,
              updatedAt: now,
            };
          }
          if (agent.type === "reviewer" && safeProgress >= 78) {
            return {
              ...agent,
              status: "running" as const,
              progress: Math.max(agent.progress, Math.min(86, safeProgress - 8)),
              currentTask: task.includes("检查")
                ? task
                : "正在检查重影、重复元素和无关改动",
              updatedAt: now,
            };
          }
          return agent;
        }),
      );
    },
    [setAgents],
  );

  const completeMediaRun = useCallback(
    (reviewTask: string) => {
      const now = Date.now();
      setAgents((current) =>
        current.map((agent) => {
          if (agent.type === "orchestrator") {
            return {
              ...agent,
              status: "completed" as const,
              progress: 100,
              currentTask: "媒体任务编排完成",
              updatedAt: now,
            };
          }
          if (agent.type === "media") {
            return {
              ...agent,
              status: "completed" as const,
              progress: 100,
              currentTask: "媒体文件已生成并保存",
              updatedAt: now,
            };
          }
          if (agent.type === "reviewer") {
            return {
              ...agent,
              status: "completed" as const,
              progress: 100,
              currentTask: reviewTask,
              updatedAt: now,
            };
          }
          return agent;
        }),
      );
    },
    [setAgents],
  );

  const failMediaRun = useCallback(
    (message: string) => {
      const now = Date.now();
      setAgents((current) =>
        current.map((agent) =>
          agent.type === "orchestrator" || agent.type === "media"
            ? {
                ...agent,
                status: "error" as const,
                progress: 100,
                currentTask: message,
                updatedAt: now,
              }
            : agent,
        ),
      );
    },
    [setAgents],
  );

  return {
    beginMediaRun,
    updateMediaProgress,
    completeMediaRun,
    failMediaRun,
  };
}
