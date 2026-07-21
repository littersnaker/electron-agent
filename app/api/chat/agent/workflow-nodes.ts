import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { tools } from "../tools";
import { AgentState } from "./state";
import {
  DEFAULT_PLANNER_PAYLOAD,
  DEFAULT_REVIEW_PAYLOAD,
  CommandExecutionMode,
  formatPlannerPayload,
  InteractiveRequest,
  InteractiveResponseMode,
  ModifyTaskResult,
  PlannerPayload,
  PlanTask,
  PlannerValidationStatus,
  ReviewPayload,
} from "./types";
import { searchProjectIndex } from "@/app/lib/server/workspace-store";

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
const QWEN_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
// Planner 最多拆出 3 个子任务，对应 A/B/C 三个并行 Modify 槽位。
const MAX_PARALLEL_MODIFIERS = 3;
// Planner 在文件冲突或 schema 失败时最多再重试 2 次。
const MAX_PLANNER_RETRIES = 2;
// Reviewer 最多允许打回两轮，避免图无限循环。
const MAX_REVIEW_RETRIES = 2;
const plannerPayloadSchema = z.array(
  z.object({
    task: z.string().min(1),
    files: z.array(z.string().min(1)).min(1),
  }),
).max(MAX_PARALLEL_MODIFIERS);

type AgentRuntimeState = typeof AgentState.State;
type TokenUsage = { prompt: number; completion: number; total: number };
type ToolCall = { id?: string; name: string; args: unknown };
type ToolExecutionResult = {
  messages: ToolMessage[];
  touchedFiles: string[];
  interactiveRequest: InteractiveRequest | null;
  tokenUsage: TokenUsage;
};
type InteractiveReplyInstruction = {
  requestId: string;
  mode: InteractiveResponseMode;
  answer?: string;
};
type TerminalCommandOutcome = {
  output: string;
  mode: CommandExecutionMode;
  interactiveRequest: InteractiveRequest | null;
  tokenUsage: TokenUsage;
};

interface QwenToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface QwenChatResponse {
  choices?: Array<{
    message?: {
      content: string | null;
      tool_calls?: QwenToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// 统一取模型名，避免每个节点都手写默认值判断。
function getModel(state: AgentRuntimeState): string {
  return state.model || "qwen-plus";
}

// 统一取 API Key。
// 这样所有节点只管“我要调模型”，不用各自重复兜底逻辑。
function getApiKey(state: AgentRuntimeState): string {
  const apiKey = state.apiKey || process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("Missing DASHSCOPE_API_KEY");
  return apiKey;
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
function buildTokenUsage(response?: QwenChatResponse["usage"]): TokenUsage {
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

function createInteractiveRequestId(): string {
  return `interactive_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeCommandForAutoAnswer(command: string): string {
  let nextCommand = command;
  if (
    /^(npm create|npx create-[\w-]+|pnpm dlx)\b/i.test(nextCommand) &&
    !/\s(--yes|-y)\b/i.test(nextCommand)
  ) {
    nextCommand += " --yes";
  }
  if (
    /\bcreate-next-app\b/i.test(nextCommand) &&
    !/\s(--yes|-y)\b/i.test(nextCommand)
  ) {
    nextCommand += " --yes";
  }
  return nextCommand;
}

function extractInteractiveReplyInstruction(
  input: string,
): InteractiveReplyInstruction | null {
  const requestIdMatch = input.match(/\[INTERACTIVE_REPLY\]\s*id=([^\s]+)\s*/i);
  const modeMatch = input.match(/\bmode=(auto|llm|user)\b/i);
  if (!requestIdMatch || !modeMatch) return null;

  const answerMatch = input.match(/\banswer=([^\n]+)$/i);
  return {
    requestId: requestIdMatch[1].trim(),
    mode: modeMatch[1].toLowerCase() as InteractiveResponseMode,
    answer: answerMatch?.[1]?.trim(),
  };
}

function inferPromptOptions(prompt: string): Array<{ label: string; value: string }> {
  if (/\((?:y\/n|Y\/n|yes\/no)\)/.test(prompt) || /\b(ok to proceed|continue)\b/i.test(prompt)) {
    return [
      { label: "是", value: "yes" },
      { label: "否", value: "no" },
    ];
  }

  const optionMatches = Array.from(prompt.matchAll(/["“](.+?)["”]/g))
    .map((match) => match[1]?.trim())
    .filter(Boolean);

  return Array.from(new Set(optionMatches)).slice(0, 4).map((option) => ({
    label: option,
    value: option,
  }));
}

function detectInteractivePrompt(output: string): string | null {
  const trimmedOutput = output.trim();
  if (!trimmedOutput) return null;

  const promptPatterns = [
    /\? [^\n\r]+/g,
    /Ok to proceed\?[\s\S]{0,80}/gi,
    /Would you like to continue\?[\s\S]{0,80}/gi,
    /Need to install the following packages:[\s\S]{0,200}?Ok to proceed\?[\s\S]{0,40}/gi,
    /Select an option[\s\S]{0,200}/gi,
    /Pick an option[\s\S]{0,200}/gi,
    /Would you like[\s\S]{0,120}\?/gi,
  ];

  for (const pattern of promptPatterns) {
    const matches = trimmedOutput.match(pattern);
    if (matches?.length) {
      return matches[matches.length - 1].trim();
    }
  }

  const lastLines = trimmedOutput
    .split(/\r?\n/)
    .slice(-8)
    .join("\n");
  return /\?$/.test(lastLines.trim()) ? lastLines.trim() : null;
}

async function buildInteractiveAnswerByLlm(
  state: AgentRuntimeState,
  command: string,
  prompt: string,
): Promise<{ answer: string; tokenUsage: TokenUsage }> {
  const response = await invokeQwen(state, [
    {
      role: "system",
      content:
        "你是 CLI Interactive Manager。请根据当前命令和交互提示，给出最短、最稳妥的一行回答。只输出回答本身，不要解释，不要 Markdown。",
    },
    {
      role: "user",
      content: [
        `用户原始请求:\n${getLatestUserRequest(state)}`,
        `当前命令:\n${command}`,
        `当前交互提示:\n${prompt}`,
      ].join("\n\n"),
    },
  ]);

  return {
    answer: stripThinkContent(response.choices?.[0]?.message?.content || "").trim() || "yes",
    tokenUsage: buildTokenUsage(response.usage),
  };
}

async function runNormalTerminalCommand(
  command: string,
  workingDir: string,
): Promise<TerminalCommandOutcome> {
  try {
    return {
      output: execSync(command, {
        cwd: workingDir || process.cwd(),
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 20_000,
      }),
      mode: "normal",
      interactiveRequest: null,
      tokenUsage: createEmptyTokenUsage(),
    };
  } catch (error) {
    if (error instanceof Error && "stdout" in error) {
      const stdout = String((error as { stdout?: string }).stdout || "");
      const stderr = String((error as { stderr?: string }).stderr || "");
      return {
        output: [stdout, stderr].filter(Boolean).join("\n"),
        mode: "normal",
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    }
    return {
      output: `命令执行失败: ${error instanceof Error ? error.message : String(error)}`,
      mode: "normal",
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
  const effectiveCommand =
    replyInstruction?.mode === "auto" ? normalizeCommandForAutoAnswer(command) : command;

  return new Promise((resolve) => {
    const tokenUsage = createEmptyTokenUsage();
    const child = spawn(effectiveCommand, {
      cwd: workingDir || process.cwd(),
      shell: process.platform === "win32" ? "powershell.exe" : true,
      stdio: "pipe",
      windowsHide: true,
    });

    let output = "";
    let settled = false;
    let answeredPrompt = false;
    let timedOut = false;

    const finish = (result: TerminalCommandOutcome) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const handlePromptIfNeeded = async () => {
      if (answeredPrompt || settled) return;
      const detectedPrompt = detectInteractivePrompt(output);
      if (!detectedPrompt) return;

      let answerToWrite = "";
      if (
        replyInstruction &&
        pendingRequest &&
        replyInstruction.requestId === pendingRequest.id
      ) {
        if (replyInstruction.mode === "user" && replyInstruction.answer) {
          answerToWrite = replyInstruction.answer;
        } else if (replyInstruction.mode === "auto") {
          answerToWrite = inferPromptOptions(detectedPrompt)[0]?.value || "yes";
        } else if (replyInstruction.mode === "llm") {
          buildInteractiveAnswerByLlm(state, effectiveCommand, detectedPrompt)
            .then(({ answer, tokenUsage: llmUsage }) => {
              const mergedUsage = mergeTokenUsage(tokenUsage, llmUsage);
              tokenUsage.prompt = mergedUsage.prompt;
              tokenUsage.completion = mergedUsage.completion;
              tokenUsage.total = mergedUsage.total;
              answeredPrompt = true;
              child.stdin?.write(`${answer}\n`);
            })
            .catch(() => {
              child.kill();
              finish({
                output: truncateText(output, 4000),
                mode: "pty",
                interactiveRequest: {
                  id: pendingRequest.id,
                  command,
                  prompt: detectedPrompt,
                  mode: "pty",
                  suggestedMode: "user",
                  options: inferPromptOptions(detectedPrompt),
                },
                tokenUsage,
              });
            });
          return;
        }
      }

      if (answerToWrite) {
        answeredPrompt = true;
        child.stdin?.write(`${answerToWrite}\n`);
        return;
      }

      child.kill();
      finish({
        output: truncateText(output, 4000),
        mode: "pty",
        interactiveRequest: {
          id: pendingRequest?.id || createInteractiveRequestId(),
          command,
          prompt: detectedPrompt,
          mode: "pty",
          suggestedMode: inferPromptOptions(detectedPrompt).length ? "user" : "llm",
          options: inferPromptOptions(detectedPrompt),
        },
        tokenUsage,
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      void handlePromptIfNeeded();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      void handlePromptIfNeeded();
    });
    child.on("error", (error) => {
      finish({
        output: `PTY 命令执行失败: ${error.message}`,
        mode: "pty",
        interactiveRequest: null,
        tokenUsage,
      });
    });
    child.on("close", () => {
      if (timedOut || settled) return;
      finish({
        output: output || "PTY 命令执行完成，但没有输出。",
        mode: "pty",
        interactiveRequest: null,
        tokenUsage,
      });
    });

    setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill();
      finish({
        output: truncateText(output || "PTY 命令执行超时。", 4000),
        mode: "pty",
        interactiveRequest: pendingRequest
          ? {
              ...pendingRequest,
              command,
            }
          : null,
        tokenUsage,
      });
    }, 60_000);
  });
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

/*
 * 所有 Agent 节点调 Qwen 都走这里。
 *
 * 统一封装的原因是：
 * 1. 请求地址、鉴权、模型名逻辑保持一致；
 * 2. 以后如果要换模型商、改参数，不需要每个节点都改；
 * 3. withTools 开关可以明确区分“只思考”和“可调用工具”两种调用场景。
 */
async function invokeQwen(
  state: AgentRuntimeState,
  messages: Array<Record<string, unknown>>,
  withTools = false,
): Promise<QwenChatResponse> {
  const response = await fetch(QWEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey(state)}`,
    },
    body: JSON.stringify({
      model: getModel(state),
      messages,
      tools: withTools ? tools : undefined,
      tool_choice: withTools ? "auto" : undefined,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Qwen API failed: ${response.status} ${errorText}`);
  }

  return (await response.json()) as QwenChatResponse;
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
function parsePlannerPayloadWithSchema(content: string): {
  success: boolean;
  tasks: PlannerPayload;
  message: string;
} {
  const extracted = extractPlannerJsonArray(content);
  if (extracted === null) {
    return {
      success: false,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: "Planner 输出中未提取到合法 JSON 数组。",
    };
  }

  const parsedResult = plannerPayloadSchema.safeParse(extracted);
  if (!parsedResult.success) {
    return {
      success: false,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: `Planner JSON Schema 校验失败: ${parsedResult.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    };
  }

  const tasks = parsedResult.data
    .map((task) => ({
      task: task.task.trim(),
      files: task.files.map((file) => file.trim()).filter(Boolean),
    }))
    .filter((task) => task.task && (task.files.length > 0 || parsedResult.data.length === 0))
    .slice(0, MAX_PARALLEL_MODIFIERS);

  if (parsedResult.data.length === 0) {
    return {
      success: true,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: "Planner JSON Schema 校验通过，当前请求无需拆分修改任务。",
    };
  }

  if (!tasks.length) {
    return {
      success: false,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: "Planner JSON 通过解析，但没有得到可执行任务。",
    };
  }

  return {
    success: true,
    tasks,
    message: "Planner JSON Schema 校验通过。",
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
        parsed.decision === "RETRY" ? "RETRY" : DEFAULT_REVIEW_PAYLOAD.decision;
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
        task: task.task,
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
  ];
  const uniqueFiles = Array.from(
    new Set(collectedFiles.map((file) => file.trim()).filter(Boolean)),
  ).slice(0, 12);

  return [
    {
      task: `单 Agent 降级执行：${getLatestUserRequest(state)}`,
      files: uniqueFiles,
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

// 按槽位取出 Planner 分配好的任务。
function getPlanTask(state: AgentRuntimeState, slot: number): PlanTask | null {
  return state.plannerOutput?.[slot] || null;
}

// 把单个 Modify 槽位的执行结果收敛成统一结构，便于后续 Merge / Review / Verify。
function buildModifyResult(
  slot: number,
  task: PlanTask | null,
  summary: string,
  status: "pending" | "done" | "skipped" | "blocked",
  touchedFiles: string[] = [],
): ModifyTaskResult {
  return {
    slot,
    task: task?.task || `空任务槽位 ${slot + 1}`,
    files: task?.files || [],
    summary,
    touchedFiles,
    status,
  };
}

// 给 Merge Patch、Reviewer、Final Report 提供统一的人类可读结果文本。
function formatModifyResults(results: ModifyTaskResult[]): string {
  if (!results.length) return "暂无 Modify 结果。";

  return results
    .map(
      (result) =>
        `槽位 ${result.slot + 1}: ${result.task}\n状态: ${result.status}\n文件: ${
          result.files.length ? result.files.join(", ") : "未指定"
        }\n总结: ${result.summary}`,
    )
    .join("\n\n");
}

// 把相对路径转成当前工作目录下的绝对路径。
// 同时兼容用户直接传进来的 Windows 绝对路径。
async function getSafePath(filePath: string, workingDir: string): Promise<string> {
  const rootPath = workingDir || process.cwd();
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  const normalizedPath = filePath.replace(/^(\.\/|\/)/, "");
  return path.join(rootPath, normalizedPath);
}

// 从本地磁盘安全读取文件。
// 这里不抛异常，而是返回“可读错误文本”，方便继续喂给模型判断下一步。
async function readFileFromLocalDisk(
  filePath: string,
  workingDir: string,
): Promise<string> {
  try {
    const safePath = await getSafePath(filePath, workingDir);
    if (!fs.existsSync(safePath)) return `未找到文件: ${filePath}`;
    return fs.readFileSync(safePath, "utf-8");
  } catch (error) {
    return `读取失败: ${error instanceof Error ? error.message : String(error)}`;
  }
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
): Promise<TerminalCommandOutcome> {
  const validationError = validateTerminalCommand(command);
  if (validationError) {
    return {
      output: validationError,
      mode: "normal",
      interactiveRequest: null,
      tokenUsage: createEmptyTokenUsage(),
    };
  }

  const mode = classifyCommandMode(command);
  if (mode === "pty") {
    return runPtyLikeCommand(command, workingDir, state);
  }
  return runNormalTerminalCommand(command, workingDir);
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
  state: AgentRuntimeState,
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
          makeMessage(await readFileFromLocalDisk(filePath, currentWorkingDir)),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "read_pdf_from_disk":
      return {
        messages: [
          makeMessage(
            "当前版本未接入 PDF 解析器，请改用文件文本或后续补充实现。",
          ),
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
      return {
        messages: [
          makeMessage(
            await proposeFileChange(
              filePath,
              args.fileContent || "",
              currentWorkingDir,
            ),
          ),
          makeMessage(
            await getDiff(filePath, currentWorkingDir),
            "get_diff",
            `${toolCall.id}-diff`,
          ),
        ],
        touchedFiles: [...touchedFiles],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    }
    case "get_diff":
      return {
        messages: [makeMessage(await getDiff(filePath, currentWorkingDir))],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "apply_file_change":
      touchedFiles.add(filePath);
      return {
        messages: [makeMessage(await applyFileChange(filePath, currentWorkingDir))],
        touchedFiles: [...touchedFiles],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "run_terminal_command": {
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
  state: AgentRuntimeState,
): Promise<ToolExecutionResult> {
  // 只读工具可以并行，写工具保持串行，避免多个改动互相覆盖。
  const readOnlyTools = new Set([
    "search_project_index",
    "list_directory",
    "search_codebase",
    "read_file_from_disk",
    "read_pdf_from_disk",
    "get_local_time",
    "get_diff",
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
    lintSummary: "",
    finalReportSummary: "",
    mergedContext: "",
    searchContext: "",
    memoryContext: "",
    fileContext: "",
    plannerOutput: DEFAULT_PLANNER_PAYLOAD,
    plannerRawOutput: "",
    plannerValidationStatus: "pending" as PlannerValidationStatus,
    plannerValidationMessage: "",
    plannerRetryCount: 0,
    plannerRetryReason: "",
    modifyResults: [],
    mergedPatchSummary: "",
    structuredTaskListSummary: "",
    reviewPayload: DEFAULT_REVIEW_PAYLOAD,
    reviewFeedback: "",
    reviewDecision: "PASS",
    retryTaskSlots: [],
    reviewIteration: 0,
    interactiveRequest: null,
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
): Promise<Record<string, unknown>> {
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

  return {
    searchContext: [
      `用户请求:\n${userRequest}`,
      `项目索引检索:\n${truncateText(searchResults, 3000)}`,
      `代码库扫描:\n${truncateText(codebaseResults, 3000)}`,
    ].join("\n\n"),
  };
}

// MemoryAgent 负责把“历史记忆”和“最近几轮上下文”整理出来。
// 这样 Planner 不会只看当前一句话，而是知道前面做过什么。
export async function memoryAgentNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  return {
    memoryContext: [
      `长期对话记忆:\n${state.summary || "暂无长期记忆。"}`,
      `近期会话摘要:\n${
        toConversationText(state.messages, 8) || "暂无近期上下文。"
      }`,
    ].join("\n\n"),
  };
}

// FileAgent 的目标是“把用户点名过的路径先预读出来”。
// 如果用户没有给路径，就退回到目录概览，至少让后续节点对项目结构有个感知。
export async function fileAgentNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const userRequest = getLatestUserRequest(state);
  const workingDir = state.workingDir || process.cwd();
  const candidatePaths = extractCandidatePaths(userRequest).slice(0, 5);

  if (candidatePaths.length === 0) {
    return {
      fileContext: `未在用户请求中检测到明确文件路径。\n工作目录结构预览:\n${await listDirectory(
        ".",
        workingDir,
      )}`,
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

  return {
    fileContext: sections.join("\n\n"),
  };
}

// 三个上下文 Agent 的结果会在这里汇总成一份 mergedContext。
// 后面的 Planner、Modify、Reviewer 基本都吃这份汇总文本。
export async function mergeContextNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const userRequest = getLatestUserRequest(state);
  return {
    mergedContext: [
      `用户请求:\n${userRequest}`,
      `SearchAgent:\n${state.searchContext || "暂无搜索上下文。"}`,
      `MemoryAgent:\n${state.memoryContext || "暂无记忆上下文。"}`,
      `FileAgent:\n${state.fileContext || "暂无文件上下文。"}`,
    ].join("\n\n"),
  };
}

/*
 * Planning Agent 只负责拆任务，不直接动文件。
 *
 * 这里特别强调严格 JSON 输出，是因为它后面要经过：
 * 1. Schema 校验；
 * 2. 文件唯一性检查；
 * 3. 可能的重试、修复、降级。
 *
 * 也就是说，Planner 在这套架构里更像“任务编排器”，不是自由发挥的聊天助手。
 */
export async function planningAgentNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  // Planner 只做任务拆分，不直接修改文件。
  const response = await invokeQwen(state, [
    {
      role: "system",
      content: `你是 Planning Agent。
请基于上下文输出严格 JSON 数组，不要输出 Markdown，不要输出额外解释。
格式必须类似：
[
  { "task": "修改登录页", "files": ["Login.tsx"] },
  { "task": "修改API", "files": ["AuthService.ts"] },
  { "task": "修改测试", "files": ["login.test.ts"] }
]
要求：
1. 最多输出 ${MAX_PARALLEL_MODIFIERS} 个任务。
2. 每个任务必须聚焦一个明确子目标。
3. files 必须是最需要修改的文件路径数组。
4. 尽量不要让多个任务修改同一个文件，优先按文件边界拆任务，避免后续 Merge Patch 冲突。
5. 如果无需改代码，输出 []。`,
    },
    {
      role: "user",
      content: [
        state.mergedContext || getLatestUserRequest(state),
        state.plannerRetryReason
          ? `上一次规划失败原因:\n${state.plannerRetryReason}`
          : "",
        state.plannerRawOutput
          ? `上一次 Planner 原始输出:\n${state.plannerRawOutput}`
          : "",
        `当前已重试次数: ${state.plannerRetryCount || 0}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ]);

  const plannerRawOutput = response.choices?.[0]?.message?.content || "";

  return {
    plannerRawOutput,
    plannerValidationStatus: "pending" as PlannerValidationStatus,
    plannerValidationMessage: "等待进入 JSON Schema 校验。",
    tokenUsage: buildTokenUsage(response.usage),
  };
}

// Planner 第一层正式校验节点。
// 它把原始文本解析成结构化任务数组，并明确写回“校验通过 / 失败”的状态。
export async function plannerSchemaValidationNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const validationResult = parsePlannerPayloadWithSchema(state.plannerRawOutput || "");

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
 * 这是 Modify A / B / C 的工厂函数。
 *
 * 为什么用工厂？
 * 因为三路 Modify 的逻辑几乎完全一样，唯一差别只是“自己负责哪个槽位”。
 * 用工厂可以保证三路行为一致，避免复制三份大段重复代码。
 */
function createModifyAgentNode(slot: number) {
  return async function modifyAgentNode(
    state: AgentRuntimeState,
  ): Promise<Record<string, unknown>> {
    // 每个 Modify 节点只处理一个 task 槽位，互不抢任务。
    const task = getPlanTask(state, slot);
    const isRetryRound = state.reviewDecision === "RETRY";
    const retryTaskSlots = state.retryTaskSlots || [];

    if (!state.requiresChanges || !task) {
      return {
        modifyResults: [
          buildModifyResult(
            slot,
            task,
            "当前槽位没有分配任务，跳过执行。",
            "skipped",
          ),
        ],
      };
    }

    if (isRetryRound && retryTaskSlots.length > 0 && !retryTaskSlots.includes(slot)) {
      return {
        modifyResults: [
          buildModifyResult(
            slot,
            task,
            "本轮 Reviewer 未要求该槽位返工，直接沿用上一轮结果。",
            "skipped",
            task.files,
          ),
        ],
      };
    }

    const graphMessages: BaseMessage[] = [];
    const runtimeMessages: Array<Record<string, unknown>> = [
      {
        role: "user",
        content: [
          `用户请求:\n${getLatestUserRequest(state)}`,
          `整体计划:\n${JSON.stringify(state.plannerOutput || [], null, 2)}`,
          `当前负责槽位: ${slot + 1}`,
          `当前任务:\n${JSON.stringify(task, null, 2)}`,
          `可读计划:\n${formatPlannerPayload(state.plannerOutput || [])}`,
          `合并上下文:\n${state.mergedContext || "暂无"}`,
          `Review 轮次: ${state.reviewIteration || 0}`,
          `Reviewer 反馈:\n${state.reviewFeedback || "暂无反馈"}`,
          `本轮需返工槽位: ${formatRetryTasks(retryTaskSlots)}`,
          `待恢复交互请求:\n${
            state.interactiveRequest
              ? JSON.stringify(state.interactiveRequest, null, 2)
              : "当前没有挂起的交互请求"
          }`,
          "要求:",
          "1. 只聚焦当前任务与当前文件列表。",
          "2. 必须先读后改，不要臆测文件内容。",
          "3. 尽量限制在当前任务文件内完成，如必须扩散请谨慎说明。",
          "4. 修改闭环优先走 propose_file_change -> get_diff -> apply_file_change。",
          "5. 如果终端工具提示需要交互，优先让 Tool Router 处理，不要自己假装已完成。",
          "6. 完成后输出简洁中文总结。",
        ].join("\n\n"),
      },
    ];
    const touchedFiles = new Set<string>(task.files);
    const totalUsage: TokenUsage = { prompt: 0, completion: 0, total: 0 };

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await invokeQwen(
        state,
        [
          {
            role: "system",
            content:
              "你是 Modify Agent。你只负责被分配到的单个任务槽位，并且需要持续调用工具直到当前槽位任务可以收尾。",
          },
          ...runtimeMessages,
        ],
        true,
      );

      const usage = buildTokenUsage(response.usage);
      totalUsage.prompt += usage.prompt;
      totalUsage.completion += usage.completion;
      totalUsage.total += usage.total;

      const assistantMessage = response.choices?.[0]?.message;
      const toolCalls = assistantMessage?.tool_calls || [];

      if (toolCalls.length > 0) {
        const aiMessage = new AIMessage({
          content: assistantMessage?.content || "",
          tool_calls: toolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.function.name,
            args: JSON.parse(
              toolCall.function.arguments || "{}",
            ) as Record<string, unknown>,
            type: "tool_call" as const,
          })),
        });
        graphMessages.push(aiMessage);
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
          toolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.function.name,
            args: JSON.parse(
              toolCall.function.arguments || "{}",
            ) as Record<string, unknown>,
          })),
          state,
        );

        executed.touchedFiles.forEach((file) => {
          if (file) touchedFiles.add(file);
        });
        const mergedToolUsage = mergeTokenUsage(totalUsage, executed.tokenUsage);
        totalUsage.prompt = mergedToolUsage.prompt;
        totalUsage.completion = mergedToolUsage.completion;
        totalUsage.total = mergedToolUsage.total;

        executed.messages.forEach((message) => {
          graphMessages.push(message);
          runtimeMessages.push({
            role: "tool",
            content: normalizeContent(message.content),
            tool_call_id: message.tool_call_id,
          });
        });

        if (executed.interactiveRequest) {
          const blockedSummary = [
            `槽位 ${slot + 1} 的命令执行被交互式 Prompt 暂停。`,
            `命令: ${executed.interactiveRequest.command}`,
            `提示: ${executed.interactiveRequest.prompt}`,
            "请使用前端按钮选择自动回答、LLM 回答或用户自定义回答后，再继续本轮 Code Agent。",
          ].join("\n");

          graphMessages.push(new AIMessage({ content: blockedSummary }));
          return {
            messages: graphMessages,
            modifyResults: [
              buildModifyResult(
                slot,
                task,
                blockedSummary,
                "blocked",
                [...touchedFiles],
              ),
            ],
            interactiveRequest: executed.interactiveRequest,
            touchedFiles: [...touchedFiles],
            tokenUsage: totalUsage,
          };
        }
        continue;
      }

      const finalContent =
        assistantMessage?.content?.trim() || `槽位 ${slot + 1} 修改已完成。`;
      graphMessages.push(new AIMessage({ content: finalContent }));

      return {
        messages: graphMessages,
        modifyResults: [
          buildModifyResult(slot, task, finalContent, "done", [...touchedFiles]),
        ],
        interactiveRequest: null,
        touchedFiles: [...touchedFiles],
        tokenUsage: totalUsage,
      };
    }

    return {
      messages: graphMessages,
      modifyResults: [
        buildModifyResult(
          slot,
          task,
          "达到最大工具轮次，请结合当前 Reviewer 反馈继续人工复查。",
          "done",
          [...touchedFiles],
        ),
      ],
      interactiveRequest: null,
      touchedFiles: [...touchedFiles],
      tokenUsage: totalUsage,
    };
  };
}

// 这三个导出只是把“同一套 Modify 逻辑”绑定到不同槽位。
// A -> slot 0，B -> slot 1，C -> slot 2。
export const modifyAgentANode = createModifyAgentNode(0);
export const modifyAgentBNode = createModifyAgentNode(1);
export const modifyAgentCNode = createModifyAgentNode(2);

// Merge Patch 在这版架构里不是传统意义的 patch 合并器。
// 它只负责把三路 Modify 结果汇总起来，交给 Reviewer 做统一审查。
export async function mergePatchNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  // Merge Patch 不直接改文件，也不尝试自动合并同文件 diff，只负责汇总三路执行结果。
  const mergedPatchSummary = [
    `Planner 任务数组:\n${JSON.stringify(state.plannerOutput || [], null, 2)}`,
    `Modify 汇总:\n${formatModifyResults(state.modifyResults || [])}`,
    `交互状态:\n${
      state.interactiveRequest
        ? JSON.stringify(state.interactiveRequest, null, 2)
        : "当前没有挂起的交互请求"
    }`,
  ].join("\n\n");

  return {
    mergedPatchSummary,
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
 * 这样就能做到局部返工，而不是让 Modify A/B/C 每次都全量重跑。
 */
export async function reviewerAgentNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  // Reviewer 只负责把关：完成度、遗漏文件、方向错误、明显风险。
  if (!state.requiresChanges || !(state.plannerOutput || []).length) {
    return {
      reviewPayload: DEFAULT_REVIEW_PAYLOAD,
      reviewFeedback: "",
      reviewDecision: "PASS",
    };
  }

  if (state.interactiveRequest) {
    return {
      reviewPayload: {
        decision: "PASS",
        feedback: "存在待处理的交互式命令请求，本轮先暂停 Reviewer 打回逻辑，等待用户选择继续方式。",
        risks: ["交互式命令尚未真正完成，当前结果仅为中间态。"],
        retryTasks: [],
      },
      reviewFeedback: "存在挂起的交互请求，Reviewer 暂不继续返工判断。",
      reviewDecision: "PASS",
    };
  }

  const reviewFiles = Array.from(new Set(state.touchedFiles || []));
  const filePreview = await buildFilePreview(
    reviewFiles.length
      ? reviewFiles
      : (state.plannerOutput || []).flatMap((task: PlanTask) => task.files),
    state.workingDir || process.cwd(),
    80,
  );

  const response = await invokeQwen(state, [
    {
      role: "system",
      content: `你是 Reviewer Agent。
请根据 Planner 任务、Modify 结果和当前文件内容进行审查。
只输出严格 JSON：
{
  "decision": "PASS" | "RETRY",
  "feedback": "如果需要返工，给出明确、可执行的修改意见；如果通过，也请写简洁结论",
  "risks": ["风险1", "风险2"],
  "retryTasks": [0]
}
若任务没有完成、文件遗漏、修改方向错误或存在明显风险，请输出 RETRY。
只有失败的任务才放进 retryTasks，例如只重跑 Task A 就输出 [0]。`,
    },
    {
      role: "user",
      content: [
        `用户请求:\n${getLatestUserRequest(state)}`,
        `Planner 任务数组:\n${JSON.stringify(state.plannerOutput || [], null, 2)}`,
        `Modify 结果:\n${formatModifyResults(state.modifyResults || [])}`,
        `Merged Patch:\n${state.mergedPatchSummary || "暂无"}`,
        `当前 Review 轮次: ${state.reviewIteration || 0}`,
        `当前文件快照:\n${filePreview || "暂无文件快照"}`,
      ].join("\n\n"),
    },
  ]);

  const payload = safeParseReviewPayload(
    response.choices?.[0]?.message?.content || "",
  );

  if (payload.decision === "RETRY" && (state.reviewIteration || 0) < MAX_REVIEW_RETRIES) {
    const retryTaskSlots = payload.retryTasks.length
      ? payload.retryTasks
      : resolveRetryTaskSlots(state);
    return {
      reviewPayload: {
        ...payload,
        retryTasks: retryTaskSlots,
      },
      reviewFeedback: payload.feedback,
      reviewDecision: "RETRY",
      retryTaskSlots,
      reviewIteration: (state.reviewIteration || 0) + 1,
      tokenUsage: buildTokenUsage(response.usage),
    };
  }

  const normalizedPayload =
    payload.decision === "RETRY"
      ? {
          ...payload,
          decision: "PASS" as const,
          feedback: [
            payload.feedback,
            "已达到最大返工轮次，带着剩余风险进入最终总结。",
          ]
            .filter(Boolean)
            .join("\n"),
        }
      : payload;

  return {
    reviewPayload: normalizedPayload,
    reviewFeedback: normalizedPayload.feedback,
    reviewDecision: "PASS",
    retryTaskSlots: [],
    tokenUsage: buildTokenUsage(response.usage),
  };
}

// 这个节点负责真实工程校验，而不是模型主观判断。
// 也就是常说的“最后再跑一遍 lint / build / test 看看有没有真炸”。
export async function lintBuildTestNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  // 这个节点负责真实校验，不直接生成最终用户报告。
  if (state.interactiveRequest) {
    return {
      lintSummary: [
        "Lint:",
        "存在挂起的交互式命令请求，暂不执行。",
        "",
        "Build:",
        "存在挂起的交互式命令请求，暂不执行。",
        "",
        "Test:",
        "存在挂起的交互式命令请求，暂不执行。",
      ].join("\n"),
    };
  }

  const touchedFiles = state.touchedFiles || [];
  const workingDir = state.workingDir || process.cwd();
  const packageJsonPath = path.join(workingDir, "package.json");
  const lintableFiles = touchedFiles.filter((file: string) =>
    [".ts", ".tsx", ".js", ".jsx"].includes(path.extname(file)),
  );

  let lintResult = "未执行 lint。";
  if (lintableFiles.length > 0) {
    const quotedFiles = lintableFiles.map((file: string) => `"${file}"`).join(" ");
    lintResult = (
      await runTerminalCommand(
      `pnpm eslint ${quotedFiles}`,
      workingDir,
      state,
    )
    ).output;
  }

  let buildResult = "未执行 build。";
  let testResult = "未执行 test。";
  let hasBuildScript = false;
  let hasTestScript = false;

  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
        scripts?: Record<string, string>;
      };
      hasBuildScript = Boolean(packageJson.scripts?.build);
      hasTestScript = Boolean(packageJson.scripts?.test);
    } catch {
      buildResult = "package.json 解析失败，跳过 build。";
      testResult = "package.json 解析失败，跳过 test。";
    }
  }

  if (hasBuildScript) {
    buildResult = (await runTerminalCommand("pnpm build", workingDir, state)).output;
  } else if (buildResult === "未执行 build。") {
    buildResult = "未配置 build 脚本，跳过。";
  }

  if (hasTestScript) {
    testResult = (await runTerminalCommand("pnpm test", workingDir, state)).output;
  } else if (testResult === "未执行 test。") {
    testResult = "未配置 test 脚本，跳过。";
  }

  return {
    lintSummary: [
      `Lint:\n${truncateText(lintResult, 3000)}`,
      `Build:\n${truncateText(buildResult, 3000)}`,
      `Test:\n${truncateText(testResult, 3000)}`,
    ].join("\n\n"),
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
): Promise<Record<string, unknown>> {
  const response = await invokeQwen(state, [
    {
      role: "system",
      content:
        "你是 Final Report Agent。请根据 Planner、Modify、Reviewer 与 Lint/Build/Test 输出，给出简洁的中文 Markdown 最终结论，说明完成情况、涉及文件、返工情况、校验结果与剩余风险。",
    },
    {
      role: "user",
      content: [
        `用户请求:\n${getLatestUserRequest(state)}`,
        `Planner 任务数组:\n${JSON.stringify(state.plannerOutput || [], null, 2)}`,
        `Planner 可读版:\n${formatPlannerPayload(state.plannerOutput || [])}`,
        `Structured Task List:\n${state.structuredTaskListSummary || "暂无"}`,
        `Modify 结果:\n${formatModifyResults(state.modifyResults || [])}`,
        `Merged Patch:\n${state.mergedPatchSummary || "暂无"}`,
        `Reviewer 结果:\n${JSON.stringify(state.reviewPayload || DEFAULT_REVIEW_PAYLOAD, null, 2)}`,
        `挂起交互请求:\n${
          state.interactiveRequest
            ? JSON.stringify(state.interactiveRequest, null, 2)
            : "当前没有挂起的交互请求"
        }`,
        `校验输出:\n${truncateText(state.lintSummary || "暂无", 4000)}`,
      ].join("\n\n"),
    },
  ]);

  const finalReportSummary =
    response.choices?.[0]?.message?.content?.trim() ||
    "Final Report Agent 未生成额外结论。";

  return {
    finalReportSummary,
    summary: appendSummary(
      state.summary || "",
      getLatestUserRequest(state),
      finalReportSummary,
    ),
    tokenUsage: buildTokenUsage(response.usage),
  };
}
