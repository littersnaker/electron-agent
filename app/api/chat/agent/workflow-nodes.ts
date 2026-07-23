import { BaseMessage, ToolMessage } from "@langchain/core/messages";
import { execSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { tools } from "../tools";
import { completeWithLlm } from "@/app/lib/llm/gateway";
import { getRequestLlmCredentials } from "@/app/lib/llm/request-context";
import type { LlmChatResponse, LlmTaskType } from "@/app/lib/llm/types";
import { AgentState, ModifyWorkerState } from "./state";
import {
  AgentLifecycleEvent,
  AgentLifecycleSnapshot,
  AgentLifecycleStatus,
  AgentRole,
  DEFAULT_HIGH_LEVEL_PLAN,
  DEFAULT_MERGE_RESULT,
  DEFAULT_PLANNER_PAYLOAD,
  DEFAULT_REVIEW_PAYLOAD,
  DEFAULT_VERIFICATION_RESULT,
  CommandExecutionMode,
  HighLevelPlanPayload,
  InteractiveRequest,
  InteractiveResponseMode,
  MergeConflict,
  MergeResult,
  ModifyTaskResult,
  ModifyWorkerInput,
  PlannerPayload,
  PlanTask,
  PlannerValidationStatus,
  ReviewPayload,
  VerificationCheckResult,
  VerificationResult,
  WorkerFileChange,
  WorkerMemory,
  createDefaultWorkerMemory,
  formatHighLevelPlan,
  formatPlannerPayload,
} from "./types";
import { searchProjectIndex } from "@/app/lib/server/workspace-store";
import {
  getPersistentTerminalSession,
  resumePersistentTerminalSession,
  startPersistentTerminalSession,
} from "./persistent-terminal-session";
import {
  CliPromptText,
  FinalReportAgentPromptText,
  HighLevelPlannerPromptText,
  ModifyWorkerPromptText,
  PlannerPromptText,
  ReviewerPromptText,
  WorkerMemoryPromptText,
} from "../prompt";

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
const MAX_PARALLEL_MODIFIERS = 6;
const MAX_HIGH_LEVEL_ITEMS = 4;
const MAX_PLANNER_RETRIES = 2;
const MAX_REVIEW_RETRIES = 2;
const MAX_WORKER_TOOL_ROUNDS = 10;
const WORKER_MEMORY_COMPRESS_EVERY_ROUNDS = 3;
const WORKER_MEMORY_MAX_CONTEXT_CHARS = 14_000;

const prioritySchema = z.enum(["high", "medium", "low"]);
const highLevelPlanSchema = z
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

const plannerPayloadSchema = z
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

type AgentRuntimeState = typeof AgentState.State;
type ModifyWorkerRuntimeState = typeof ModifyWorkerState.State;
type TokenUsage = { prompt: number; completion: number; total: number };
type ToolCall = { id?: string; name: string; args: unknown };
type ToolExecutionResult = {
  messages: ToolMessage[];
  touchedFiles: string[];
  interactiveRequest: InteractiveRequest | null;
  tokenUsage: TokenUsage;
};

type WorkerToolRuntime = {
  workerId: string;
  slot: number;
  proposals: Map<string, WorkerFileChange>;
};

type ToolRuntimeState = AgentRuntimeState & {
  workerRuntime?: WorkerToolRuntime;
};
type InteractiveReplyInstruction = {
  requestId: string;
  mode: InteractiveResponseMode;
  answer?: string;
};
type TerminalCommandOutcome = {
  output: string;
  mode: CommandExecutionMode;
  success: boolean;
  exitCode: number | null;
  interactiveRequest: InteractiveRequest | null;
  tokenUsage: TokenUsage;
};

type LifecycleTracker = {
  events: AgentLifecycleEvent[];
  getSnapshot: () => AgentLifecycleSnapshot;
  transition: (
    status: AgentLifecycleStatus,
    detail: string,
    toolName?: string,
  ) => AgentLifecycleEvent;
};

function createLifecycleTracker(
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

function buildLifecycleStateUpdate(
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
function normalizeContent(content: unknown): string {
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
function stripThinkContent(content: unknown): string {
  return normalizeContent(content)
    .replace(/<INTERNAL_THINK_START>[\s\S]*?<INTERNAL_THINK_END>/g, "")
    .trim();
}

// 多 Agent 当前最关心的是“用户这轮到底要什么”。
// 所以这里总是优先抽最后一条 human message 作为当前任务入口。
function getLatestUserRequest(state: AgentRuntimeState): string {
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
function buildTokenUsage(response?: LlmChatResponse["usage"]): TokenUsage {
  if (!response) return { prompt: 0, completion: 0, total: 0 };
  return {
    prompt: response.prompt_tokens || 0,
    completion: response.completion_tokens || 0,
    total: response.total_tokens || 0,
  };
}

function createEmptyTokenUsage(): TokenUsage {
  return { prompt: 0, completion: 0, total: 0 };
}

function mergeTokenUsage(current: TokenUsage, next?: TokenUsage): TokenUsage {
  if (!next) return current;
  return {
    prompt: current.prompt + (next.prompt || 0),
    completion: current.completion + (next.completion || 0),
    total: current.total + (next.total || 0),
  };
}

function classifyCommandMode(command: string): CommandExecutionMode {
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

function validateTerminalCommand(command: string): string | null {
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

function extractInteractiveReplyInstruction(
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

async function buildInteractiveAnswerByLlm(
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

async function runNormalTerminalCommand(
  command: string,
  workingDir: string,
  timeoutMs = 20_000,
): Promise<TerminalCommandOutcome> {
  try {
    return {
      output: execSync(command, {
        cwd: workingDir || process.cwd(),
        encoding: "utf-8",
        stdio: "pipe",
        timeout: timeoutMs,
      }),
      mode: "normal",
      success: true,
      exitCode: 0,
      interactiveRequest: null,
      tokenUsage: createEmptyTokenUsage(),
    };
  } catch (error) {
    if (error instanceof Error && "stdout" in error) {
      const stdout = String((error as { stdout?: string }).stdout || "");
      const stderr = String((error as { stderr?: string }).stderr || "");
      const status = (error as { status?: number }).status;
      return {
        output: [stdout, stderr].filter(Boolean).join("\n"),
        mode: "normal",
        success: false,
        exitCode: typeof status === "number" ? status : 1,
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    }
    return {
      output: `命令执行失败: ${error instanceof Error ? error.message : String(error)}`,
      mode: "normal",
      success: false,
      exitCode: 1,
      interactiveRequest: null,
      tokenUsage: createEmptyTokenUsage(),
    };
  }
}

async function runPtyLikeCommand(
  command: string,
  workingDir: string,
  state: AgentRuntimeState,
): Promise<TerminalCommandOutcome> {
  const latestUserRequest = getLatestUserRequest(state);
  const replyInstruction = extractInteractiveReplyInstruction(latestUserRequest);
  const pendingRequest = state.interactiveRequest;
  const tokenUsage = createEmptyTokenUsage();

  if (
    replyInstruction &&
    pendingRequest &&
    replyInstruction.requestId === pendingRequest.id
  ) {
    let answerToWrite = "";
    if (replyInstruction.mode === "user") {
      answerToWrite = replyInstruction.answer ?? "";
    } else if (replyInstruction.mode === "auto") {
      answerToWrite = pendingRequest.options[0]?.value || "yes";
    } else if (replyInstruction.mode === "llm") {
      const { answer, tokenUsage: llmUsage } = await buildInteractiveAnswerByLlm(
        state,
        pendingRequest.command,
        pendingRequest.prompt,
      );
      const mergedUsage = mergeTokenUsage(tokenUsage, llmUsage);
      tokenUsage.prompt = mergedUsage.prompt;
      tokenUsage.completion = mergedUsage.completion;
      tokenUsage.total = mergedUsage.total;
      answerToWrite = answer || "yes";
    }

    const resumed = await resumePersistentTerminalSession(
      pendingRequest.id,
      answerToWrite,
    );
    return {
      output: truncateText(resumed.output, 4000),
      mode: "pty",
      success: resumed.interactiveRequest === null,
      exitCode: resumed.interactiveRequest === null ? 0 : null,
      interactiveRequest: resumed.interactiveRequest,
      tokenUsage,
    };
  }

  if (pendingRequest?.id) {
    const existingSession = getPersistentTerminalSession(pendingRequest.id);
    if (existingSession && existingSession.command === command) {
      return {
        output: truncateText(
          existingSession.recentOutput || pendingRequest.prompt,
          4000,
        ),
        mode: "pty",
        success: false,
        exitCode: null,
        interactiveRequest: existingSession,
        tokenUsage,
      };
    }
  }

  const started = await startPersistentTerminalSession(command, workingDir, "pty");
  return {
    output: truncateText(started.output, 4000),
    mode: "pty",
    success: started.interactiveRequest === null,
    exitCode: started.interactiveRequest === null ? 0 : null,
    interactiveRequest: started.interactiveRequest,
    tokenUsage,
  };
}

// 长期摘要只保留高价值结论，不保留所有细节。
// 目的是让后续多轮对话还能记住“之前做过什么”，但不会无限膨胀。
function appendSummary(
  previousSummary: string,
  userRequest: string,
  finalReportSummary: string,
): string {
  const nextSummary = [
    previousSummary.trim(),
    `任务: ${userRequest}\n结果: ${finalReportSummary.trim()}`,
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");

  return nextSummary.length > 6000
    ? nextSummary.slice(nextSummary.length - 6000)
    : nextSummary;
}

// 给模型看的近期对话精简版。
// 这里只保留人类/助手消息，不把工具消息塞进去，避免上下文太碎。
function toConversationText(messages: BaseMessage[], limit = 6): string {
  return messages
    .filter((message) => message._getType() !== "tool")
    .slice(-limit)
    .map(
      (message) => `${message._getType()}: ${stripThinkContent(message.content)}`,
    )
    .join("\n");
}

// 统一截断长文本，避免提示词或最终输出被超长文件内容淹没。
function truncateText(input: string, maxLength = 5000): string {
  return input.length > maxLength ? `${input.slice(0, maxLength)}\n...` : input;
}


function normalizeMemoryItems(value: unknown, maxItems = 8): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  ).slice(0, maxItems);
}

function parseWorkerMemoryPayload(
  content: string,
  previousMemory: WorkerMemory,
  round: number,
): WorkerMemory {
  const trimmed = content.trim();
  const candidates = [trimmed];
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      return {
        summary: truncateText(String(parsed.summary || previousMemory.summary), 1200),
        completedActions: normalizeMemoryItems(parsed.completedActions),
        pendingActions: normalizeMemoryItems(parsed.pendingActions),
        keyFiles: normalizeMemoryItems(parsed.keyFiles),
        recentObservations: normalizeMemoryItems(parsed.recentObservations),
        compressionCount: previousMemory.compressionCount + 1,
        lastCompressedRound: round,
      };
    } catch {
      continue;
    }
  }

  return {
    ...previousMemory,
    summary: truncateText(
      [previousMemory.summary, stripThinkContent(content)].filter(Boolean).join("\n"),
      1200,
    ),
    compressionCount: previousMemory.compressionCount + 1,
    lastCompressedRound: round,
  };
}

function shouldCompressWorkerMemory(
  runtimeMessages: Array<Record<string, unknown>>,
  toolRound: number,
  memory: WorkerMemory,
): boolean {
  if (toolRound <= memory.lastCompressedRound) return false;
  const contextSize = JSON.stringify(runtimeMessages).length;
  return (
    toolRound - memory.lastCompressedRound >=
      WORKER_MEMORY_COMPRESS_EVERY_ROUNDS ||
    contextSize >= WORKER_MEMORY_MAX_CONTEXT_CHARS
  );
}

async function compressWorkerMemory(
  state: AgentRuntimeState,
  task: PlanTask,
  currentMemory: WorkerMemory,
  runtimeMessages: Array<Record<string, unknown>>,
  toolRound: number,
): Promise<{ memory: WorkerMemory; tokenUsage: TokenUsage }> {
  const response = await invokeLlm(state, [
    { role: "system", content: WorkerMemoryPromptText },
    {
      role: "user",
      content: [
        `当前任务:\n${JSON.stringify(task, null, 2)}`,
        `已有 Worker Memory:\n${JSON.stringify(currentMemory, null, 2)}`,
        `待压缩执行历史:\n${truncateText(
          runtimeMessages
            .map(
              (message) =>
                `${String(message.role || "unknown")}: ${truncateText(
                  normalizeContent(message.content),
                  2500,
                )}`,
            )
            .join("\n\n"),
          10_000,
        )}`,
      ].join("\n\n"),
    },
  ], "memory");

  const content = response.choices?.[0]?.message?.content || "";
  return {
    memory: parseWorkerMemoryPayload(content, currentMemory, toolRound),
    tokenUsage: buildTokenUsage(response.usage),
  };
}

function buildWorkerContinuationMessage(
  task: PlanTask,
  sharedMemory: ModifyWorkerInput["sharedMemory"],
  workerMemory: WorkerMemory,
  reviewFeedback: string,
): Record<string, unknown> {
  return {
    role: "user",
    content: [
      `继续执行当前独立任务:\n${JSON.stringify(task, null, 2)}`,
      `只读共享上下文摘要:\n${truncateText(sharedMemory.mergedContext, 3500)}`,
      `当前 Worker 压缩记忆:\n${JSON.stringify(workerMemory, null, 2)}`,
      `Reviewer 反馈:\n${reviewFeedback || "暂无"}`,
      "继续遵守 read -> propose -> get_diff -> apply_file_change 闭环。",
      "不要声称未调用工具的操作已经完成。",
    ].join("\n\n"),
  };
}

/*
 * 所有 Agent 节点统一经过 LLM Gateway。
 * Provider、模型地址、鉴权格式和任务路由都被隔离在 app/lib/llm 中。
 */
async function invokeLlm(
  state: AgentRuntimeState,
  messages: Array<Record<string, unknown>>,
  task: LlmTaskType,
  withTools = false,
): Promise<LlmChatResponse> {
  return completeWithLlm({
    task,
    preferredModelId: state.model,
    credentials: getRequestLlmCredentials(),
    messages,
    tools: withTools ? tools : undefined,
    toolChoice: withTools ? "auto" : "none",
  });
}

// Planner 经常会在 JSON 外面夹带解释文字。
// 这里会尽量从整段文本里捞出第一个数组，给后续 schema 校验使用。
function extractPlannerJsonArray(content: string): unknown | null {
  const trimmed = content.trim();
  const candidates = [trimmed];
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) candidates.push(arrayMatch[0]);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }

  return null;
}

/*
 * 这是 Planner 的第一道门：
 * 先判断它是不是合法 JSON，
 * 再判断这个 JSON 是否满足我们定义的任务数组 schema。
 *
 * 只有通过这里，后面的并发 Modify 才有意义。
 */

function findHighLevelDependencyCycle(
  plan: HighLevelPlanPayload,
): string[] | null {
  const dependencies = new Map(
    plan.map((item) => [item.id, item.dependencies]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      return [...stack.slice(cycleStart), id];
    }
    if (visited.has(id)) return null;

    visiting.add(id);
    stack.push(id);
    for (const dependency of dependencies.get(id) || []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const item of plan) {
    const cycle = visit(item.id);
    if (cycle) return cycle;
  }
  return null;
}

function parseHighLevelPlanWithSchema(content: string): {
  success: boolean;
  plan: HighLevelPlanPayload;
  message: string;
} {
  const extracted = extractPlannerJsonArray(content);
  if (extracted === null) {
    return {
      success: false,
      plan: DEFAULT_HIGH_LEVEL_PLAN,
      message: "High-Level Planner 输出中未提取到合法 JSON 数组。",
    };
  }

  const parsed = highLevelPlanSchema.safeParse(extracted);
  if (!parsed.success) {
    return {
      success: false,
      plan: DEFAULT_HIGH_LEVEL_PLAN,
      message: `High-Level Plan Schema 校验失败: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    };
  }

  const ids = new Set(parsed.data.map((item) => item.id.trim()));
  const duplicatedIds = parsed.data
    .map((item) => item.id.trim())
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicatedIds.length) {
    return {
      success: false,
      plan: DEFAULT_HIGH_LEVEL_PLAN,
      message: `High-Level Plan 存在重复 id: ${Array.from(
        new Set(duplicatedIds),
      ).join(", ")}`,
    };
  }

  const invalidDependency = parsed.data.find((item) =>
    item.dependencies.some((dependency) => !ids.has(dependency)),
  );
  if (invalidDependency) {
    return {
      success: false,
      plan: DEFAULT_HIGH_LEVEL_PLAN,
      message: `High-Level Plan 的依赖引用无效: ${invalidDependency.id}`,
    };
  }

  const plan = parsed.data.map((item) => ({
    id: item.id.trim(),
    objective: item.objective.trim(),
    scope: item.scope.map((value) => value.trim()).filter(Boolean),
    rationale: item.rationale.trim(),
    dependencies: item.dependencies.map((value) => value.trim()).filter(Boolean),
    priority: item.priority,
  }));
  const dependencyCycle = findHighLevelDependencyCycle(plan);
  if (dependencyCycle) {
    return {
      success: false,
      plan: DEFAULT_HIGH_LEVEL_PLAN,
      message: `High-Level Plan 存在循环依赖: ${dependencyCycle.join(" -> ")}`,
    };
  }

  return {
    success: true,
    plan,
    message: plan.length
      ? "High-Level Plan Schema 校验通过。"
      : "High-Level Planner 判断当前请求无需代码修改。",
  };
}

function parsePlannerPayloadWithSchema(
  content: string,
  highLevelPlan: HighLevelPlanPayload,
): {
  success: boolean;
  tasks: PlannerPayload;
  message: string;
} {
  const extracted = extractPlannerJsonArray(content);
  if (extracted === null) {
    return {
      success: false,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: "Task Planner 输出中未提取到合法 JSON 数组。",
    };
  }

  const parsedResult = plannerPayloadSchema.safeParse(extracted);
  if (!parsedResult.success) {
    return {
      success: false,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: `Task Planner JSON Schema 校验失败: ${parsedResult.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    };
  }

  if (parsedResult.data.length === 0) {
    return {
      success: true,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: "Task Planner Schema 校验通过，当前请求无需拆分修改任务。",
    };
  }

  const highLevelIds = new Set(highLevelPlan.map((item) => item.id));
  if (highLevelIds.size === 0) {
    return {
      success: false,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: "High-Level Plan 为空，但 Task Planner 返回了修改任务。",
    };
  }

  const normalizedTasks = parsedResult.data.map((task) => ({
    id: task.id.trim(),
    parentId: task.parentId.trim(),
    task: task.task.trim(),
    files: Array.from(
      new Set(task.files.map((file) => file.trim()).filter(Boolean)),
    ),
    reason: task.reason.trim(),
    acceptanceCriteria: task.acceptanceCriteria
      .map((item) => item.trim())
      .filter(Boolean),
    priority: task.priority,
  }));

  const duplicatedTaskIds = normalizedTasks
    .map((task) => task.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicatedTaskIds.length) {
    return {
      success: false,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: `Task Planner 存在重复任务 id: ${Array.from(
        new Set(duplicatedTaskIds),
      ).join(", ")}`,
    };
  }

  const invalidParent = normalizedTasks.find(
    (task) =>
      task.parentId !== "fallback" &&
      highLevelIds.size > 0 &&
      !highLevelIds.has(task.parentId),
  );
  if (invalidParent) {
    return {
      success: false,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: `Task Planner 的 parentId 无法对应 High-Level Plan: ${invalidParent.id}`,
    };
  }

  return {
    success: true,
    tasks: normalizedTasks.slice(0, MAX_PARALLEL_MODIFIERS),
    message: "Task Planner JSON Schema 校验通过。",
  };
}

// 并发 Modify 最怕多个任务改同一个文件。
// 这个函数专门找出跨任务重复文件，给“文件唯一性检查”节点使用。
function collectDuplicatePlannerFiles(tasks: PlannerPayload): string[] {
  const seenFiles = new Set<string>();
  const duplicatedFiles = new Set<string>();

  tasks.forEach((task) => {
    task.files.forEach((file) => {
      const normalizedFile = file.toLowerCase();
      if (seenFiles.has(normalizedFile)) {
        duplicatedFiles.add(file);
        return;
      }
      seenFiles.add(normalizedFile);
    });
  });

  return Array.from(duplicatedFiles);
}

// Reviewer 也要求严格输出 JSON，但模型不一定老实。
// 所以这里会尽量从文本中提取对象，并把字段修正成项目可接受的安全默认值。
function safeParseReviewPayload(content: string): ReviewPayload {
  const trimmed = content.trim();
  const candidates = [trimmed];
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<ReviewPayload>;
      const decision =
        parsed.decision === "RETRY"
          ? "RETRY"
          : parsed.decision === "FAIL"
            ? "FAIL"
            : DEFAULT_REVIEW_PAYLOAD.decision;
      const feedback = typeof parsed.feedback === "string" ? parsed.feedback : "";
      const risks = Array.isArray(parsed.risks)
        ? parsed.risks.map(String)
        : DEFAULT_REVIEW_PAYLOAD.risks;
      const retryTasks = Array.isArray(parsed.retryTasks)
        ? parsed.retryTasks
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value))
            .filter((value) => value >= 0 && value < MAX_PARALLEL_MODIFIERS)
        : [];
      return { decision, feedback, risks, retryTasks };
    } catch {
      continue;
    }
  }

  return DEFAULT_REVIEW_PAYLOAD;
}

// 规则修复阶段用这个函数做“保守去重”：
// 同一个文件只保留给最先命中的任务，后面的任务自动剔除该文件。
function normalizePlannerTasks(tasks: PlannerPayload): PlannerPayload {
  const seenFiles = new Set<string>();

  return tasks
    .map((task) => {
      const uniqueFiles = task.files.filter((file) => {
        const normalizedFile = file.toLowerCase();
        if (seenFiles.has(normalizedFile)) return false;
        seenFiles.add(normalizedFile);
        return true;
      });
      return {
        ...task,
        files: uniqueFiles,
      };
    })
    .filter((task) => task.task.trim() && task.files.length > 0)
    .slice(0, MAX_PARALLEL_MODIFIERS);
}

// 当 Planner 反复失败时，就不再坚持并发拆分。
// 这里会把任务退化成一个“大而全”的单任务，交给单 Agent 串行处理。
function buildSingleAgentFallbackPlan(state: AgentRuntimeState): PlannerPayload {
  const collectedFiles = [
    ...(state.plannerOutput || []).flatMap((task: { files: string[] }) => task.files),
    ...extractCandidatePaths(getLatestUserRequest(state)),
    ...extractCandidatePaths(state.mergedContext || ""),
  ];
  const uniqueFiles = Array.from(
    new Set(collectedFiles.map((file) => file.trim()).filter(Boolean)),
  ).slice(0, 12);

  return [
    {
      id: "fallback_single_agent",
      parentId: "fallback",
      task: `单 Agent 降级执行：${getLatestUserRequest(state)}`,
      files: uniqueFiles,
      reason: "Planner 多次无法生成安全的并发任务，降级为单 Worker 串行处理。",
      acceptanceCriteria: ["在单个 Worker 内完成用户需求并通过统一 Review"],
      priority: "high",
    },
  ];
}

// 统一判断 Planner 还能不能继续重试，以及下一次的重试计数是多少。
function getPlannerRetryStatus(state: AgentRuntimeState): {
  shouldRetry: boolean;
  nextRetryCount: number;
} {
  const currentRetryCount = state.plannerRetryCount || 0;
  if (currentRetryCount >= MAX_PLANNER_RETRIES) {
    return { shouldRetry: false, nextRetryCount: currentRetryCount };
  }

  return {
    shouldRetry: true,
    nextRetryCount: currentRetryCount + 1,
  };
}

// 把 Reviewer 指定的槽位数组格式化成人能一眼看懂的字符串。
function formatRetryTasks(retryTasks: number[]): string {
  if (!retryTasks.length) return "无";
  return retryTasks.map((slot) => `Task ${slot + 1}`).join(", ");
}

// Reviewer 没给明确 retryTasks 时，给一个尽量安全的兜底策略。
// 当前做法是：优先回退到已有 done 结果里的某个槽位，至少保证返工目标不为空。
function resolveRetryTaskSlots(state: AgentRuntimeState): number[] {
  const validRetryTasks = (state.reviewPayload?.retryTasks || [])
    .filter((value: number) => Number.isInteger(value))
    .filter((value: number) => value >= 0 && value < MAX_PARALLEL_MODIFIERS);

  if (validRetryTasks.length) {
    return Array.from(new Set(validRetryTasks));
  }

  const fallbackSlot = (state.modifyResults || []).find(
    (item: ModifyTaskResult) => item.status === "done",
  )?.slot;

  return fallbackSlot === undefined ? [] : [fallbackSlot];
}

// 从用户请求里尽量抓出“像路径一样的字符串”。
// FileAgent 会拿这份候选路径去预读文件或目录。
function extractCandidatePaths(input: string): string[] {
  const matches =
    input.match(
      /[A-Za-z]:\\[^\s"'`]+|(?:\.{0,2}[\\/])?[A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+/g,
    ) || [];

  return Array.from(
    new Set(
      matches
        .map((item) => item.replace(/[),.;:]+$/, "").trim())
        .filter((item) => item.length > 1 && !item.startsWith("http")),
    ),
  );
}

// 把单个并发 Worker 的执行结果收敛成统一结构。
function buildModifyResult(
  workerId: string,
  slot: number,
  task: PlanTask,
  summary: string,
  status: ModifyTaskResult["status"],
  fileChanges: WorkerFileChange[],
  workerMemory: WorkerMemory,
  lifecycle: AgentLifecycleSnapshot,
  lifecycleEvents: AgentLifecycleEvent[],
  interactiveRequest: InteractiveRequest | null = null,
): ModifyTaskResult {
  return {
    workerId,
    slot,
    task: task.task,
    taskId: task.id,
    files: task.files,
    summary,
    touchedFiles: Array.from(
      new Set(fileChanges.map((change) => change.filePath)),
    ),
    fileChanges,
    workerMemory,
    lifecycle,
    lifecycleEvents,
    interactiveRequest,
    status,
  };
}

// 给 Merge、Reviewer、Final Report 提供统一的人类可读结果文本。
function formatModifyResults(results: ModifyTaskResult[]): string {
  if (!results.length) return "暂无 Modify Worker 结果。";

  return [...results]
    .sort((left, right) => left.slot - right.slot)
    .map((result) => {
      const readyCount = result.fileChanges.filter((item) => item.ready).length;
      return [
        `Worker: ${result.workerId}`,
        `槽位 ${result.slot + 1}: ${result.task}`,
        `状态: ${result.status}`,
        `计划文件: ${result.files.length ? result.files.join(", ") : "未指定"}`,
        `实际提案: ${result.touchedFiles.length ? result.touchedFiles.join(", ") : "无"}`,
        `待合并变更: ${readyCount}/${result.fileChanges.length}`,
        `Memory 压缩次数: ${result.workerMemory.compressionCount}`,
        `生命周期: ${result.lifecycle.status}`,
        `总结: ${result.summary}`,
      ].join("\n");
    })
    .join("\n\n");
}

function normalizeFileKey(filePath: string): string {
  const normalized = path.normalize(filePath).replace(/\\/g, "/").replace(/^\.\//, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function hashContent(content: string | null): string {
  return createHash("sha256")
    .update(content === null ? "<FILE_NOT_EXISTS>" : content)
    .digest("hex");
}

// 把路径限制在当前项目工作目录内，避免 Worker 通过 ../ 或绝对路径越界写入。
async function getSafePath(filePath: string, workingDir: string): Promise<string> {
  const rootPath = path.resolve(workingDir || process.cwd());
  const normalizedInput = filePath.trim();
  const candidatePath = path.isAbsolute(normalizedInput)
    ? path.resolve(normalizedInput)
    : path.resolve(rootPath, normalizedInput.replace(/^(\.\/|\/)/, ""));
  const relativePath = path.relative(rootPath, candidatePath);
  const outsideRoot =
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath);

  if (outsideRoot) {
    throw new Error(`路径越界，拒绝访问项目目录之外的文件: ${filePath}`);
  }
  return candidatePath;
}

async function readRawFile(
  filePath: string,
  workingDir: string,
): Promise<{ exists: boolean; content: string | null }> {
  const safePath = await getSafePath(filePath, workingDir);
  if (!fs.existsSync(safePath)) return { exists: false, content: null };
  return { exists: true, content: fs.readFileSync(safePath, "utf-8") };
}

// Worker 读取文件时优先读取自己的内存提案，避免同一 Worker 多轮修改丢失上下文。
async function readFileFromLocalDisk(
  filePath: string,
  workingDir: string,
  proposals?: Map<string, WorkerFileChange>,
): Promise<string> {
  try {
    const staged = proposals?.get(normalizeFileKey(filePath));
    if (staged) return staged.proposedContent;

    const file = await readRawFile(filePath, workingDir);
    return file.exists ? file.content || "" : `未找到文件: ${filePath}`;
  } catch (error) {
    return `读取失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function buildSimpleDiff(oldText: string, newText: string): string {
  const oldContent = oldText.split("\n");
  const newContent = newText.split("\n");
  const maxLen = Math.max(oldContent.length, newContent.length);
  const diffLines: string[] = [];

  for (let index = 0; index < maxLen; index += 1) {
    const oldLine = oldContent[index];
    const newLine = newContent[index];
    if (oldLine === newLine) continue;
    if (oldLine !== undefined) diffLines.push(`- ${index + 1}: ${oldLine}`);
    if (newLine !== undefined) diffLines.push(`+ ${index + 1}: ${newLine}`);
  }

  return diffLines.length ? truncateText(diffLines.join("\n"), 8000) : "无差异";
}

async function stageWorkerFileChange(
  filePath: string,
  fileContent: string,
  workingDir: string,
  runtime: WorkerToolRuntime,
): Promise<string> {
  const key = normalizeFileKey(filePath);
  const existing = runtime.proposals.get(key);
  const base = existing
    ? {
        exists: existing.baseExists,
        content: existing.baseContent,
        contentHash: existing.baseContentHash,
      }
    : await readRawFile(filePath, workingDir).then((file) => ({
        exists: file.exists,
        content: file.content,
        contentHash: hashContent(file.content),
      }));

  runtime.proposals.set(key, {
    workerId: runtime.workerId,
    slot: runtime.slot,
    filePath,
    baseExists: base.exists,
    baseContent: base.content,
    baseContentHash: base.contentHash,
    proposedContentHash: hashContent(fileContent),
    proposedContent: fileContent,
    ready: existing?.ready || false,
    sourceWorkerIds: [runtime.workerId],
    sourceSlots: [runtime.slot],
    mergeStrategy: "single",
  });

  return `已在 ${runtime.workerId} 独立上下文中暂存变更: ${filePath}。正式文件尚未写入，将由 Merge 节点统一处理。`;
}

async function getWorkerDiff(
  filePath: string,
  workingDir: string,
  runtime: WorkerToolRuntime,
): Promise<string> {
  const change = runtime.proposals.get(normalizeFileKey(filePath));
  if (!change) return `当前 Worker 未找到待合并变更: ${filePath}`;
  return buildSimpleDiff(change.baseContent || "", change.proposedContent);
}

function markWorkerFileReady(
  filePath: string,
  runtime: WorkerToolRuntime,
): string {
  const key = normalizeFileKey(filePath);
  const change = runtime.proposals.get(key);
  if (!change) return `当前 Worker 未找到待应用变更: ${filePath}`;

  runtime.proposals.set(key, { ...change, ready: true });
  return `已将 ${filePath} 加入 Merge 队列；并发 Worker 不直接覆盖正式工作区。`;
}

// 目录预览工具，给 FileAgent / Modify Agent 一个快速“看目录结构”的能力。
async function listDirectory(
  dirPath = ".",
  workingDir: string,
): Promise<string> {
  try {
    const targetDir = await getSafePath(dirPath, workingDir);
    const files = fs.readdirSync(targetDir, { withFileTypes: true });
    return JSON.stringify(
      files.slice(0, 40).map((item) => ({
        name: item.name,
        type: item.isDirectory() ? "directory" : "file",
      })),
      null,
      2,
    );
  } catch (error) {
    return `读取目录失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// 这是一个简化版代码库搜索器。
// 它不是最强检索，但足够给 Planner / SearchAgent 一个轻量代码感知能力。
async function searchCodebase(
  keyword: string,
  workingDir: string,
): Promise<string> {
  const output: string[] = [];
  const rootPath = workingDir || process.cwd();
  let matchCount = 0;

  const walk = (dir: string) => {
    if (matchCount >= 20) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (matchCount >= 20) return;
      const fullPath = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        [".git", ".next", "node_modules", "dist", "build", "out"].includes(
          entry.name,
        )
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      const ext = path.extname(entry.name);
      if (![".ts", ".tsx", ".js", ".jsx", ".json", ".md"].includes(ext)) {
        continue;
      }

      const content = fs.readFileSync(fullPath, "utf-8");
      if (!content.toLowerCase().includes(keyword.toLowerCase())) continue;

      output.push(path.relative(rootPath, fullPath));
      matchCount += 1;
    }
  };

  try {
    walk(rootPath);
    return output.length
      ? `命中 ${output.length} 个文件:\n${output.join("\n")}`
      : `未搜索到关键字 "${keyword}"`;
  } catch (error) {
    return `搜索失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// 终端命令现在不再一刀切地全走同步 execSync。
// 这里会先路由成：
// - 普通命令：直接短命令执行；
// - PTY 命令：走交互会话层，并在需要时把 Prompt 升级给 Interactive Manager。
async function runTerminalCommand(
  command: string,
  workingDir: string,
  state: AgentRuntimeState,
  timeoutMs = 20_000,
): Promise<TerminalCommandOutcome> {
  const validationError = validateTerminalCommand(command);
  if (validationError) {
    return {
      output: validationError,
      mode: "normal",
      success: false,
      exitCode: null,
      interactiveRequest: null,
      tokenUsage: createEmptyTokenUsage(),
    };
  }

  const mode = classifyCommandMode(command);
  if (mode === "pty") {
    return runPtyLikeCommand(command, workingDir, state);
  }
  return runNormalTerminalCommand(command, workingDir, timeoutMs);
}

// 对 `.pending` 版本和正式文件做简化 diff。
// 这里的目标不是生成标准补丁，而是给模型和人看“改了哪些行”。
async function getDiff(filePath: string, workingDir: string): Promise<string> {
  const safePath = await getSafePath(filePath, workingDir);
  const pendingPath = `${safePath}.pending`;

  if (!fs.existsSync(safePath)) return `原文件不存在: ${filePath}`;
  if (!fs.existsSync(pendingPath)) return `未找到待应用变更: ${filePath}.pending`;

  const oldContent = fs.readFileSync(safePath, "utf-8").split("\n");
  const newContent = fs.readFileSync(pendingPath, "utf-8").split("\n");
  const maxLen = Math.max(oldContent.length, newContent.length);
  const diffLines: string[] = [];

  for (let index = 0; index < maxLen; index += 1) {
    const oldLine = oldContent[index];
    const newLine = newContent[index];
    if (oldLine === newLine) continue;
    if (oldLine !== undefined) diffLines.push(`- ${index + 1}: ${oldLine}`);
    if (newLine !== undefined) diffLines.push(`+ ${index + 1}: ${newLine}`);
  }

  return diffLines.length ? diffLines.join("\n") : "无差异";
}

// 真正把 `.pending` 变更覆盖到正式文件上。
// 也就是说，propose 只是提案，apply 才是落盘。
async function applyFileChange(
  filePath: string,
  workingDir: string,
): Promise<string> {
  const safePath = await getSafePath(filePath, workingDir);
  const pendingPath = `${safePath}.pending`;

  if (!fs.existsSync(pendingPath)) return `未找到待应用变更: ${filePath}.pending`;
  fs.copyFileSync(pendingPath, safePath);
  fs.unlinkSync(pendingPath);
  return `已应用修改: ${filePath}`;
}

// 先把模型给出的新文件内容写到 `.pending`，不立刻覆盖正式文件。
// 这样中间还能先做 diff，让链路更安全。
async function proposeFileChange(
  filePath: string,
  fileContent: string,
  workingDir: string,
): Promise<string> {
  const safePath = await getSafePath(filePath, workingDir);
  fs.mkdirSync(path.dirname(safePath), { recursive: true });
  fs.writeFileSync(`${safePath}.pending`, fileContent, "utf-8");
  return `已生成待应用变更: ${filePath}.pending`;
}

// Reviewer 需要看“修改后的文件大概长什么样”。
// 这个函数会把若干关键文件截成预览片段，避免把整份源码都塞给 Reviewer。
async function buildFilePreview(
  files: string[],
  workingDir: string,
  lineLimit = 120,
): Promise<string> {
  const sections: string[] = [];
  for (const file of files.slice(0, 6)) {
    const content = await readFileFromLocalDisk(file, workingDir);
    sections.push(
      `文件 ${file}:\n${truncateText(content.split("\n").slice(0, lineLimit).join("\n"), 2500)}`,
    );
  }
  return sections.join("\n\n");
}

/*
 * 单个工具调用执行器。
 *
 * Modify Agent 最终说的是“我要调用哪个工具、参数是什么”，
 * 真正落地执行是在这里完成的。
 * 这里还顺手收集 touchedFiles，方便后面 Reviewer 和校验节点知道哪些文件被影响了。
 */
async function executeSingleTool(
  toolCall: ToolCall,
  state: ToolRuntimeState,
): Promise<ToolExecutionResult> {
  const args = (toolCall.args as Record<string, string>) || {};
  const currentWorkingDir = state.workingDir || process.cwd();
  const filePath = args.filePath || "";
  const touchedFiles = new Set<string>();
  const makeMessage = (
    content: string,
    name = toolCall.name,
    id = toolCall.id ?? "unknown_id",
  ) => new ToolMessage({ content, tool_call_id: id, name });

  switch (toolCall.name) {
    case "search_project_index":
      if (!state.projectId) {
        return {
          messages: [makeMessage("当前 Code 会话未绑定项目，无法查询项目索引。")],
          touchedFiles: [],
          interactiveRequest: null,
          tokenUsage: createEmptyTokenUsage(),
        };
      }
      return {
        messages: [
          makeMessage(
            JSON.stringify(
              searchProjectIndex(state.projectId, args.query || ""),
              null,
              2,
            ),
          ),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "list_directory":
      return {
        messages: [
          makeMessage(await listDirectory(args.dirPath || ".", currentWorkingDir)),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "search_codebase":
      return {
        messages: [
          makeMessage(await searchCodebase(args.keyword || "", currentWorkingDir)),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "read_file_from_disk":
      return {
        messages: [
          makeMessage(
            await readFileFromLocalDisk(
              filePath,
              currentWorkingDir,
              state.workerRuntime?.proposals,
            ),
          ),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "read_pdf_from_disk":
      return {
        messages: [
          makeMessage("当前版本未接入 PDF 解析器，请改用文件文本或后续补充实现。"),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "get_local_time":
      return {
        messages: [
          makeMessage(
            new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
          ),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "propose_file_change": {
      touchedFiles.add(filePath);
      const proposalMessage = state.workerRuntime
        ? await stageWorkerFileChange(
            filePath,
            args.fileContent || "",
            currentWorkingDir,
            state.workerRuntime,
          )
        : await proposeFileChange(
            filePath,
            args.fileContent || "",
            currentWorkingDir,
          );
      const diffMessage = state.workerRuntime
        ? await getWorkerDiff(filePath, currentWorkingDir, state.workerRuntime)
        : await getDiff(filePath, currentWorkingDir);

      return {
        messages: [
          makeMessage(proposalMessage),
          makeMessage(diffMessage, "get_diff", `${toolCall.id}-diff`),
        ],
        touchedFiles: [...touchedFiles],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    }
    case "get_diff":
      return {
        messages: [
          makeMessage(
            state.workerRuntime
              ? await getWorkerDiff(filePath, currentWorkingDir, state.workerRuntime)
              : await getDiff(filePath, currentWorkingDir),
          ),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "apply_file_change":
      touchedFiles.add(filePath);
      return {
        messages: [
          makeMessage(
            state.workerRuntime
              ? markWorkerFileReady(filePath, state.workerRuntime)
              : await applyFileChange(filePath, currentWorkingDir),
          ),
        ],
        touchedFiles: [...touchedFiles],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "run_terminal_command": {
      // 并发 Worker 阶段不允许直接在共享工作区执行终端修改或校验，
      // 否则 Merge 节点无法保证隔离性和冲突检测的准确性。
      if (state.workerRuntime) {
        return {
          messages: [
            makeMessage(
              "并发 Modify Worker 阶段禁止直接执行终端命令。请完成文件提案，Merge 落盘后系统会统一执行 Lint / Build / Test。",
            ),
          ],
          touchedFiles: [],
          interactiveRequest: null,
          tokenUsage: createEmptyTokenUsage(),
        };
      }

      const outcome = await runTerminalCommand(
        args.command || "",
        currentWorkingDir,
        state,
      );
      return {
        messages: [
          makeMessage(
            [
              `命令模式: ${outcome.mode === "pty" ? "PTY 交互命令" : "普通命令"}`,
              outcome.output,
            ]
              .filter(Boolean)
              .join("\n\n"),
          ),
        ],
        touchedFiles: [],
        interactiveRequest: outcome.interactiveRequest,
        tokenUsage: outcome.tokenUsage,
      };
    }
    default:
      return {
        messages: [makeMessage(`Unknown tool: ${toolCall.name}`)],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
  }
}

/*
 * 一批工具调用的执行调度器。
 *
 * 设计重点：
 * - 只读工具可以并行，提速；
 * - 写入工具必须串行，避免两个修改互相覆盖。
 *
 * 这其实就是整个 Modify 节点内部的“小型调度器”。
 */
async function executeToolBatch(
  toolCalls: ToolCall[],
  state: ToolRuntimeState,
): Promise<ToolExecutionResult> {
  // 只读工具可以并行，写工具保持串行，避免多个改动互相覆盖。
  const readOnlyTools = new Set([
    "search_project_index",
    "list_directory",
    "search_codebase",
    "read_file_from_disk",
    "read_pdf_from_disk",
    "get_local_time",
  ]);

  const readOnlyCalls = toolCalls.filter((call) => readOnlyTools.has(call.name));
  const mutationCalls = toolCalls.filter((call) => !readOnlyTools.has(call.name));

  const results: ToolExecutionResult[] = [];
  results.push(
    ...(await Promise.all(
      readOnlyCalls.map((call) => executeSingleTool(call, state)),
    )),
  );

  for (const call of mutationCalls) {
    results.push(await executeSingleTool(call, state));
  }

  return {
    messages: results.flatMap((item) => item.messages),
    touchedFiles: Array.from(
      new Set(results.flatMap((item) => item.touchedFiles)),
    ),
    interactiveRequest:
      results.find((item) => item.interactiveRequest)?.interactiveRequest || null,
    tokenUsage: results.reduce(
      (accumulator, item) => mergeTokenUsage(accumulator, item.tokenUsage),
      createEmptyTokenUsage(),
    ),
  };
}

/*
 * Router 是整个图的重置与分流起点。
 *
 * 它不负责理解代码细节，只负责把本轮流程相关的中间状态清空，
 * 然后根据用户请求粗略判断：这轮是否大概率需要进入“代码修改链路”。
 */
export async function routerNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const userRequest = getLatestUserRequest(state);
  return {
    currentUserRequest: userRequest,
    verificationResult: DEFAULT_VERIFICATION_RESULT,
    lintSummary: "",
    finalReportSummary: "",
    mergedContext: "",
    searchContext: "",
    memoryContext: "",
    fileContext: "",
    highLevelPlanRawOutput: "",
    highLevelPlan: DEFAULT_HIGH_LEVEL_PLAN,
    highLevelPlanSummary: "",
    plannerOutput: DEFAULT_PLANNER_PAYLOAD,
    plannerRawOutput: "",
    plannerValidationStatus: "pending" as PlannerValidationStatus,
    plannerValidationMessage: "",
    plannerRetryCount: 0,
    plannerRetryReason: "",
    modifyResults: [],
    mergeResult: DEFAULT_MERGE_RESULT,
    mergedPatchSummary: "",
    structuredTaskListSummary: "",
    reviewPayload: DEFAULT_REVIEW_PAYLOAD,
    reviewFeedback: "",
    reviewDecision: "PASS",
    retryTaskSlots: [],
    reviewIteration: 0,
    interactiveRequest: null,
    touchedFiles: [],
    agentLifecycles: {},
    agentLifecycleEvents: [],
    requiresChanges:
      /(改|修改|重构|优化|修复|实现|新增|持久化|planner|agent)/i.test(
        userRequest,
      ),
  };
}

// SearchAgent 的职责是“广度摸排”。
// 它会结合项目索引和代码库扫描，先告诉后面的 Planner：相关代码可能在哪些地方。
export async function searchAgentNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "search_agent",
    "search_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("EXECUTING", "正在检索项目索引与代码库。" );

  try {
    const userRequest = getLatestUserRequest(state);
    const searchResults = state.projectId
      ? JSON.stringify(
          searchProjectIndex(state.projectId, userRequest).slice(0, 8),
          null,
          2,
        )
      : "当前会话未绑定项目索引。";
    const codebaseResults = await searchCodebase(
      userRequest,
      state.workingDir || process.cwd(),
    );
    tracker.transition("COMPLETED", "项目索引与代码库检索完成。" );

    return {
      searchContext: [
        `用户请求:\n${userRequest}`,
        `项目索引检索:\n${truncateText(searchResults, 3000)}`,
        `代码库扫描:\n${truncateText(codebaseResults, 3000)}`,
      ].join("\n\n"),
      ...buildLifecycleStateUpdate(tracker),
    };
  } catch (error) {
    tracker.transition(
      "FAILED",
      `Search Agent 执行失败: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      searchContext: tracker.getSnapshot().detail,
      ...buildLifecycleStateUpdate(tracker),
    };
  }
}

// MemoryAgent 负责把“历史记忆”和“最近几轮上下文”整理出来。
// 这样 Planner 不会只看当前一句话，而是知道前面做过什么。
export async function memoryAgentNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "memory_agent",
    "memory_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("EXECUTING", "正在整理长期摘要与近期对话上下文。" );

  const memoryContext = [
    `长期对话记忆:\n${state.summary || "暂无长期记忆。"}`,
    `近期会话摘要:\n${
      toConversationText(state.messages, 8) || "暂无近期上下文。"
    }`,
  ].join("\n\n");
  tracker.transition("COMPLETED", "Memory Agent 已完成上下文整理。" );

  return {
    memoryContext,
    ...buildLifecycleStateUpdate(tracker),
  };
}

// FileAgent 的目标是“把用户点名过的路径先预读出来”。
// 如果用户没有给路径，就退回到目录概览，至少让后续节点对项目结构有个感知。
export async function fileAgentNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "file_agent",
    "file_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("EXECUTING", "正在读取用户点名路径或项目目录概览。" );

  try {
    const userRequest = getLatestUserRequest(state);
    const workingDir = state.workingDir || process.cwd();
    const candidatePaths = extractCandidatePaths(userRequest).slice(0, 5);

    if (candidatePaths.length === 0) {
      const fileContext = `未在用户请求中检测到明确文件路径。\n工作目录结构预览:\n${await listDirectory(
        ".",
        workingDir,
      )}`;
      tracker.transition("COMPLETED", "未检测到明确路径，已返回项目根目录概览。" );
      return {
        fileContext,
        ...buildLifecycleStateUpdate(tracker),
      };
    }

    const sections: string[] = [];
    for (const candidatePath of candidatePaths) {
      const safePath = await getSafePath(candidatePath, workingDir);
      if (!fs.existsSync(safePath)) {
        sections.push(`路径不存在: ${candidatePath}`);
        continue;
      }

      const stat = fs.statSync(safePath);
      if (stat.isDirectory()) {
        sections.push(
          `目录 ${candidatePath}:\n${await listDirectory(candidatePath, workingDir)}`,
        );
        continue;
      }

      const content = await readFileFromLocalDisk(candidatePath, workingDir);
      const preview = content.split("\n").slice(0, 120).join("\n");
      sections.push(`文件 ${candidatePath} 预览:\n${preview}`);
    }

    tracker.transition(
      "COMPLETED",
      `File Agent 已处理 ${candidatePaths.length} 个候选路径。`,
    );
    return {
      fileContext: sections.join("\n\n"),
      ...buildLifecycleStateUpdate(tracker),
    };
  } catch (error) {
    tracker.transition(
      "FAILED",
      `File Agent 执行失败: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      fileContext: tracker.getSnapshot().detail,
      ...buildLifecycleStateUpdate(tracker),
    };
  }
}

// 三个上下文 Agent 的结果会在这里汇总成一份 mergedContext。
// 后面的 Planner、Modify、Reviewer 基本都吃这份汇总文本。
export async function mergeContextNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "context_merge",
    "context_merge",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("EXECUTING", "正在合并 Search、Memory 与 File 上下文。" );

  const userRequest = getLatestUserRequest(state);
  const mergedContext = [
    `用户请求:\n${userRequest}`,
    `SearchAgent:\n${state.searchContext || "暂无搜索上下文。"}`,
    `MemoryAgent:\n${state.memoryContext || "暂无记忆上下文。"}`,
    `FileAgent:\n${state.fileContext || "暂无文件上下文。"}`,
  ].join("\n\n");
  tracker.transition("COMPLETED", "多路上下文合并完成。" );

  return {
    mergedContext,
    ...buildLifecycleStateUpdate(tracker),
  };
}

/*
 * Hierarchical Planner 第一层：先形成模块级工作流，不直接猜文件级细节。
 */
export async function highLevelPlanningAgentNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "high_level_planner",
    "high_level_planner",
    state.plannerRetryCount || 0,
    config,
  );
  tracker.transition("PLANNING", "正在生成模块级 High-Level Plan。");

  try {
    const response = await invokeLlm(state, [
      { role: "system", content: HighLevelPlannerPromptText },
      {
        role: "user",
        content: state.mergedContext || getLatestUserRequest(state),
      },
    ], "planner");
    const highLevelPlanRawOutput =
      response.choices?.[0]?.message?.content || "";
    const parsed = parseHighLevelPlanWithSchema(highLevelPlanRawOutput);

    if (!parsed.success) {
      // 第一层失败时保守生成一个 fallback 工作项，让第二层仍可尝试规划。
      const fallbackPlan: HighLevelPlanPayload = [
        {
          id: "fallback",
          objective: getLatestUserRequest(state),
          scope: ["用户明确提出的修改范围"],
          rationale: parsed.message,
          dependencies: [],
          priority: "high",
        },
      ];
      tracker.transition(
        "COMPLETED",
        "High-Level Plan 解析失败，已生成保守 fallback 工作项。",
      );
      return {
        highLevelPlanRawOutput,
        highLevelPlan: fallbackPlan,
        highLevelPlanSummary: [
          parsed.message,
          formatHighLevelPlan(fallbackPlan),
        ].join("\n\n"),
        tokenUsage: buildTokenUsage(response.usage),
        ...buildLifecycleStateUpdate(tracker),
      };
    }

    tracker.transition(
      "COMPLETED",
      `High-Level Planner 已生成 ${parsed.plan.length} 个模块级工作项。`,
    );
    return {
      highLevelPlanRawOutput,
      highLevelPlan: parsed.plan,
      highLevelPlanSummary: [parsed.message, formatHighLevelPlan(parsed.plan)].join(
        "\n\n",
      ),
      tokenUsage: buildTokenUsage(response.usage),
      ...buildLifecycleStateUpdate(tracker),
    };
  } catch (error) {
    tracker.transition(
      "FAILED",
      `High-Level Planner 执行失败: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    const fallbackPlan: HighLevelPlanPayload = [
      {
        id: "fallback",
        objective: getLatestUserRequest(state),
        scope: ["用户明确提出的修改范围"],
        rationale: "High-Level Planner 调用失败，使用保守降级计划。",
        dependencies: [],
        priority: "high",
      },
    ];
    return {
      highLevelPlan: fallbackPlan,
      highLevelPlanSummary: formatHighLevelPlan(fallbackPlan),
      ...buildLifecycleStateUpdate(tracker),
    };
  }
}

/*
 * Hierarchical Planner 第二层：把 High-Level Plan 转换为可安全并发的叶子任务。
 */
export async function planningAgentNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "task_planner",
    "task_planner",
    state.plannerRetryCount || 0,
    config,
  );
  tracker.transition("PLANNING", "正在生成文件级并发叶子任务。");

  try {
    const response = await invokeLlm(state, [
      { role: "system", content: PlannerPromptText },
      {
        role: "user",
        content: [
          `用户与项目上下文:\n${
            state.mergedContext || getLatestUserRequest(state)
          }`,
          `High-Level Plan:\n${JSON.stringify(
            state.highLevelPlan || [],
            null,
            2,
          )}`,
          state.plannerRetryReason
            ? `上一次规划失败原因:\n${state.plannerRetryReason}`
            : "",
          state.plannerRawOutput
            ? `上一次 Task Planner 原始输出:\n${state.plannerRawOutput}`
            : "",
          `当前已重试次数: ${state.plannerRetryCount || 0}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ], "planner");

    const plannerRawOutput = response.choices?.[0]?.message?.content || "";
    tracker.transition("COMPLETED", "Task Planner 已生成待校验叶子任务。");
    return {
      plannerRawOutput,
      plannerValidationStatus: "pending" as PlannerValidationStatus,
      plannerValidationMessage: "等待进入 Task Planner JSON Schema 校验。",
      tokenUsage: buildTokenUsage(response.usage),
      ...buildLifecycleStateUpdate(tracker),
    };
  } catch (error) {
    tracker.transition(
      "FAILED",
      `Task Planner 执行失败: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      plannerRawOutput: "",
      plannerValidationStatus: "schema_invalid" as PlannerValidationStatus,
      plannerValidationMessage: tracker.getSnapshot().detail,
      ...buildLifecycleStateUpdate(tracker),
    };
  }
}

// Planner 第一层正式校验节点。
// 它把原始文本解析成结构化任务数组，并明确写回“校验通过 / 失败”的状态。
export async function plannerSchemaValidationNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const validationResult = parsePlannerPayloadWithSchema(
    state.plannerRawOutput || "",
    state.highLevelPlan || [],
  );

  return {
    plannerOutput: validationResult.success ? validationResult.tasks : DEFAULT_PLANNER_PAYLOAD,
    requiresChanges: validationResult.success ? validationResult.tasks.length > 0 : false,
    plannerValidationStatus: validationResult.success
      ? ("schema_valid" as PlannerValidationStatus)
      : ("schema_invalid" as PlannerValidationStatus),
    plannerValidationMessage: validationResult.message,
  };
}

// Planner 第二层校验节点。
// 目标很明确：阻止多个并发 Modify 去碰同一个文件。
export async function fileUniquenessCheckNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const duplicateFiles = collectDuplicatePlannerFiles(state.plannerOutput || []);

  if (!duplicateFiles.length) {
    return {
      plannerValidationStatus: "files_unique" as PlannerValidationStatus,
      plannerValidationMessage: "文件唯一性检查通过，没有检测到跨任务重复文件。",
    };
  }

  return {
    plannerValidationStatus: "files_duplicated" as PlannerValidationStatus,
    plannerValidationMessage: `文件唯一性检查失败，检测到重复文件: ${duplicateFiles.join(", ")}`,
  };
}

// Retry Planner 不重新生成计划，它只是更新“为什么要重试、当前是第几次重试”。
// 真正的新规划还是下一轮回到 planningAgentNode 里做。
export async function retryPlannerNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const retryStatus = getPlannerRetryStatus(state);
  return {
    plannerRetryCount: retryStatus.nextRetryCount,
    plannerRetryReason:
      state.plannerValidationMessage || "Planner 校验失败，需要重新规划。",
  };
}

// 规则修复是 Planner 的最后一次自动补救：
// 不再信任模型自己纠正，而是直接在程序层面帮它去重整理。
export async function rulesRepairNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const repairedPlan = normalizePlannerTasks(state.plannerOutput || []);
  const duplicateFiles = collectDuplicatePlannerFiles(repairedPlan);

  if (repairedPlan.length > 0 && duplicateFiles.length === 0) {
    return {
      plannerOutput: repairedPlan,
      requiresChanges: true,
      plannerValidationStatus: "rules_repaired" as PlannerValidationStatus,
      plannerValidationMessage:
        "Planner 多次重试后仍有重复文件，已通过规则修复生成唯一文件任务列表。",
    };
  }

  return {
    plannerValidationStatus: "schema_invalid" as PlannerValidationStatus,
    plannerValidationMessage:
      "规则修复后仍无法得到稳定的唯一文件任务列表，将进入单 Agent 降级执行。",
  };
}

// 如果 Planner 怎么都稳定不下来，就降级成单 Agent 串行执行。
// 这样虽然并发能力没了，但至少能保证流程继续往前走。
export async function singleAgentDegradeNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const fallbackPlan = buildSingleAgentFallbackPlan(state);
  return {
    plannerOutput: fallbackPlan,
    requiresChanges: true,
    plannerValidationStatus: "single_agent_degraded" as PlannerValidationStatus,
    plannerValidationMessage:
      "Planner 多次失败后已降级为单 Agent 执行，避免并发任务继续冲突。",
  };
}

// Structured Task List 节点的主要作用是“把机器结构重新整理成人类可读摘要”。
// 这份摘要后面会给 Modify、Final Report，也方便前端/日志查看。
export async function structuredTaskListNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  return {
    structuredTaskListSummary: [
      `Planner 状态: ${state.plannerValidationStatus || "pending"}`,
      `Planner 说明: ${state.plannerValidationMessage || "暂无"}`,
      `Planner 重试次数: ${state.plannerRetryCount || 0}`,
      "",
      "High-Level Plan:",
      JSON.stringify(state.highLevelPlan || [], null, 2),
      "",
      "Structured Task List:",
      JSON.stringify(state.plannerOutput || [], null, 2),
      "",
      formatPlannerPayload(state.plannerOutput || []),
    ].join("\n"),
  };
}

// Retry Dispatcher 本身不做返工，只负责把 Reviewer 指定的返工槽位写回状态。
// 真正执行或跳过返工，是各个 Modify 节点自己判断的。
export async function retryDispatchNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  // 这是一个纯控制节点：只记录 Reviewer 指定的返工槽位，真正是否执行由各 Modify 节点自行判断。
  return {
    retryTaskSlots: resolveRetryTaskSlots(state),
  };
}

/*
 * 动态 Modify Worker。
 *
 * 每次调用都来自一个独立 Send：
 * - 只接收自己的 task 和只读 SharedWorkerMemory；
 * - AI/Tool 消息仅保存在本函数的 runtimeMessages 中；
 * - 不向主图 messages 写入任何 Worker 消息；
 * - 文件修改只暂存在 proposals Map，最终由 Merge 节点统一落盘。
 */
export async function modifyWorkerNode(
  state: ModifyWorkerRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const input = state as unknown as ModifyWorkerInput;
  const { workerId, slot, task, sharedMemory } = input;
  const tracker = createLifecycleTracker(
    workerId,
    "modify_worker",
    input.reviewIteration || 0,
    config,
    slot,
  );
  tracker.transition("PLANNING", `正在准备任务 ${task.id} 的独立执行上下文。`);

  const proposals = new Map<string, WorkerFileChange>();
  const workerRuntime: WorkerToolRuntime = { workerId, slot, proposals };
  let workerMemory: WorkerMemory = {
    ...(input.previousMemory || createDefaultWorkerMemory()),
    completedActions: [...(input.previousMemory?.completedActions || [])],
    pendingActions: [...(input.previousMemory?.pendingActions || [])],
    keyFiles: [...(input.previousMemory?.keyFiles || [])],
    recentObservations: [...(input.previousMemory?.recentObservations || [])],
  };

  const runtimeState = {
    model: input.model,
    workingDir: input.workingDir,
    projectId: input.projectId,
    interactiveRequest: input.interactiveRequest,
    messages: [],
    summary: sharedMemory.summary,
    mergedContext: sharedMemory.mergedContext,
    workerRuntime,
  } as unknown as ToolRuntimeState;

  let runtimeMessages: Array<Record<string, unknown>> = [
    {
      role: "user",
      content: [
        `用户原始需求:\n${sharedMemory.latestUserRequest}`,
        `当前 Worker: ${workerId}`,
        `当前槽位: ${slot + 1}`,
        `当前独立任务:\n${JSON.stringify(task, null, 2)}`,
        `High-Level Plan 摘要:\n${
          sharedMemory.highLevelPlanSummary || "暂无"
        }`,
        `共享只读 Memory:\n${sharedMemory.summary || "暂无长期记忆"}`,
        `合并上下文:\n${truncateText(
          sharedMemory.mergedContext || "暂无",
          5000,
        )}`,
        `前序 Worker 压缩记忆:\n${JSON.stringify(workerMemory, null, 2)}`,
        `Review 轮次: ${input.reviewIteration || 0}`,
        `Reviewer 反馈:\n${input.reviewFeedback || "暂无反馈"}`,
        "执行要求:",
        "1. 只处理当前任务，不读取或推测其他 Worker 的消息和执行过程。",
        "2. 必须先定位并读取真实文件，再生成完整文件内容。",
        "3. 文件闭环使用 propose_file_change -> get_diff -> apply_file_change。",
        "4. apply_file_change 只表示加入 Merge 队列，不会立即覆盖正式文件。",
        "5. 并发 Worker 阶段不要执行终端命令，验证会在 Merge 后统一运行。",
        "6. 尽量只修改 Planner 分配的文件；确需扩散时必须说明原因。",
        "7. 达到上下文阈值后系统会压缩本 Worker 历史，不影响其他 Worker。",
      ].join("\n\n"),
    },
  ];
  const totalUsage = createEmptyTokenUsage();
  let toolRound = workerMemory.lastCompressedRound || 0;
  tracker.transition("EXECUTING", `开始执行并发任务 ${task.id}。`);

  const buildResultUpdate = (
    summary: string,
    status: ModifyTaskResult["status"],
    interactiveRequest: InteractiveRequest | null = null,
  ): Record<string, unknown> => {
    const changes = Array.from(proposals.values()).sort((left, right) =>
      left.filePath.localeCompare(right.filePath),
    );
    const lifecycleUpdate = buildLifecycleStateUpdate(tracker);
    return {
      modifyResults: [
        buildModifyResult(
          workerId,
          slot,
          task,
          summary,
          status,
          changes,
          workerMemory,
          tracker.getSnapshot(),
          [...tracker.events],
          interactiveRequest,
        ),
      ],
      tokenUsage: totalUsage,
      ...lifecycleUpdate,
    };
  };

  try {
    for (let attempt = 0; attempt < MAX_WORKER_TOOL_ROUNDS; attempt += 1) {
      const response = await invokeLlm(
        runtimeState,
        [
          {
            role: "system",
            content: ModifyWorkerPromptText,
          },
          ...runtimeMessages,
        ],
        "worker",
        true,
      );

      const usage = buildTokenUsage(response.usage);
      totalUsage.prompt += usage.prompt;
      totalUsage.completion += usage.completion;
      totalUsage.total += usage.total;

      const assistantMessage = response.choices?.[0]?.message;
      const toolCalls = assistantMessage?.tool_calls || [];

      if (toolCalls.length > 0) {
        const toolNames = toolCalls.map((item) => item.function.name);
        tracker.transition(
          "WAITING_TOOL",
          `正在执行工具: ${toolNames.join(", ")}`,
          toolNames.join(","),
        );
        runtimeMessages.push({
          role: "assistant",
          content: assistantMessage?.content || "",
          tool_calls: toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          })),
        });

        const executed = await executeToolBatch(
          toolCalls.map((toolCall) => {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(toolCall.function.arguments || "{}") as Record<
                string,
                unknown
              >;
            } catch {
              args = {};
            }
            return {
              id: toolCall.id,
              name: toolCall.function.name,
              args,
            };
          }),
          runtimeState,
        );

        const mergedToolUsage = mergeTokenUsage(totalUsage, executed.tokenUsage);
        totalUsage.prompt = mergedToolUsage.prompt;
        totalUsage.completion = mergedToolUsage.completion;
        totalUsage.total = mergedToolUsage.total;

        executed.messages.forEach((message) => {
          runtimeMessages.push({
            role: "tool",
            content: normalizeContent(message.content),
            tool_call_id: message.tool_call_id,
          });
        });
        toolRound += 1;
        tracker.transition(
          "EXECUTING",
          `第 ${toolRound} 轮工具执行完成，继续判断下一步。`,
        );

        if (executed.interactiveRequest) {
          const decoratedRequest: InteractiveRequest = {
            ...executed.interactiveRequest,
            workerId,
            slot,
          };
          tracker.transition("BLOCKED", "Worker 正在等待交互式终端输入。");
          return buildResultUpdate(
            [
              `${workerId} 被交互式命令暂停。`,
              `命令: ${decoratedRequest.command}`,
              `提示: ${decoratedRequest.prompt}`,
            ].join("\n"),
            "blocked",
            decoratedRequest,
          );
        }

        if (
          shouldCompressWorkerMemory(runtimeMessages, toolRound, workerMemory)
        ) {
          tracker.transition(
            "COMPRESSING",
            `正在压缩 ${workerId} 的独立工具上下文。`,
          );
          try {
            const compressed = await compressWorkerMemory(
              runtimeState,
              task,
              workerMemory,
              runtimeMessages,
              toolRound,
            );
            workerMemory = compressed.memory;
            const mergedCompressionUsage = mergeTokenUsage(
              totalUsage,
              compressed.tokenUsage,
            );
            totalUsage.prompt = mergedCompressionUsage.prompt;
            totalUsage.completion = mergedCompressionUsage.completion;
            totalUsage.total = mergedCompressionUsage.total;
            runtimeMessages = [
              buildWorkerContinuationMessage(
                task,
                sharedMemory,
                workerMemory,
                input.reviewFeedback,
              ),
            ];
            tracker.transition(
              "EXECUTING",
              `Worker Memory 第 ${workerMemory.compressionCount} 次压缩完成。`,
            );
          } catch (compressionError) {
            workerMemory = {
              ...workerMemory,
              recentObservations: [
                ...workerMemory.recentObservations,
                `上下文压缩失败: ${
                  compressionError instanceof Error
                    ? compressionError.message
                    : String(compressionError)
                }`,
              ].slice(-8),
            };
            tracker.transition(
              "EXECUTING",
              "Worker Memory 压缩失败，保留当前上下文继续执行。",
            );
          }
        }
        continue;
      }

      const changes = Array.from(proposals.values()).sort((left, right) =>
        left.filePath.localeCompare(right.filePath),
      );
      const unreadyChanges = changes.filter((change) => !change.ready);
      const baseSummary =
        assistantMessage?.content?.trim() || `${workerId} 已完成当前任务。`;

      if (changes.length === 0) {
        tracker.transition(
          "FAILED",
          "Worker 未生成任何文件提案，无法证明当前修改任务已经完成。",
        );
        return buildResultUpdate(
          `${baseSummary}\n当前任务未产生文件提案。`,
          "failed",
        );
      }

      if (unreadyChanges.length) {
        tracker.transition(
          "FAILED",
          `存在 ${unreadyChanges.length} 个提案未加入 Merge 队列。`,
        );
        return buildResultUpdate(
          `${baseSummary}\n存在 ${unreadyChanges.length} 个提案未调用 apply_file_change，暂不允许 Merge 落盘。`,
          "failed",
        );
      }

      tracker.transition(
        "READY_TO_MERGE",
        `已生成 ${changes.length} 个可合并文件提案。`,
      );
      tracker.transition(
        "COMPLETED",
        `Worker ${workerId} 执行完成，等待 Merge。`,
      );
      return buildResultUpdate(baseSummary, "done");
    }

    tracker.transition("FAILED", "达到最大工具轮次，Worker 未能稳定收尾。");
    return buildResultUpdate(
      "达到最大工具轮次，Worker 未能稳定收尾。",
      "failed",
    );
  } catch (error) {
    tracker.transition(
      "FAILED",
      `Worker 执行失败: ${error instanceof Error ? error.message : String(error)}`,
    );
    return buildResultUpdate(tracker.getSnapshot().detail, "failed");
  }
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values)).sort((left, right) => left - right);
}

type ContiguousLineEdit = {
  start: number;
  end: number;
  replacement: string[];
};

function computeContiguousLineEdit(
  baseContent: string,
  proposedContent: string,
): ContiguousLineEdit | null {
  if (baseContent === proposedContent) return null;
  const baseLines = baseContent.split("\n");
  const proposedLines = proposedContent.split("\n");

  let prefix = 0;
  while (
    prefix < baseLines.length &&
    prefix < proposedLines.length &&
    baseLines[prefix] === proposedLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < baseLines.length - prefix &&
    suffix < proposedLines.length - prefix &&
    baseLines[baseLines.length - 1 - suffix] ===
      proposedLines[proposedLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    start: prefix,
    end: baseLines.length - suffix,
    replacement: proposedLines.slice(prefix, proposedLines.length - suffix),
  };
}

function lineEditsOverlap(
  left: ContiguousLineEdit,
  right: ContiguousLineEdit,
): boolean {
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;

  // 对插入点采用保守判断：只要落在另一修改区间的边界或内部，就拒绝自动合并。
  if (leftInsertion) {
    return left.start >= right.start && left.start <= right.end;
  }
  if (rightInsertion) {
    return right.start >= left.start && right.start <= left.end;
  }
  return !(left.end <= right.start || right.end <= left.start);
}

function tryThreeWayMergeChanges(
  changes: WorkerFileChange[],
): { merged: WorkerFileChange | null; conflict: MergeConflict | null } {
  const filePath = changes[0]?.filePath;
  const workerIds = Array.from(
    new Set(changes.flatMap((change) => change.sourceWorkerIds)),
  );
  const slots = uniqueNumbers(
    changes.flatMap((change) => change.sourceSlots),
  );

  if (!filePath || !changes.length) {
    return {
      merged: null,
      conflict: {
        type: "invalid_patch",
        filePath,
        workerIds,
        slots,
        message: "Merge 收到空文件提案组。",
      },
    };
  }

  const baseHashes = new Set(changes.map((change) => change.baseContentHash));
  const baseContents = new Set(
    changes.map((change) => change.baseContent ?? "<FILE_NOT_EXISTS>"),
  );
  if (baseHashes.size !== 1 || baseContents.size !== 1) {
    return {
      merged: null,
      conflict: {
        type: "base_mismatch",
        filePath,
        workerIds,
        slots,
        message: `多个 Worker 对 ${filePath} 使用了不同基线，无法三方合并。`,
      },
    };
  }

  const baseContent = changes[0].baseContent;
  if (baseContent === null) {
    return {
      merged: null,
      conflict: {
        type: "same_file",
        filePath,
        workerIds,
        slots,
        message: `多个 Worker 同时创建新文件且内容不同: ${filePath}`,
      },
    };
  }

  const edits = changes
    .map((change) => ({
      change,
      edit: computeContiguousLineEdit(baseContent, change.proposedContent),
    }))
    .filter(
      (item): item is { change: WorkerFileChange; edit: ContiguousLineEdit } =>
        item.edit !== null,
    );

  for (let leftIndex = 0; leftIndex < edits.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < edits.length;
      rightIndex += 1
    ) {
      if (lineEditsOverlap(edits[leftIndex].edit, edits[rightIndex].edit)) {
        return {
          merged: null,
          conflict: {
            type: "overlapping_patch",
            filePath,
            workerIds,
            slots,
            message: `多个 Worker 对 ${filePath} 的修改区间重叠，拒绝自动合并。`,
          },
        };
      }
    }
  }

  const mergedLines = baseContent.split("\n");
  [...edits]
    .sort((left, right) => right.edit.start - left.edit.start)
    .forEach(({ edit }) => {
      mergedLines.splice(
        edit.start,
        edit.end - edit.start,
        ...edit.replacement,
      );
    });
  const proposedContent = mergedLines.join("\n");

  return {
    merged: {
      workerId: "merge_agent",
      slot: Math.min(...slots),
      filePath,
      baseExists: changes[0].baseExists,
      baseContent,
      baseContentHash: changes[0].baseContentHash,
      proposedContentHash: hashContent(proposedContent),
      proposedContent,
      ready: true,
      sourceWorkerIds: workerIds,
      sourceSlots: slots,
      mergeStrategy: "three_way_disjoint",
    },
    conflict: null,
  };
}

function resolveSameFileGroups(
  results: ModifyTaskResult[],
): {
  selectedChanges: WorkerFileChange[];
  conflicts: MergeConflict[];
  autoMergedFiles: string[];
  deduplicatedFiles: string[];
} {
  const groups = new Map<string, WorkerFileChange[]>();
  results
    .flatMap((result) => result.fileChanges.filter((change) => change.ready))
    .forEach((change) => {
      const key = normalizeFileKey(change.filePath);
      groups.set(key, [...(groups.get(key) || []), change]);
    });

  const selectedChanges: WorkerFileChange[] = [];
  const conflicts: MergeConflict[] = [];
  const autoMergedFiles: string[] = [];
  const deduplicatedFiles: string[] = [];

  groups.forEach((changes) => {
    if (changes.length === 1) {
      selectedChanges.push(changes[0]);
      return;
    }

    const uniqueByProposedHash = Array.from(
      new Map(
        changes.map((change) => [change.proposedContentHash, change]),
      ).values(),
    );
    if (uniqueByProposedHash.length === 1) {
      const selected = uniqueByProposedHash[0];
      selectedChanges.push({
        ...selected,
        sourceWorkerIds: Array.from(
          new Set(changes.flatMap((change) => change.sourceWorkerIds)),
        ),
        sourceSlots: uniqueNumbers(
          changes.flatMap((change) => change.sourceSlots),
        ),
        mergeStrategy: "identical_deduplicated",
      });
      deduplicatedFiles.push(selected.filePath);
      return;
    }

    const resolved = tryThreeWayMergeChanges(uniqueByProposedHash);
    if (resolved.merged) {
      selectedChanges.push(resolved.merged);
      autoMergedFiles.push(resolved.merged.filePath);
      return;
    }
    if (resolved.conflict) conflicts.push(resolved.conflict);
  });

  return {
    selectedChanges,
    conflicts,
    autoMergedFiles,
    deduplicatedFiles,
  };
}

async function detectWorkspaceConflicts(
  changes: WorkerFileChange[],
  workingDir: string,
): Promise<{
  changesToApply: WorkerFileChange[];
  alreadyAppliedFiles: string[];
  conflicts: MergeConflict[];
}> {
  const changesToApply: WorkerFileChange[] = [];
  const alreadyAppliedFiles: string[] = [];
  const conflicts: MergeConflict[] = [];

  for (const change of changes) {
    const current = await readRawFile(change.filePath, workingDir);
    const currentHash = hashContent(current.content);

    if (currentHash === change.proposedContentHash) {
      alreadyAppliedFiles.push(change.filePath);
      continue;
    }

    if (currentHash !== change.baseContentHash) {
      conflicts.push({
        type: "workspace_changed",
        filePath: change.filePath,
        workerIds: change.sourceWorkerIds,
        slots: change.sourceSlots,
        message: `Worker 执行期间正式文件发生变化，拒绝覆盖: ${change.filePath}`,
      });
      continue;
    }

    changesToApply.push(change);
  }

  return { changesToApply, alreadyAppliedFiles, conflicts };
}

async function applyMergedChanges(
  changes: WorkerFileChange[],
  workingDir: string,
): Promise<{ appliedFiles: string[]; error: Error | null }> {
  const backups = new Map<
    string,
    { safePath: string; existed: boolean; content: string | null }
  >();
  const appliedFiles: string[] = [];

  try {
    for (const change of changes) {
      const safePath = await getSafePath(change.filePath, workingDir);
      const existed = fs.existsSync(safePath);
      backups.set(change.filePath, {
        safePath,
        existed,
        content: existed ? fs.readFileSync(safePath, "utf-8") : null,
      });

      fs.mkdirSync(path.dirname(safePath), { recursive: true });
      fs.writeFileSync(safePath, change.proposedContent, "utf-8");
      appliedFiles.push(change.filePath);
    }
    return { appliedFiles, error: null };
  } catch (error) {
    // 尽可能回滚本次 Merge 已写入的文件，避免半合并状态。
    for (const [filePath, backup] of Array.from(backups.entries()).reverse()) {
      try {
        if (backup.existed) {
          fs.writeFileSync(backup.safePath, backup.content || "", "utf-8");
        } else if (fs.existsSync(backup.safePath)) {
          fs.unlinkSync(backup.safePath);
        }
      } catch {
        // 回滚错误会在最终 apply_failed 冲突中体现。
      }
      if (!appliedFiles.includes(filePath)) continue;
    }
    return {
      appliedFiles: [],
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

async function mergeParallelWorkerResults(
  state: AgentRuntimeState,
): Promise<{ mergeResult: MergeResult; interactiveRequest: InteractiveRequest | null }> {
  const results = [...(state.modifyResults || [])].sort(
    (left, right) => left.slot - right.slot,
  );
  const blockedResult = results.find((result) => result.status === "blocked");
  if (blockedResult) {
    const mergeResult: MergeResult = {
      ...DEFAULT_MERGE_RESULT,
      status: "blocked",
      summary: `并发 Worker 尚未全部完成，${blockedResult.workerId} 正在等待交互。`,
    };
    return {
      mergeResult,
      interactiveRequest: blockedResult.interactiveRequest || null,
    };
  }

  const failedResults = results.filter((result) => result.status === "failed");
  const workerFailures: MergeConflict[] = failedResults.map((result) => ({
    type: "worker_failed",
    workerIds: [result.workerId],
    slots: [result.slot],
    message: `${result.workerId} 未能产生可安全合并的完整结果: ${result.summary}`,
  }));

  const sameFileCheck = resolveSameFileGroups(results);
  const workspaceCheck = await detectWorkspaceConflicts(
    sameFileCheck.selectedChanges,
    state.workingDir || process.cwd(),
  );
  const conflicts = [
    ...workerFailures,
    ...sameFileCheck.conflicts,
    ...workspaceCheck.conflicts,
  ];

  if (conflicts.length) {
    return {
      mergeResult: {
        status: "conflict",
        appliedFiles: [],
        alreadyAppliedFiles: workspaceCheck.alreadyAppliedFiles,
        autoMergedFiles: sameFileCheck.autoMergedFiles,
        deduplicatedFiles: sameFileCheck.deduplicatedFiles,
        skippedFiles: sameFileCheck.selectedChanges.map((item) => item.filePath),
        conflicts,
        summary: `检测到 ${conflicts.length} 个冲突/失败项，本轮未写入新的正式文件。`,
      },
      interactiveRequest: null,
    };
  }

  const applyResult = await applyMergedChanges(
    workspaceCheck.changesToApply,
    state.workingDir || process.cwd(),
  );
  if (applyResult.error) {
    const slots = uniqueNumbers(
      workspaceCheck.changesToApply.flatMap(
        (change) => change.sourceSlots,
      ),
    );
    return {
      mergeResult: {
        status: "failed",
        appliedFiles: [],
        alreadyAppliedFiles: workspaceCheck.alreadyAppliedFiles,
        autoMergedFiles: sameFileCheck.autoMergedFiles,
        deduplicatedFiles: sameFileCheck.deduplicatedFiles,
        skippedFiles: workspaceCheck.changesToApply.map((item) => item.filePath),
        conflicts: [
          {
            type: "apply_failed",
            workerIds: Array.from(
              new Set(
                workspaceCheck.changesToApply.flatMap(
                  (change) => change.sourceWorkerIds,
                ),
              ),
            ),
            slots,
            message: `Merge 写入失败并已尝试回滚: ${applyResult.error.message}`,
          },
        ],
        summary: "Merge 写入正式工作区失败。",
      },
      interactiveRequest: null,
    };
  }

  return {
    mergeResult: {
      status: "success",
      appliedFiles: applyResult.appliedFiles,
      alreadyAppliedFiles: workspaceCheck.alreadyAppliedFiles,
      autoMergedFiles: sameFileCheck.autoMergedFiles,
      deduplicatedFiles: sameFileCheck.deduplicatedFiles,
      skippedFiles: [],
      conflicts: [],
      summary: `并发 Merge 完成：新写入 ${applyResult.appliedFiles.length} 个文件，自动三方合并 ${sameFileCheck.autoMergedFiles.length} 个文件，相同提案去重 ${sameFileCheck.deduplicatedFiles.length} 个文件，已处于目标内容 ${workspaceCheck.alreadyAppliedFiles.length} 个文件。`,
    },
    interactiveRequest: null,
  };
}

// Merge 节点统一负责：合并提案、检测冲突、写入正式文件、汇总结果。
export async function mergePatchNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    `merge_agent_${state.reviewIteration || 0}`,
    "merge_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition(
    "MERGING",
    `正在合并 ${(state.modifyResults || []).length} 个 Worker 结果。`,
  );

  const { mergeResult, interactiveRequest } =
    await mergeParallelWorkerResults(state);
  const touchedFiles = Array.from(
    new Set([
      ...mergeResult.appliedFiles,
      ...mergeResult.alreadyAppliedFiles,
    ]),
  );
  const mergedPatchSummary = [
    `High-Level Plan:\n${JSON.stringify(state.highLevelPlan || [], null, 2)}`,
    `Planner 任务数组:\n${JSON.stringify(state.plannerOutput || [], null, 2)}`,
    `Modify Worker 汇总:\n${formatModifyResults(state.modifyResults || [])}`,
    `Merge 结果:\n${JSON.stringify(mergeResult, null, 2)}`,
  ].join("\n\n");

  if (mergeResult.status === "blocked") {
    tracker.transition("BLOCKED", mergeResult.summary);
  } else if (
    mergeResult.status === "conflict" ||
    mergeResult.status === "failed"
  ) {
    tracker.transition("FAILED", mergeResult.summary);
  } else {
    tracker.transition("COMPLETED", mergeResult.summary);
  }

  return {
    mergeResult,
    mergedPatchSummary,
    touchedFiles,
    interactiveRequest,
    ...buildLifecycleStateUpdate(tracker),
  };
}

/*
 * Reviewer Agent 是“执行阶段的质量闸门”。
 *
 * 它要回答三个问题：
 * 1. 现在的修改能不能过；
 * 2. 具体哪里不够好；
 * 3. 如果要返工，到底返工哪一个任务槽位。
 *
 * 这样就能做到动态 Worker 的局部返工，而不是让全部任务重新执行。
 */
export async function reviewerAgentNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    `reviewer_agent_${state.reviewIteration || 0}`,
    "reviewer_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("REVIEWING", "正在统一审查并发 Worker 与 Merge 结果。" );

  const complete = (update: Record<string, unknown>, detail: string) => {
    tracker.transition("COMPLETED", detail);
    return { ...update, ...buildLifecycleStateUpdate(tracker) };
  };
  const fail = (update: Record<string, unknown>, detail: string) => {
    tracker.transition("FAILED", detail);
    return { ...update, ...buildLifecycleStateUpdate(tracker) };
  };

  if (!state.requiresChanges || !(state.plannerOutput || []).length) {
    return complete(
      {
        reviewPayload: DEFAULT_REVIEW_PAYLOAD,
        reviewFeedback: "",
        reviewDecision: "PASS",
        retryTaskSlots: [],
      },
      "当前请求无需代码修改，Reviewer 直接通过。",
    );
  }

  if (state.interactiveRequest || state.mergeResult?.status === "blocked") {
    tracker.transition("BLOCKED", "存在待处理交互请求，Reviewer 暂停。" );
    return {
      reviewPayload: {
        decision: "PASS",
        feedback: "存在待处理的交互式命令请求，本轮暂停统一 Review，等待用户继续。",
        risks: ["至少一个并发 Worker 尚未真正完成，当前结果仅为中间态。"],
        retryTasks: [],
      },
      reviewFeedback: "存在挂起的交互请求，Reviewer 暂不继续返工判断。",
      reviewDecision: "PASS",
      retryTaskSlots: [],
      ...buildLifecycleStateUpdate(tracker),
    };
  }

  if (
    state.mergeResult?.status === "conflict" ||
    state.mergeResult?.status === "failed"
  ) {
    const retryTaskSlots = uniqueNumbers(
      (state.mergeResult.conflicts || []).flatMap((conflict) => conflict.slots),
    );
    const feedback = [
      "Merge 阶段检测到并发冲突或 Worker 失败。",
      ...(state.mergeResult.conflicts || []).map((item) => item.message),
    ].join("\n");

    if (
      (state.reviewIteration || 0) < MAX_REVIEW_RETRIES &&
      retryTaskSlots.length
    ) {
      return complete(
        {
          reviewPayload: {
            decision: "RETRY",
            feedback,
            risks: (state.mergeResult.conflicts || []).map(
              (item) => item.message,
            ),
            retryTasks: retryTaskSlots,
          },
          reviewFeedback: feedback,
          reviewDecision: "RETRY",
          retryTaskSlots,
          reviewIteration: (state.reviewIteration || 0) + 1,
        },
        `Reviewer 要求返工槽位: ${formatRetryTasks(retryTaskSlots)}`,
      );
    }

    return fail(
      {
        reviewPayload: {
          decision: "FAIL",
          feedback: `${feedback}\nMerge 冲突尚未解决，自动流程不会把本轮标记为成功。`,
          risks: (state.mergeResult.conflicts || []).map(
            (item) => item.message,
          ),
          retryTasks: [],
        },
        reviewFeedback: feedback,
        reviewDecision: "FAIL",
        retryTaskSlots: [],
      },
      retryTaskSlots.length
        ? "已达到最大返工轮次，Merge 冲突仍未解决。"
        : "Merge 冲突无法映射到可返工 Worker，需人工处理。",
    );
  }

  try {
    const reviewFiles = Array.from(new Set(state.touchedFiles || []));
    const filePreview = await buildFilePreview(
      reviewFiles.length
        ? reviewFiles
        : (state.plannerOutput || []).flatMap((task: PlanTask) => task.files),
      state.workingDir || process.cwd(),
      80,
    );

    const response = await invokeLlm(state, [
      { role: "system", content: ReviewerPromptText },
      {
        role: "user",
        content: [
          `用户请求:\n${getLatestUserRequest(state)}`,
          `High-Level Plan:\n${JSON.stringify(
            state.highLevelPlan || [],
            null,
            2,
          )}`,
          `Planner 任务数组:\n${JSON.stringify(
            state.plannerOutput || [],
            null,
            2,
          )}`,
          `Modify 结果:\n${formatModifyResults(state.modifyResults || [])}`,
          `Merged Patch:\n${state.mergedPatchSummary || "暂无"}`,
          `工程验证:
${JSON.stringify(
            state.verificationResult || DEFAULT_VERIFICATION_RESULT,
            null,
            2,
          )}`,
          `当前 Review 轮次: ${state.reviewIteration || 0}`,
          `当前文件快照:\n${filePreview || "暂无文件快照"}`,
        ].join("\n\n"),
      },
    ], "reviewer");

    const payload = safeParseReviewPayload(
      response.choices?.[0]?.message?.content || "",
    );
    const tokenUsage = buildTokenUsage(response.usage);

    if (payload.decision === "FAIL") {
      return fail(
        {
          reviewPayload: payload,
          reviewFeedback: payload.feedback,
          reviewDecision: "FAIL",
          retryTaskSlots: [],
          tokenUsage,
        },
        payload.feedback || "Reviewer 判断当前修改不可安全通过。",
      );
    }

    if (payload.decision === "RETRY") {
      const retryTaskSlots = payload.retryTasks.length
        ? uniqueNumbers(payload.retryTasks)
        : state.verificationResult?.overall === "failed"
          ? (state.plannerOutput || []).map((_task: PlanTask, slot: number) => slot)
          : resolveRetryTaskSlots(state);

      if (
        (state.reviewIteration || 0) < MAX_REVIEW_RETRIES &&
        retryTaskSlots.length
      ) {
        return complete(
          {
            reviewPayload: { ...payload, retryTasks: retryTaskSlots },
            reviewFeedback: payload.feedback,
            reviewDecision: "RETRY",
            retryTaskSlots,
            reviewIteration: (state.reviewIteration || 0) + 1,
            tokenUsage,
          },
          `Reviewer 要求定向返工: ${formatRetryTasks(retryTaskSlots)}`,
        );
      }

      return fail(
        {
          reviewPayload: {
            ...payload,
            decision: "FAIL",
            feedback: [
              payload.feedback,
              retryTaskSlots.length
                ? "已达到最大返工轮次。"
                : "Reviewer 未能给出有效返工槽位。",
            ]
              .filter(Boolean)
              .join("\n"),
            retryTasks: [],
          },
          reviewFeedback: payload.feedback,
          reviewDecision: "FAIL",
          retryTaskSlots: [],
          tokenUsage,
        },
        "Reviewer 返工请求无法继续安全执行。",
      );
    }

    return complete(
      {
        reviewPayload: payload,
        reviewFeedback: payload.feedback,
        reviewDecision: "PASS",
        retryTaskSlots: [],
        tokenUsage,
      },
      "Unified Reviewer 已完成审查并通过。",
    );
  } catch (error) {
    const detail = `Reviewer 调用失败: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return fail(
      {
        reviewPayload: {
          decision: "FAIL",
          feedback: detail,
          risks: ["Reviewer 模型调用失败，需要人工复查。"],
          retryTasks: [],
        },
        reviewFeedback: detail,
        reviewDecision: "FAIL",
        retryTaskSlots: [],
      },
      detail,
    );
  }
}

// 这个节点负责真实工程校验，而不是模型主观判断。
// 也就是常说的“最后再跑一遍 lint / build / test 看看有没有真炸”。
function detectProjectPackageManager(workingDir: string): {
  name: "pnpm" | "npm" | "yarn" | "bun";
  runScript: (script: string) => string;
  runBinary: (binary: string, args: string) => string;
} {
  if (fs.existsSync(path.join(workingDir, "pnpm-lock.yaml"))) {
    return {
      name: "pnpm",
      runScript: (script) => `pnpm run ${script}`,
      runBinary: (binary, args) => `pnpm exec ${binary} ${args}`.trim(),
    };
  }
  if (
    fs.existsSync(path.join(workingDir, "bun.lockb")) ||
    fs.existsSync(path.join(workingDir, "bun.lock"))
  ) {
    return {
      name: "bun",
      runScript: (script) => `bun run ${script}`,
      runBinary: (binary, args) => `bunx ${binary} ${args}`.trim(),
    };
  }
  if (fs.existsSync(path.join(workingDir, "yarn.lock"))) {
    return {
      name: "yarn",
      runScript: (script) => `yarn ${script}`,
      runBinary: (binary, args) => `yarn ${binary} ${args}`.trim(),
    };
  }
  return {
    name: "npm",
    runScript: (script) => `npm run ${script}`,
    runBinary: (binary, args) => `npx ${binary} ${args}`.trim(),
  };
}

export async function lintBuildTestNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "verification_agent",
    "verification_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("VERIFYING", "正在执行 Lint / Build / Test 工程验证。" );

  const buildCheck = (
    status: VerificationCheckResult["status"],
    command: string | null,
    output: string,
  ): VerificationCheckResult => ({ status, command, output });

  const formatVerification = (result: VerificationResult): string =>
    [
      `Package Manager:\n${result.packageManager}`,
      `Overall:\n${result.overall}`,
      `Lint [${result.lint.status}]${
        result.lint.command ? ` (${result.lint.command})` : ""
      }:\n${truncateText(result.lint.output, 3000)}`,
      `Build [${result.build.status}]${
        result.build.command ? ` (${result.build.command})` : ""
      }:\n${truncateText(result.build.output, 3000)}`,
      `Test [${result.test.status}]${
        result.test.command ? ` (${result.test.command})` : ""
      }:\n${truncateText(result.test.output, 3000)}`,
      `Summary:\n${result.summary}`,
    ].join("\n\n");

  if (state.interactiveRequest) {
    const verificationResult: VerificationResult = {
      ...DEFAULT_VERIFICATION_RESULT,
      lint: buildCheck("blocked", null, "存在挂起交互请求，暂不执行 lint。"),
      build: buildCheck("blocked", null, "存在挂起交互请求，暂不执行 build。"),
      test: buildCheck("blocked", null, "存在挂起交互请求，暂不执行 test。"),
      overall: "blocked",
      summary: "存在挂起交互请求，工程验证已暂停。",
    };
    tracker.transition("BLOCKED", verificationResult.summary);
    return {
      verificationResult,
      lintSummary: formatVerification(verificationResult),
      ...buildLifecycleStateUpdate(tracker),
    };
  }

  if (
    state.mergeResult?.status === "conflict" ||
    state.mergeResult?.status === "failed"
  ) {
    const verificationResult: VerificationResult = {
      ...DEFAULT_VERIFICATION_RESULT,
      lint: buildCheck("blocked", null, "Merge 未成功，未执行 lint。"),
      build: buildCheck("blocked", null, "Merge 未成功，未执行 build。"),
      test: buildCheck("blocked", null, "Merge 未成功，未执行 test。"),
      overall: "blocked",
      summary: "Merge 冲突或写入失败，工程验证不会在不确定工作区上运行。",
    };
    tracker.transition("BLOCKED", verificationResult.summary);
    return {
      verificationResult,
      lintSummary: formatVerification(verificationResult),
      ...buildLifecycleStateUpdate(tracker),
    };
  }

  if (!state.requiresChanges) {
    const verificationResult: VerificationResult = {
      ...DEFAULT_VERIFICATION_RESULT,
      summary: "当前请求无需代码修改，跳过工程验证。",
    };
    tracker.transition("COMPLETED", verificationResult.summary);
    return {
      verificationResult,
      lintSummary: formatVerification(verificationResult),
      ...buildLifecycleStateUpdate(tracker),
    };
  }

  const touchedFiles = state.touchedFiles || [];
  const workingDir = state.workingDir || process.cwd();
  const packageJsonPath = path.join(workingDir, "package.json");
  const packageManager = detectProjectPackageManager(workingDir);
  const lintableFiles = touchedFiles.filter((file: string) =>
    [".ts", ".tsx", ".js", ".jsx"].includes(path.extname(file)),
  );

  let scripts: Record<string, string> = {};
  let packageJsonError = "";
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(packageJsonPath, "utf-8"),
      ) as { scripts?: Record<string, string> };
      scripts = packageJson.scripts || {};
    } catch (error) {
      packageJsonError = `package.json 解析失败: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  } else {
    packageJsonError = "未找到 package.json。";
  }

  let lint = buildCheck(
    "skipped",
    null,
    lintableFiles.length
      ? "尚未执行 lint。"
      : "没有需要单文件 lint 的 JS/TS 变更。",
  );
  if (lintableFiles.length > 0) {
    const quotedFiles = lintableFiles.map((file: string) => `"${file}"`).join(" ");
    const command = packageManager.runBinary("eslint", quotedFiles);
    const outcome = await runTerminalCommand(
      command,
      workingDir,
      state,
      120_000,
    );
    lint = buildCheck(
      outcome.success ? "passed" : "failed",
      command,
      outcome.output || (outcome.success ? "Lint 成功。" : "Lint 失败。"),
    );
  }

  let build = buildCheck(
    "skipped",
    null,
    packageJsonError || "未配置 build 脚本，跳过。",
  );
  if (scripts.build) {
    const command = packageManager.runScript("build");
    const outcome = await runTerminalCommand(
      command,
      workingDir,
      state,
      120_000,
    );
    build = buildCheck(
      outcome.success ? "passed" : "failed",
      command,
      outcome.output || (outcome.success ? "Build 成功。" : "Build 失败。"),
    );
  }

  let test = buildCheck(
    "skipped",
    null,
    packageJsonError || "未配置 test 脚本，跳过。",
  );
  if (scripts.test) {
    const command = packageManager.runScript("test");
    const outcome = await runTerminalCommand(
      command,
      workingDir,
      state,
      120_000,
    );
    test = buildCheck(
      outcome.success ? "passed" : "failed",
      command,
      outcome.output || (outcome.success ? "Test 成功。" : "Test 失败。"),
    );
  }

  const checks = [lint, build, test];
  const overall: VerificationResult["overall"] = checks.some(
    (item) => item.status === "failed",
  )
    ? "failed"
    : checks.some((item) => item.status === "passed")
      ? "passed"
      : "skipped";
  const verificationResult: VerificationResult = {
    packageManager: packageManager.name,
    lint,
    build,
    test,
    overall,
    summary:
      overall === "failed"
        ? "工程验证存在失败项，必须由最终 Reviewer 决定返工或终止。"
        : overall === "passed"
          ? "已执行的工程验证全部通过。"
          : "项目未提供可执行的验证项，本轮验证已跳过。",
  };

  if (overall === "failed") {
    tracker.transition("FAILED", verificationResult.summary);
  } else {
    tracker.transition("COMPLETED", verificationResult.summary);
  }

  return {
    verificationResult,
    lintSummary: formatVerification(verificationResult),
    ...buildLifecycleStateUpdate(tracker),
  };
}

/*
 * Final Report 节点负责把前面所有结构化结果收束成最终结论。
 *
 * 你可以把它理解成“交付总结器”：
 * - Planner 说原计划是什么；
 * - Modify 说具体做了什么；
 * - Reviewer 说是否返工过；
 * - Lint / Build / Test 说工程验证结果如何；
 * 最后统一组织成给用户看的 Markdown 报告。
 */
export async function finalReportNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "final_report_agent",
    "final_report_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("EXECUTING", "正在汇总完整 Agent 执行结果。" );

  try {
    const response = await invokeLlm(state, [
      {
        role: "system",
        content: FinalReportAgentPromptText,
      },
      {
        role: "user",
        content: [
          `用户请求:\n${getLatestUserRequest(state)}`,
          `High-Level Plan:\n${JSON.stringify(
            state.highLevelPlan || [],
            null,
            2,
          )}`,
          `High-Level Plan 可读版:\n${formatHighLevelPlan(
            state.highLevelPlan || [],
          )}`,
          `Planner 任务数组:\n${JSON.stringify(
            state.plannerOutput || [],
            null,
            2,
          )}`,
          `Planner 可读版:\n${formatPlannerPayload(
            state.plannerOutput || [],
          )}`,
          `Structured Task List:\n${
            state.structuredTaskListSummary || "暂无"
          }`,
          `Modify 结果:\n${formatModifyResults(state.modifyResults || [])}`,
          `Merged Patch:\n${state.mergedPatchSummary || "暂无"}`,
          `Reviewer 结果:\n${JSON.stringify(
            state.reviewPayload || DEFAULT_REVIEW_PAYLOAD,
            null,
            2,
          )}`,
          `Agent Lifecycle:\n${JSON.stringify(
            state.agentLifecycles || {},
            null,
            2,
          )}`,
          `挂起交互请求:\n${
            state.interactiveRequest
              ? JSON.stringify(state.interactiveRequest, null, 2)
              : "当前没有挂起的交互请求"
          }`,
          `结构化工程验证:
${JSON.stringify(
            state.verificationResult || DEFAULT_VERIFICATION_RESULT,
            null,
            2,
          )}`,
          `校验输出:\n${truncateText(state.lintSummary || "暂无", 4000)}`,
        ].join("\n\n"),
      },
    ], "final_report");

    const finalReportSummary =
      response.choices?.[0]?.message?.content?.trim() ||
      "Final Report Agent 未生成额外结论。";
    tracker.transition("COMPLETED", "Final Report 已生成。" );

    return {
      finalReportSummary,
      summary: appendSummary(
        state.summary || "",
        getLatestUserRequest(state),
        finalReportSummary,
      ),
      tokenUsage: buildTokenUsage(response.usage),
      ...buildLifecycleStateUpdate(tracker),
    };
  } catch (error) {
    tracker.transition(
      "FAILED",
      `Final Report 生成失败: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      finalReportSummary: tracker.getSnapshot().detail,
      ...buildLifecycleStateUpdate(tracker),
    };
  }
}
