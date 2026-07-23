import { createIdleAgents } from "../component/AgentPanel";
import type { AgentInstance, AgentKind } from "../component/AgentPanel";
import type { Message, WorkspaceProject } from "../const/pageConst";

export const MAX_CONTEXT_MESSAGES = 24;

const AGENT_KIND_ALIASES: Record<string, AgentKind> = {
  orchestrator: "orchestrator",
  coordinator: "orchestrator",
  manager: "orchestrator",
  planner: "planner",
  plan: "planner",
  researcher: "researcher",
  research: "researcher",
  search: "researcher",
  coder: "coder",
  coding: "coder",
  developer: "coder",
  reviewer: "reviewer",
  review: "reviewer",
  tester: "reviewer",
  terminal: "terminal",
  shell: "terminal",
  command: "terminal",
  media: "media",
  image: "media",
  video: "media",
  draw: "media",
};

export function buildWelcomeMessages(
  mode: "qa" | "code",
  project?: WorkspaceProject,
): Message[] {
  return [
    {
      role: "assistant",
      content:
        mode === "code"
          ? `已进入 ${project?.name || "项目"} 的 Code Agent。代码索引可用于快速定位文件、符号和相关实现。`
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

  if (/media|image|video|draw|生图|改图|视频|绘图|海报/.test(normalized)) {
    return "media";
  }

  if (
    /terminal|shell|command|run_terminal|终端|命令|npm|pnpm|yarn|test|build/.test(
      normalized,
    )
  ) {
    return "terminal";
  }

  if (/review|diff|check|lint|verify|审查|检查|验证|测试/.test(normalized)) {
    return "reviewer";
  }

  if (
    /apply|write|edit|change|patch|propose|代码|修改|写入|创建文件/.test(
      normalized,
    )
  ) {
    return "coder";
  }

  if (/search|read|list|index|find|检索|搜索|读取|目录|索引/.test(normalized)) {
    return "researcher";
  }

  if (/plan|analy|task|规划|计划|分析|拆解/.test(normalized)) {
    return "planner";
  }

  return "orchestrator";
}

export function createRunAgents(): AgentInstance[] {
  const now = Date.now();

  return createIdleAgents().map((agent, index) => ({
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
  }));
}
