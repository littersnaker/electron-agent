// 模块说明：负责 commerce agent actions 状态管理与业务编排。
"use client";

import { useCallback } from "react";
import { createIdleAgents } from "../../components/AgentPanel";
import type { AgentInstance } from "../../components/AgentPanel";
import type { CommerceProgressEvent } from "../../lib/commerce/types";
import type { CommerceWorkflowMode } from "../../lib/commerce/listing/types";
import type { AgentStateSetter } from "./types";

/** Commerce Agent 的市场研究与 Listing Demo 状态动作。 */
export function useCommerceAgentActions(setAgents: AgentStateSetter) {
  const beginCommerceRun = useCallback((mode: CommerceWorkflowMode = "research") => {
    const now = Date.now();
    setAgents(
      createIdleAgents().map((agent) => {
        const listingMode = mode === "listing";
        const taskByType = {
          orchestrator: listingMode
            ? "编排 Amazon Listing Demo 流程"
            : "编排跨境公开市场研究流程",
          commerce: listingMode ? "理解商品 Brief 与 Listing 目标" : "理解品类与运营目标",
          researcher: listingMode
            ? "等待类目识别后采集 Amazon 竞品样本"
            : "等待检索计划后采集公开 SERP / Shopping 数据",
          reviewer: listingMode
            ? "等待 Listing 生成后检查规则与事实安全"
            : "等待市场指标完成后检查数据限制",
        } as const;
        if (!(agent.type in taskByType)) return agent;
        const isActive = agent.type === "orchestrator" || agent.type === "commerce";
        return {
          ...agent,
          status: isActive
            ? agent.type === "commerce"
              ? ("thinking" as const)
              : ("running" as const)
            : ("queued" as const),
          progress: isActive ? 8 : 0,
          currentTask: taskByType[agent.type as keyof typeof taskByType],
          updatedAt: now,
        };
      }),
    );
  }, [setAgents]);

  const updateCommerceProgress = useCallback(
    (event: CommerceProgressEvent) => {
      const now = Date.now();
      const collecting = event.stage === "collect" || event.stage === "normalize";
      const listingBuilding = ["erp", "keywords", "draft"].includes(event.stage);
      const reviewing = event.stage === "strategy" || event.stage === "validate";
      const finished = event.stage === "done";

      setAgents((current: AgentInstance[]) =>
        current.map((agent: AgentInstance) => {
          if (agent.type === "orchestrator") {
            return {
              ...agent,
              status: finished ? ("completed" as const) : ("running" as const),
              progress: finished ? 100 : Math.max(agent.progress, event.progress - 6),
              currentTask: finished
                ? "跨境市场情报研究已完成"
                : `协调：${event.detail}`,
              updatedAt: now,
            };
          }
          if (agent.type === "commerce") {
            return {
              ...agent,
              status: finished
                ? ("completed" as const)
                : collecting
                  ? ("queued" as const)
                  : ("running" as const),
              progress: finished ? 100 : Math.max(agent.progress, event.progress),
              currentTask: event.detail,
              updatedAt: now,
            };
          }
          if (agent.type === "researcher") {
            if (collecting) {
              return {
                ...agent,
                status: "running" as const,
                progress: Math.max(agent.progress, event.progress),
                currentTask: event.detail,
                updatedAt: now,
              };
            }
            if (
              ["analyze", "strategy", "erp", "keywords", "draft", "validate", "done"].includes(
                event.stage,
              )
            ) {
              return {
                ...agent,
                status: "completed" as const,
                progress: 100,
                currentTask: listingBuilding
                  ? "Amazon 竞品样本已采集，正在生成 Listing"
                  : "Amazon 商品样本已采集并标准化",
                updatedAt: now,
              };
            }
          }
          if (agent.type === "reviewer" && (reviewing || finished)) {
            return {
              ...agent,
              status: finished ? ("completed" as const) : ("running" as const),
              progress: finished ? 100 : Math.max(agent.progress, event.progress - 8),
              currentTask: finished
                ? event.stage === "done"
                  ? "Commerce 结果已完成检查"
                  : "数据口径与风险提示已检查"
                : event.stage === "validate"
                  ? "检查 Listing 规则、关键词覆盖和待确认事实"
                  : "检查估算口径并整理运营建议",
              updatedAt: now,
            };
          }
          return agent;
        }),
      );
    },
    [setAgents],
  );

  const failCommerceRun = useCallback(
    (message: string) => {
      const now = Date.now();
      setAgents((current: AgentInstance[]) =>
        current.map((agent: AgentInstance) => {
          const isPrimary =
            agent.type === "orchestrator" || agent.type === "commerce";
          const isActiveResearcher =
            agent.type === "researcher" &&
            ["running", "thinking"].includes(agent.status);
          if (!isPrimary && !isActiveResearcher) return agent;
          return {
            ...agent,
            status: "error" as const,
            progress: 100,
            currentTask: message,
            updatedAt: now,
          };
        }),
      );
    },
    [setAgents],
  );

  return { beginCommerceRun, updateCommerceProgress, failCommerceRun };
}
