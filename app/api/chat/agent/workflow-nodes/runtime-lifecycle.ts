/**
 * 模块职责：工作流运行时类型、生命周期跟踪与基础内容处理。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */

import type { BaseMessage, ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { LlmChatResponse } from "@/app/lib/llm/types";
import type { AgentState, ModifyWorkerState } from "../state";
import type { AgentLifecycleEvent, AgentLifecycleSnapshot, AgentLifecycleStatus, AgentRole, CommandExecutionMode, InteractiveRequest, InteractiveResponseMode, WorkerFileChange } from "../types";
import { recordAgentTraceEvent } from "@/app/lib/agent-runtime/trace-store";
import { CliPromptText } from "../../prompt";
import { invokeLlm } from "./terminal-and-memory";
/*
 * 这是整套多 Agent 工作流的“行为实现文件”。
 *
 * 如果说：
 * - `types.ts` 是数据词典，
 * - `state.ts` 是全局白板，
 * - `graph.ts` 是节点布线图，
 * 那这里就是“每个节点到底干了什么”。
 *
 * 阅读建议：
 * 1. 先看基础工具函数，理解数据怎么被清洗、解析、格式化；
 * 2. 再看 Planner 校验相关函数，理解为什么要多一层 schema / 唯一性防线；
 * 3. 再看 Modify / Reviewer / Lint / Final Report 这几段主流程。
 */
// Planner 最多拆出 6 个独立任务，通过 Send 动态并发执行。
export const MAX_PARALLEL_MODIFIERS = 6;

export const MAX_HIGH_LEVEL_ITEMS = 4;

export const MAX_PLANNER_RETRIES = 2;

export const MAX_REVIEW_RETRIES = 2;

export const MAX_WORKER_TOOL_ROUNDS = 10;

/** simple_edit 只允许少量工具往返，避免单文档任务反复压缩上下文。 */
export const MAX_SIMPLE_WORKER_TOOL_ROUNDS = 5;

export const WORKER_MEMORY_COMPRESS_EVERY_ROUNDS = 3;

export const WORKER_MEMORY_MAX_CONTEXT_CHARS = 14_000;

export const prioritySchema = z.enum(["high", "medium", "low"]);

export const highLevelPlanSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      objective: z.string().min(1),
      scope: z.array(z.string().min(1)).min(1),
      rationale: z.string().min(1),
      dependencies: z.array(z.string().min(1)),
      priority: prioritySchema,
    }),
  )
  .max(MAX_HIGH_LEVEL_ITEMS);

export const plannerPayloadSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      parentId: z.string().min(1),
      task: z.string().min(1),
      files: z.array(z.string().min(1)).min(1),
      reason: z.string().min(1),
      acceptanceCriteria: z.array(z.string().min(1)).min(1),
      priority: prioritySchema,
    }),
  )
  .max(MAX_PARALLEL_MODIFIERS);

export type AgentRuntimeState = typeof AgentState.State;

export type ModifyWorkerRuntimeState = typeof ModifyWorkerState.State;

export type TokenUsage = { prompt: number; completion: number; total: number };

export type ToolCall = {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  repaired?: boolean;
  repairNotes?: string[];
  validationError?: string | null;
};

export type ToolExecutionResult = {
  messages: ToolMessage[];
  touchedFiles: string[];
  interactiveRequest: InteractiveRequest | null;
  tokenUsage: TokenUsage;
};

export type WorkerToolRuntime = {
  workerId: string;
  slot: number;
  proposals: Map<string, WorkerFileChange>;
};

export type ToolRuntimeState = AgentRuntimeState & {
  workerRuntime?: WorkerToolRuntime;
};

export type InteractiveReplyInstruction = {
  requestId: string;
  mode: InteractiveResponseMode;
  answer?: string;
};

export type TerminalCommandOutcome = {
  output: string;
  mode: CommandExecutionMode;
  success: boolean;
  exitCode: number | null;
  interactiveRequest: InteractiveRequest | null;
  tokenUsage: TokenUsage;
};

export type LifecycleTracker = {
  events: AgentLifecycleEvent[];
  getSnapshot: () => AgentLifecycleSnapshot;
  transition: (
    status: AgentLifecycleStatus,
    detail: string,
    toolName?: string,
  ) => AgentLifecycleEvent;
};

export function createLifecycleTracker(
  agentId: string,
  role: AgentRole,
  iteration: number,
  config?: LangGraphRunnableConfig,
  slot?: number,
): LifecycleTracker {
  const events: AgentLifecycleEvent[] = [];
  const startedAt = new Date().toISOString();
  let sequence = 0;
  let snapshot: AgentLifecycleSnapshot = {
    agentId,
    role,
    status: "CREATED",
    slot,
    iteration,
    detail: "Agent 已创建。",
    startedAt,
    updatedAt: startedAt,
  };

  const transition = (
    status: AgentLifecycleStatus,
    detail: string,
    toolName?: string,
  ): AgentLifecycleEvent => {
    const previousStatus = snapshot.status;
    const createdAt = new Date().toISOString();
    sequence += 1;
    const event: AgentLifecycleEvent = {
      id: `${agentId}:${iteration}:${sequence}:${createdAt}`,
      agentId,
      role,
      status,
      previousStatus,
      slot,
      iteration,
      sequence,
      detail,
      toolName,
      createdAt,
    };
    events.push(event);
    snapshot = {
      ...snapshot,
      status,
      detail,
      updatedAt: createdAt,
      completedAt: status === "COMPLETED" ? createdAt : snapshot.completedAt,
      failedAt: status === "FAILED" ? createdAt : snapshot.failedAt,
    };
    config?.writer?.({ type: "AGENT_LIFECYCLE", payload: event });
    recordAgentTraceEvent("lifecycle", `${role}:${agentId}`, "info", {
      status,
      previousStatus,
      detail,
      toolName,
      slot,
      iteration,
    });
    return event;
  };

  // CREATED 也作为可观测事件发出。
  transition("CREATED", "Agent 已创建并进入调度队列。");

  return {
    events,
    getSnapshot: () => snapshot,
    transition,
  };
}

export function buildLifecycleStateUpdate(
  tracker: LifecycleTracker,
): {
  agentLifecycles: Record<string, AgentLifecycleSnapshot>;
  agentLifecycleEvents: AgentLifecycleEvent[];
} {
  const snapshot = tracker.getSnapshot();
  return {
    agentLifecycles: { [snapshot.agentId]: snapshot },
    agentLifecycleEvents: [...tracker.events],
  };
}

// 模型返回的 content 可能是字符串，也可能是多段结构化内容。
// 这个函数把它统一压平成纯文本，方便后续拼提示词和写日志。
export function normalizeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (
          item &&
          typeof item === "object" &&
          "text" in item &&
          typeof item.text === "string"
        ) {
          return item.text;
        }
        return JSON.stringify(item);
      })
      .join("\n");
  }
  return String(content ?? "");
}

// 有些模型会把“思考过程”夹在特殊标记里。
// 这里会在给其他节点/用户看之前先去掉，避免内部推理噪音污染上下文。
export function stripThinkContent(content: unknown): string {
  return normalizeContent(content)
    .replace(/<INTERNAL_THINK_START>[\s\S]*?<INTERNAL_THINK_END>/g, "")
    .trim();
}

// 多 Agent 当前最关心的是“用户这轮到底要什么”。
// 所以这里总是优先抽最后一条 human message 作为当前任务入口。
export function getLatestUserRequest(state: AgentRuntimeState): string {
  const humanMessages = state.messages.filter(
    (message: BaseMessage) => message._getType() === "human",
  );
  const lastMessage = humanMessages[humanMessages.length - 1];
  return lastMessage
    ? stripThinkContent(lastMessage.content)
    : "请分析当前项目并完成用户请求。";
}

// 把接口 usage 统一整理成项目内部使用的 Token 结构。
// 这样不同节点返回的 tokenUsage 才能稳定累加。
export function buildTokenUsage(response?: LlmChatResponse["usage"]): TokenUsage {
  if (!response) return { prompt: 0, completion: 0, total: 0 };
  return {
    prompt: response.prompt_tokens || 0,
    completion: response.completion_tokens || 0,
    total: response.total_tokens || 0,
  };
}

export function createEmptyTokenUsage(): TokenUsage {
  return { prompt: 0, completion: 0, total: 0 };
}

export function mergeTokenUsage(current: TokenUsage, next?: TokenUsage): TokenUsage {
  if (!next) return current;
  return {
    prompt: current.prompt + (next.prompt || 0),
    completion: current.completion + (next.completion || 0),
    total: current.total + (next.total || 0),
  };
}

export function classifyCommandMode(command: string): CommandExecutionMode {
  const normalizedCommand = command.trim().toLowerCase();
  if (
    /^(npm create|npx create-[\w-]+|pnpm dlx|python manage\.py|py manage\.py)\b/i.test(
      normalizedCommand,
    )
  ) {
    return "pty";
  }
  return "normal";
}

export function validateTerminalCommand(command: string): string | null {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return "终端命令为空，请提供明确的 shell 命令。";
  }

  if (/```/.test(trimmedCommand)) {
    return "检测到 Markdown 代码块标记，这不是可直接执行的终端命令。请只传纯命令文本。";
  }

  if (trimmedCommand.split(/\r?\n/).length > 3) {
    return "检测到多行长文本输入，这更像自然语言需求而不是单条终端命令。请改为例如 `pnpm dlx create-taro-app@latest my-app --template react` 这样的实际命令。";
  }

  const naturalLanguageMarkers = [
    "你是一名",
    "你能够独立完成",
    "开发要求",
    "优先编写",
    "生成完整目录结构",
    "微信小程序",
    "微信开放平台",
  ];
  if (naturalLanguageMarkers.some((marker) => trimmedCommand.includes(marker))) {
    return "检测到这是自然语言提示词，不是 shell 命令。`run_terminal_command` 只能执行类似 `git status`、`pnpm build`、`pnpm dlx ...` 的真实终端指令。";
  }

  const shellLikePattern =
    /^(pnpm|npm|npx|node|python|py|git|ls|dir|pwd|cd|type|cat|echo|where|which|taro|vite|yarn|bun|tsx|tsc|eslint|next)\b/i;
  const chineseCharCount = (trimmedCommand.match(/[\u4e00-\u9fa5]/g) || []).length;
  if (!shellLikePattern.test(trimmedCommand) && chineseCharCount >= 8) {
    return "检测到命令中包含大量自然语言描述，但缺少明确的可执行命令前缀。请把需求先交给 Planner/Modify Agent 理解，再由工具执行真实命令。";
  }

  if (trimmedCommand.length > 220 && !shellLikePattern.test(trimmedCommand)) {
    return "命令文本过长且不像真实 shell 指令，已拦截执行。请改成具体 CLI 命令。";
  }

  return null;
}

export function extractInteractiveReplyInstruction(
  input: string,
): InteractiveReplyInstruction | null {
  const requestIdMatch = input.match(/\[INTERACTIVE_REPLY\]\s*id=([^\s]+)\s*/i);
  const modeMatch = input.match(/\bmode=(auto|llm|user)\b/i);
  if (!requestIdMatch || !modeMatch) return null;

  const answerMatch = input.match(/\banswer=([^\n]*)$/i);
  const rawAnswer = answerMatch?.[1] ?? undefined;
  return {
    requestId: requestIdMatch[1].trim(),
    mode: modeMatch[1].toLowerCase() as InteractiveResponseMode,
    answer: rawAnswer === "__ENTER__" ? "" : rawAnswer,
  };
}

export async function buildInteractiveAnswerByLlm(
  state: AgentRuntimeState,
  command: string,
  prompt: string,
): Promise<{ answer: string; tokenUsage: TokenUsage }> {
  const response = await invokeLlm(state, [
    {
      role: "system",
      content: CliPromptText,
    },
    {
      role: "user",
      content: [
        `用户原始请求:\n${getLatestUserRequest(state)}`,
        `当前命令:\n${command}`,
        `当前交互提示:\n${prompt}`,
      ].join("\n\n"),
    },
  ], "cli");

  return {
    answer: stripThinkContent(response.choices?.[0]?.message?.content || "").trim() || "yes",
    tokenUsage: buildTokenUsage(response.usage),
  };
}
