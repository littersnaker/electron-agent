// 模块说明：在每次模型调用前估算 Token，并按优先级压缩上下文。
import type { LlmTaskType } from "@/app/lib/llm/types";

/** 单次模型调用的预算策略。所有数值均可被环境变量覆盖。 */
export interface ContextBudgetPolicy {
  contextWindowTokens: number;
  outputReserveTokens: number;
  safetyMarginTokens: number;
  minimumMessageTokens: number;
}

/** 上下文预算处理结果，便于 Trace、测试和线上诊断。 */
export interface ContextBudgetReport {
  contextWindowTokens: number;
  inputBudgetTokens: number;
  originalEstimatedTokens: number;
  finalEstimatedTokens: number;
  toolEstimatedTokens: number;
  droppedMessageCount: number;
  truncatedMessageCount: number;
  overflowTokens: number;
  budgetSatisfied: boolean;
  wasCompacted: boolean;
}

export interface ContextBudgetInput {
  task: LlmTaskType;
  messages: readonly Record<string, unknown>[];
  tools?: readonly unknown[];
  policy?: Partial<ContextBudgetPolicy>;
}

export interface ContextBudgetResult {
  messages: Array<Record<string, unknown>>;
  report: ContextBudgetReport;
}

interface MessageGroup {
  indexes: number[];
  mandatory: boolean;
  priority: number;
  estimatedTokens: number;
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_000;
const DEFAULT_SAFETY_MARGIN_TOKENS = 800;
const DEFAULT_MINIMUM_MESSAGE_TOKENS = 96;
const IMAGE_TOKEN_ESTIMATE = 1_024;
const MESSAGE_OVERHEAD_TOKENS = 8;

const TASK_OUTPUT_RESERVE: Record<LlmTaskType, number> = {
  chat: 4_096,
  read_only: 4_096,
  cli: 2_048,
  memory: 2_048,
  planner: 4_096,
  worker: 6_144,
  reviewer: 4_096,
  reflection: 3_072,
  final_report: 4_096,
  final_answer: 4_096,
  commerce_intent: 2_048,
  commerce_analysis: 4_096,
};

function readPositiveInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePolicy(
  task: LlmTaskType,
  overrides: Partial<ContextBudgetPolicy> | undefined,
): ContextBudgetPolicy {
  return {
    contextWindowTokens:
      overrides?.contextWindowTokens ??
      readPositiveInteger(
        "AGENT_CONTEXT_WINDOW_TOKENS",
        DEFAULT_CONTEXT_WINDOW_TOKENS,
      ),
    outputReserveTokens:
      overrides?.outputReserveTokens ??
      readPositiveInteger(
        "AGENT_CONTEXT_OUTPUT_RESERVE_TOKENS",
        TASK_OUTPUT_RESERVE[task],
      ),
    safetyMarginTokens:
      overrides?.safetyMarginTokens ??
      readPositiveInteger(
        "AGENT_CONTEXT_SAFETY_MARGIN_TOKENS",
        DEFAULT_SAFETY_MARGIN_TOKENS,
      ),
    minimumMessageTokens:
      overrides?.minimumMessageTokens ??
      readPositiveInteger(
        "AGENT_CONTEXT_MIN_MESSAGE_TOKENS",
        DEFAULT_MINIMUM_MESSAGE_TOKENS,
      ),
  };
}

/**
 * 无需依赖具体 Provider Tokenizer 的保守估算器。
 * 中文通常接近“一字一 Token”，英文按约四字符一 Token 估算。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) || []).length;
  const remainingCount = Math.max(0, text.length - cjkCount);
  return Math.ceil(cjkCount + remainingCount / 4);
}

function estimateUnknownTokens(value: unknown, depth = 0): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return estimateTextTokens(value);
  if (typeof value === "number" || typeof value === "boolean") return 1;
  if (typeof value === "function" || typeof value === "symbol") return 8;
  if (depth > 6) return 16;

  if (Array.isArray(value)) {
    return value.reduce(
      (total, item) => total + estimateUnknownTokens(item, depth + 1),
      0,
    );
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "image" || record.type === "image_url") {
      return IMAGE_TOKEN_ESTIMATE;
    }
    return Object.entries(record).reduce(
      (total, [key, item]) =>
        total + estimateTextTokens(key) + estimateUnknownTokens(item, depth + 1),
      0,
    );
  }

  return estimateTextTokens(String(value));
}

export function estimateMessageTokens(
  message: Record<string, unknown>,
): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateUnknownTokens(message);
}

function getRole(message: Record<string, unknown>): string {
  return String(message.role || "unknown").toLowerCase();
}

function buildMessageGroups(
  messages: readonly Record<string, unknown>[],
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let activeConversationGroup: MessageGroup | null = null;
  let latestUserGroupIndex = -1;

  messages.forEach((message, index) => {
    const role = getRole(message);
    const tokenCount = estimateMessageTokens(message);

    if (role === "system") {
      groups.push({
        indexes: [index],
        mandatory: true,
        priority: 10_000 + index,
        estimatedTokens: tokenCount,
      });
      activeConversationGroup = null;
      return;
    }

    if (role === "user" || !activeConversationGroup) {
      activeConversationGroup = {
        indexes: [],
        mandatory: false,
        priority: index,
        estimatedTokens: 0,
      };
      groups.push(activeConversationGroup);
      if (role === "user") latestUserGroupIndex = groups.length - 1;
    }

    activeConversationGroup.indexes.push(index);
    activeConversationGroup.estimatedTokens += tokenCount;
    activeConversationGroup.priority = index;
  });

  if (latestUserGroupIndex >= 0) {
    groups[latestUserGroupIndex].mandatory = true;
    groups[latestUserGroupIndex].priority += 9_000;
  } else if (groups.length) {
    groups[groups.length - 1].mandatory = true;
    groups[groups.length - 1].priority += 9_000;
  }

  return groups;
}

function truncateStringByTokens(value: string, maxTokens: number): string {
  if (estimateTextTokens(value) <= maxTokens) return value;
  if (maxTokens <= 8) return value.slice(0, Math.max(1, maxTokens));

  const marker = "\n...[上下文预算已截断]...\n";
  let low = 1;
  let high = value.length;
  let best = value.slice(0, Math.max(1, maxTokens));

  while (low <= high) {
    const totalCharacters = Math.floor((low + high) / 2);
    const headCharacters = Math.max(1, Math.floor(totalCharacters * 0.7));
    const tailCharacters = Math.max(0, totalCharacters - headCharacters);
    const candidate = `${value.slice(0, headCharacters)}${marker}${
      tailCharacters ? value.slice(-tailCharacters) : ""
    }`;

    if (estimateTextTokens(candidate) <= maxTokens) {
      best = candidate;
      low = totalCharacters + 1;
    } else {
      high = totalCharacters - 1;
    }
  }
  return best;
}

function truncateUnknownContent(value: unknown, maxTokens: number): unknown {
  if (typeof value === "string") {
    return truncateStringByTokens(value, maxTokens);
  }
  if (!Array.isArray(value)) return value;

  let remaining = maxTokens;
  return value.map((part) => {
    const partTokens = estimateUnknownTokens(part);
    if (partTokens <= remaining) {
      remaining -= partTokens;
      return part;
    }
    if (
      part &&
      typeof part === "object" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      const nextPart = {
        ...(part as Record<string, unknown>),
        text: truncateStringByTokens(part.text, Math.max(1, remaining)),
      };
      remaining = 0;
      return nextPart;
    }
    return part;
  });
}

function truncateMessage(
  message: Record<string, unknown>,
  maxTokens: number,
): Record<string, unknown> {
  const hasParts = Array.isArray(message.parts);
  const baseMessage = {
    ...message,
    content: "",
    ...(hasParts ? { parts: [] } : {}),
  };
  const baseTokens = estimateMessageTokens(baseMessage);
  const flexibleBudget = Math.max(1, maxTokens - baseTokens);
  const contentTokens = estimateUnknownTokens(message.content);
  const partsTokens = hasParts ? estimateUnknownTokens(message.parts) : 0;
  const flexibleTokens = Math.max(1, contentTokens + partsTokens);
  const contentBudget = Math.max(
    1,
    Math.floor((flexibleBudget * contentTokens) / flexibleTokens),
  );
  const partsBudget = Math.max(1, flexibleBudget - contentBudget);

  return {
    ...message,
    content: truncateUnknownContent(message.content, contentBudget),
    ...(hasParts
      ? { parts: truncateUnknownContent(message.parts, partsBudget) }
      : {}),
  };
}

function compactSelectedMessages(
  messages: readonly Record<string, unknown>[],
  selectedIndexes: Set<number>,
  inputBudgetTokens: number,
  minimumMessageTokens: number,
): {
  messages: Array<Record<string, unknown>>;
  truncatedMessageCount: number;
} {
  const selected = messages
    .map((message, index) => ({ message, index }))
    .filter(({ index }) => selectedIndexes.has(index));
  let remaining = inputBudgetTokens;
  let truncatedMessageCount = 0;

  return {
    messages: selected.map(({ message }, position) => {
      const originalTokens = estimateMessageTokens(message);
      const remainingMessages = selected.length - position;
      const averageShare = Math.floor(
        remaining / Math.max(1, remainingMessages),
      );
      const canHonorMinimum =
        remaining >= minimumMessageTokens * remainingMessages;
      const fairShare = canHonorMinimum
        ? Math.max(minimumMessageTokens, averageShare)
        : Math.max(1, averageShare);
      const allowedTokens = Math.min(originalTokens, fairShare);
      remaining = Math.max(0, remaining - allowedTokens);

      if (allowedTokens >= originalTokens) return { ...message };
      truncatedMessageCount += 1;
      return truncateMessage(message, allowedTokens);
    }),
    truncatedMessageCount,
  };
}

/**
 * 按“系统指令 > 最新用户轮次 > 最近历史”的顺序保留上下文。
 * 每个用户轮次与其后续 assistant/tool 消息作为整体选择，避免破坏工具调用配对。
 */
export function manageContextBudget(
  input: ContextBudgetInput,
): ContextBudgetResult {
  const policy = resolvePolicy(input.task, input.policy);
  const toolEstimatedTokens = estimateUnknownTokens(input.tools || []);
  const inputBudgetTokens = Math.max(
    16,
    policy.contextWindowTokens -
      policy.outputReserveTokens -
      policy.safetyMarginTokens -
      toolEstimatedTokens,
  );
  const originalEstimatedTokens = input.messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );

  if (originalEstimatedTokens <= inputBudgetTokens) {
    return {
      messages: input.messages.map((message) => ({ ...message })),
      report: {
        contextWindowTokens: policy.contextWindowTokens,
        inputBudgetTokens,
        originalEstimatedTokens,
        finalEstimatedTokens: originalEstimatedTokens,
        toolEstimatedTokens,
        droppedMessageCount: 0,
        truncatedMessageCount: 0,
        overflowTokens: 0,
        budgetSatisfied: true,
        wasCompacted: false,
      },
    };
  }

  const groups = buildMessageGroups(input.messages);
  const selectedIndexes = new Set<number>();
  let selectedTokenCount = 0;

  for (const group of groups.filter((item) => item.mandatory)) {
    group.indexes.forEach((index) => selectedIndexes.add(index));
    selectedTokenCount += group.estimatedTokens;
  }

  const optionalGroups = groups
    .filter((item) => !item.mandatory)
    .sort((left, right) => right.priority - left.priority);

  for (const group of optionalGroups) {
    if (selectedTokenCount + group.estimatedTokens > inputBudgetTokens) {
      continue;
    }
    group.indexes.forEach((index) => selectedIndexes.add(index));
    selectedTokenCount += group.estimatedTokens;
  }

  const compacted = compactSelectedMessages(
    input.messages,
    selectedIndexes,
    inputBudgetTokens,
    policy.minimumMessageTokens,
  );
  const finalEstimatedTokens = compacted.messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );

  return {
    messages: compacted.messages,
    report: {
      contextWindowTokens: policy.contextWindowTokens,
      inputBudgetTokens,
      originalEstimatedTokens,
      finalEstimatedTokens,
      toolEstimatedTokens,
      droppedMessageCount: input.messages.length - compacted.messages.length,
      truncatedMessageCount: compacted.truncatedMessageCount,
      overflowTokens: Math.max(0, finalEstimatedTokens - inputBudgetTokens),
      budgetSatisfied: finalEstimatedTokens <= inputBudgetTokens,
      wasCompacted: true,
    },
  };
}
