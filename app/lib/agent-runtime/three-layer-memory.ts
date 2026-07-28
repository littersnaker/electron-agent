/**
 * 三层记忆的构建、更新与提示词格式化工具。
 *
 * 这里不直接访问数据库，也不调用大模型：
 * - 数据库读写由 long-term-memory-repository 负责；
 * - 记忆排序继续复用 Memory Ranking；
 * - 本模块只负责把不同层的数据转换成统一候选项。
 */
import { createHash } from "crypto";
import type { BaseMessage } from "@langchain/core/messages";
import type { MemoryCandidate, RankedMemory } from "./memory-ranking";
import {
  clampMemoryImportance,
  createEmptyWorkingMemory,
  type LayeredMemoryItem,
  type LongTermMemorySnapshot,
  type ShortTermMemorySnapshot,
  type WorkingMemoryPhase,
  type WorkingMemorySnapshot,
} from "./memory-types";

const SHORT_TERM_LIMIT = 12;
const WORKING_MEMORY_ITEM_LIMIT = 12;

function normalizeText(value: string): string {
  return value
    .replace(
      /<INTERNAL_THINK_START>[\s\S]*?<INTERNAL_THINK_END>/gu,
      "",
    )
    .trim()
    .replace(/\s+/gu, " ");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

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
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function createStableId(prefix: string, content: string): string {
  return `${prefix}-${createHash("sha256")
    .update(normalizeText(content))
    .digest("hex")
    .slice(0, 20)}`;
}

function uniqueLimited(values: readonly string[], limit = 12): string[] {
  return Array.from(
    new Set(values.map(normalizeText).filter(Boolean)),
  ).slice(0, limit);
}

/**
 * 从主线程消息构建短期记忆。
 * 最新用户消息是当前任务本身，不重复写入“历史记忆”，避免上下文重复占用预算。
 */
export function buildShortTermMemory(
  messages: readonly BaseMessage[],
  maxItems = SHORT_TERM_LIMIT,
): ShortTermMemorySnapshot {
  const nonToolMessages = messages.filter(
    (message) => message._getType() !== "tool",
  );
  let latestHumanIndex = -1;
  nonToolMessages.forEach((message, index) => {
    if (message._getType() === "human") latestHumanIndex = index;
  });

  const now = Date.now();
  const selected = nonToolMessages
    .filter((_message, index) => index !== latestHumanIndex)
    .slice(-maxItems);
  const items = selected.map((message, index): LayeredMemoryItem => {
    const role = message._getType();
    const content = normalizeText(`${role}: ${contentToText(message.content)}`);
    const createdAt = new Date(
      now - (selected.length - index) * 60_000,
    ).toISOString();

    return {
      id: message.id
        ? `stm-${String(message.id)}`
        : createStableId("stm", content),
      layer: "short_term",
      content,
      category: "conversation",
      importance: role === "human" ? 0.68 : 0.52,
      createdAt,
      updatedAt: createdAt,
      lastAccessedAt: createdAt,
      accessCount: 0,
    };
  });

  return {
    items,
    maxItems,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 以不可变方式推进工作记忆。
 * 调用方只提交发生变化的字段，函数负责去重、裁剪和更新时间。
 */
export function advanceWorkingMemory(
  previous: WorkingMemorySnapshot | undefined,
  update: Partial<Omit<WorkingMemorySnapshot, "updatedAt">> & {
    phase?: WorkingMemoryPhase;
  },
): WorkingMemorySnapshot {
  const base = previous || createEmptyWorkingMemory(update.goal || "");
  return {
    goal: normalizeText(update.goal ?? base.goal),
    phase: update.phase ?? base.phase,
    activeTaskIds: uniqueLimited(
      update.activeTaskIds ?? base.activeTaskIds,
      WORKING_MEMORY_ITEM_LIMIT,
    ),
    completedTaskIds: uniqueLimited(
      update.completedTaskIds ?? base.completedTaskIds,
      WORKING_MEMORY_ITEM_LIMIT,
    ),
    pendingTaskIds: uniqueLimited(
      update.pendingTaskIds ?? base.pendingTaskIds,
      WORKING_MEMORY_ITEM_LIMIT,
    ),
    keyFacts: uniqueLimited(
      update.keyFacts ?? base.keyFacts,
      WORKING_MEMORY_ITEM_LIMIT,
    ),
    risks: uniqueLimited(update.risks ?? base.risks, WORKING_MEMORY_ITEM_LIMIT),
    iteration: Math.max(0, update.iteration ?? base.iteration),
    updatedAt: new Date().toISOString(),
  };
}

export function shortTermToCandidates(
  snapshot: ShortTermMemorySnapshot,
): MemoryCandidate[] {
  return snapshot.items.map((item) => ({
    id: item.id,
    content: item.content,
    source: "short_term",
    createdAt: item.createdAt,
    importance: item.importance,
    accessCount: item.accessCount,
    lastAccessedAt: item.lastAccessedAt,
  }));
}

/** 把当前任务状态拆成少量可排序的工作记忆候选项。 */
export function workingMemoryToCandidates(
  snapshot: WorkingMemorySnapshot,
): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  const push = (content: string, importance: number): void => {
    const normalized = normalizeText(content);
    if (!normalized) return;
    candidates.push({
      id: createStableId("wm", normalized),
      content: normalized,
      source: "working",
      createdAt: snapshot.updatedAt,
      importance,
    });
  };

  push(`当前目标: ${snapshot.goal}`, 0.95);
  push(`执行阶段: ${snapshot.phase}; 迭代: ${snapshot.iteration}`, 0.72);
  if (snapshot.activeTaskIds.length) {
    push(`活动任务: ${snapshot.activeTaskIds.join(", ")}`, 0.82);
  }
  if (snapshot.pendingTaskIds.length) {
    push(`待完成任务: ${snapshot.pendingTaskIds.join(", ")}`, 0.88);
  }
  snapshot.keyFacts.forEach((fact) => push(`关键事实: ${fact}`, 0.84));
  snapshot.risks.forEach((risk) => push(`当前风险: ${risk}`, 0.94));
  return candidates.slice(0, WORKING_MEMORY_ITEM_LIMIT);
}

export function longTermToCandidates(
  snapshot: LongTermMemorySnapshot,
): MemoryCandidate[] {
  return snapshot.items.map((item) => ({
    id: item.id,
    content: item.content,
    source: "long_term",
    createdAt: item.updatedAt,
    importance: clampMemoryImportance(item.importance),
    accessCount: item.accessCount,
    lastAccessedAt: item.lastAccessedAt,
  }));
}

/**
 * 给 Planner/Worker 的记忆上下文同时展示层级与排序分值。
 * 排序只决定“送进上下文的顺序”，不会改变数据库中的原始内容。
 */
export function formatThreeLayerMemoryContext(
  selected: readonly RankedMemory[],
): string {
  if (!selected.length) return "暂无可用记忆。";

  const layerNames: Record<RankedMemory["source"], string> = {
    short_term: "STM",
    recent_conversation: "STM",
    working: "WM",
    worker: "WM",
    long_term: "LTM",
  };

  return selected
    .map(
      (memory, index) =>
        `${index + 1}. [${layerNames[memory.source]}; score=${memory.score.toFixed(3)}] ${memory.content}`,
    )
    .join("\n\n");
}
