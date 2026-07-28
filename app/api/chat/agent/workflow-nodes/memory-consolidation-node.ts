/**
 * Reflection 后的长期记忆沉淀节点。
 *
 * 该节点不调用大模型，只执行确定性安全策略：
 * - 仅 ACCEPT 且质量达标的结果允许晋升；
 * - 过滤一次性进度、过短内容和疑似敏感信息；
 * - 通过内容哈希去重，并限制每个项目的长期记忆规模。
 */
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { ReflectionMemoryCandidate } from "@/app/lib/agent-runtime/reflection-types";
import {
  createEmptyLongTermMemory,
  type LongTermMemorySnapshot,
} from "@/app/lib/agent-runtime/memory-types";
import {
  listLongTermMemories,
  pruneLongTermMemories,
  upsertLongTermMemories,
} from "@/app/lib/server/workspace-store/long-term-memory-repository";
import { recordAgentTraceEvent } from "@/app/lib/agent-runtime/trace-store";
import {
  type AgentRuntimeState,
  buildLifecycleStateUpdate,
  createLifecycleTracker,
} from "./runtime-lifecycle";

const MIN_PROMOTION_QUALITY = 0.75;
const MIN_MEMORY_IMPORTANCE = 0.58;
const MAX_MEMORY_LENGTH = 800;
const SENSITIVE_MEMORY_PATTERN =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization:\s*bearer|-----BEGIN [A-Z ]*PRIVATE KEY-----)/iu;
/** 邮箱、长电话号码和身份证号不应被自动固化到项目记忆。 */
const PERSONAL_DATA_PATTERN =
  /(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+?\d[\d -]{7,}\d)|\b\d{17}[\dXx]\b)/u;
const TRANSIENT_MEMORY_PATTERN =
  /(?:本轮|当前第\s*\d+\s*轮|刚刚调用|工具输出|临时文件|等待用户输入|正在执行)/u;

function normalizeCandidate(
  candidate: ReflectionMemoryCandidate,
): ReflectionMemoryCandidate | null {
  const content = candidate.content.trim().replace(/\s+/gu, " ");
  if (
    content.length < 12 ||
    content.length > MAX_MEMORY_LENGTH ||
    candidate.importance < MIN_MEMORY_IMPORTANCE ||
    SENSITIVE_MEMORY_PATTERN.test(content) ||
    PERSONAL_DATA_PATTERN.test(content) ||
    TRANSIENT_MEMORY_PATTERN.test(content)
  ) {
    return null;
  }

  return {
    ...candidate,
    content,
    importance: Math.min(1, Math.max(0, candidate.importance)),
  };
}

function canPromote(state: AgentRuntimeState): boolean {
  if (state.reflectionDecision !== "ACCEPT") return false;
  if ((state.reflectionPayload?.qualityScore || 0) < MIN_PROMOTION_QUALITY) {
    return false;
  }
  if (state.reviewDecision !== "PASS") return false;
  if (state.mergeResult?.status !== "success") return false;
  return state.verificationResult?.overall !== "failed";
}

export async function memoryConsolidationNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    `memory_consolidation_${state.reviewIteration || 0}`,
    "memory_consolidation_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("CONSOLIDATING", "正在审核并沉淀可复用长期记忆。");

  if (!state.projectId) {
    const summary = "当前会话未绑定项目，跳过项目级长期记忆写入。";
    tracker.transition("COMPLETED", summary);
    return {
      memoryConsolidationSummary: summary,
      ...buildLifecycleStateUpdate(tracker),
    };
  }

  const promotionAllowed = canPromote(state);
  const normalizedCandidates = promotionAllowed
    ? (state.reflectionPayload?.memoryCandidates || [])
        .map(normalizeCandidate)
        .filter(
          (candidate): candidate is ReflectionMemoryCandidate =>
            candidate !== null,
        )
    : [];
  const uniqueCandidates = Array.from(
    new Map(
      normalizedCandidates.map((candidate) => [
        candidate.content.toLowerCase(),
        candidate,
      ]),
    ).values(),
  ).slice(0, 8);

  let promotedCount = 0;
  let prunedCount = 0;
  let items = [] as ReturnType<typeof listLongTermMemories>;
  try {
    promotedCount = upsertLongTermMemories(
      state.projectId,
      uniqueCandidates,
    ).length;
    prunedCount = pruneLongTermMemories(state.projectId, 300);
    items = listLongTermMemories(state.projectId, 160);
  } catch (error) {
    const summary = `长期记忆写入失败: ${
      error instanceof Error ? error.message : String(error)
    }`;
    tracker.transition("FAILED", summary);
    recordAgentTraceEvent("memory", "memory_consolidation", "error", {
      projectId: state.projectId,
      promotionAllowed,
      candidateCount: uniqueCandidates.length,
      error: summary,
    });
    return {
      memoryConsolidationSummary: summary,
      ...buildLifecycleStateUpdate(tracker),
    };
  }

  const longTermMemory: LongTermMemorySnapshot = {
    items,
    selectedIds: state.longTermMemory?.selectedIds || [],
    updatedAt: new Date().toISOString(),
  };
  const summary = promotionAllowed
    ? `长期记忆审核完成：候选 ${normalizedCandidates.length} 条，晋升/更新 ${promotedCount} 条，淘汰 ${prunedCount} 条。`
    : `Reflection 结果未满足晋升条件，本轮没有写入长期记忆。`;

  tracker.transition("COMPLETED", summary);
  recordAgentTraceEvent("memory", "memory_consolidation", "info", {
    projectId: state.projectId,
    promotionAllowed,
    qualityScore: state.reflectionPayload?.qualityScore || 0,
    candidateCount: normalizedCandidates.length,
    promotedCount,
    prunedCount,
    totalLongTermMemories: items.length,
  });

  return {
    longTermMemory: items.length
      ? longTermMemory
      : createEmptyLongTermMemory(),
    memoryConsolidationSummary: summary,
    ...buildLifecycleStateUpdate(tracker),
  };
}
