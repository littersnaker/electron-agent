/**
 * 模块职责：终端命令执行、工作记忆压缩与大模型调用。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { BaseMessage } from "@langchain/core/messages";
import { execSync } from "child_process";
import { tools } from "../../tools";
import { completeWithLlm } from "@/app/lib/llm/gateway";
import { getRequestLlmCredentials } from "@/app/lib/llm/request-context";
import type { LlmChatResponse, LlmTaskType } from "@/app/lib/llm/types";
import { ModifyWorkerInput, PlanTask, WorkerMemory } from "../types";
import { startAgentTraceSpan } from "@/app/lib/agent-runtime/trace-store";
import { resolveMcpTools, toLlmMcpTools } from "@/app/lib/mcp/client";
import { getPersistentTerminalSession, resumePersistentTerminalSession, startPersistentTerminalSession } from "../persistent-terminal-session";
import { WorkerMemoryPromptText } from "../../prompt";
import { AgentRuntimeState, TerminalCommandOutcome, TokenUsage, WORKER_MEMORY_COMPRESS_EVERY_ROUNDS, WORKER_MEMORY_MAX_CONTEXT_CHARS, buildInteractiveAnswerByLlm, buildTokenUsage, createEmptyTokenUsage, extractInteractiveReplyInstruction, getLatestUserRequest, mergeTokenUsage, normalizeContent, stripThinkContent } from "./runtime-lifecycle";
export async function runNormalTerminalCommand(
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

export async function runPtyLikeCommand(
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
export function appendSummary(
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
export function toConversationText(messages: BaseMessage[], limit = 6): string {
  return messages
    .filter((message) => message._getType() !== "tool")
    .slice(-limit)
    .map(
      (message) => `${message._getType()}: ${stripThinkContent(message.content)}`,
    )
    .join("\n");
}

// 统一截断长文本，避免提示词或最终输出被超长文件内容淹没。
export function truncateText(input: string, maxLength = 5000): string {
  return input.length > maxLength ? `${input.slice(0, maxLength)}\n...` : input;
}

export function normalizeMemoryItems(value: unknown, maxItems = 8): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => String(item ?? "").trim())
        .filter(Boolean),
    ),
  ).slice(0, maxItems);
}

export function parseWorkerMemoryPayload(
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

export function shouldCompressWorkerMemory(
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

export async function compressWorkerMemory(
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

export function buildWorkerContinuationMessage(
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
      "继续遵守 read -> propose_file_change -> 检查返回 diff -> apply_file_change 闭环；不要重复调用 get_diff。",
      "不要声称未调用工具的操作已经完成。",
    ].join("\n\n"),
  };
}

/*
 * 所有 Agent 节点统一经过 LLM Gateway。
 * Provider、模型地址、鉴权格式和任务路由都被隔离在 app/lib/llm 中。
 */
export async function invokeLlm(
  state: AgentRuntimeState,
  messages: Array<Record<string, unknown>>,
  task: LlmTaskType,
  withTools = false,
): Promise<LlmChatResponse> {
  const mcpTools = withTools
    ? await resolveMcpTools(state.workingDir || process.cwd())
    : [];
  const availableTools = withTools
    ? [...tools, ...toLlmMcpTools(mcpTools)]
    : undefined;
  const endSpan = startAgentTraceSpan("llm", task, {
    model: state.model,
    messageCount: messages.length,
    builtInToolCount: withTools ? tools.length : 0,
    mcpToolCount: mcpTools.length,
  });

  try {
    const response = await completeWithLlm({
      task,
      preferredModelId: state.model,
      credentials: getRequestLlmCredentials(),
      messages,
      tools: availableTools,
      toolChoice: withTools ? "auto" : "none",
    });
    endSpan("completed", {
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
      selectedToolCalls:
        response.choices?.[0]?.message?.tool_calls?.length || 0,
    });
    return response;
  } catch (error) {
    endSpan("failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
