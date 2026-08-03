// 模块说明：提供 agent runtime 通用工具能力。
import { createIdleAgents } from "../components/AgentPanel";
import type { AgentInstance, AgentKind } from "../components/AgentPanel";
import type { Message, SessionMode, WorkspaceProject } from "../constants/page-constants";
import agentRoutingConfig from "../../config/agent-routing.json";

export const MAX_CONTEXT_MESSAGES = 24;

const AGENT_KIND_ALIASES = agentRoutingConfig.aliases as Record<
  string,
  AgentKind
>;
const AGENT_INTENTS = agentRoutingConfig.intents as Array<{
  agent: AgentKind;
  keywords: string[];
}>;

export function buildWelcomeMessages(
  mode: SessionMode,
  project?: WorkspaceProject,
): Message[] {
  return [
    {
      role: "assistant",
      content:
        mode === "code"
          ? `已进入 ${project?.name || "项目"} 的 Code Agent。可选择建议、自动编辑或全自动模式；自动模式会持续读取、修改并验证项目，而不是只生成步骤文档。`
          : mode === "commerce"
            ? "已进入 Cross-border Market Intelligence Agent。告诉我一个大概品类或市场问题，我会用公开 SERP / Shopping 做核心研究，并把 Amazon、Keepa 等平台数据作为可选增强。"
            : mode === "media"
              ? "已进入 AI 漫剧工作室。输入剧本或剧情梗概，我会拆分成镜并等待你确认，然后并行出图、图生视频并合并成集。"
            : "你好，我是独立的问答 Agent。你可以直接问我任何问题。",
    },
  ];
}

export function normalizeAgentKind(value?: string): AgentKind {
  const normalized = (value || "").toLowerCase().replace(/[^a-z]/g, "");
  return AGENT_KIND_ALIASES[normalized] || "orchestrator";
}

export function inferAgentKind(text: string): AgentKind {
  const normalized = text.toLowerCase();

  for (const intent of AGENT_INTENTS) {
    if (
      intent.keywords.some((keyword) =>
        normalized.includes(keyword.toLowerCase()),
      )
    ) {
      return intent.agent;
    }
  }

  return "orchestrator";
}

export function createRunAgents(): AgentInstance[] {
  const now = Date.now();

  return createIdleAgents().map((agent, index) => {
    // Media / Commerce 有独立工作流，普通 QA / Code 运行时保持空闲，避免误显示为等待角色。
    if (agent.type === "media" || agent.type === "commerce") {
      return { ...agent, updatedAt: now };
    }

    return {
      ...agent,
      status: agent.type === "orchestrator" ? "running" : "queued",
      progress: agent.type === "orchestrator" ? 8 : 0,
      currentTask:
        agent.type === "orchestrator"
          ? "分析请求并编排协作流程"
          : index === 1
            ? "等待 Orchestrator 分配规划任务"
            : "等待上游 Agent 完成",
      updatedAt: now,
    };
  });
}
