// 模块说明：根据相关性、时效性、重要性、访问频率和多样性排序记忆。
import { createHash } from "crypto";
import { estimateTextTokens } from "./context-budget-manager";

export type MemorySource =
  | "short_term"
  | "recent_conversation"
  | "working"
  | "worker"
  | "long_term";

export interface MemoryCandidate {
  id?: string;
  content: string;
  source: MemorySource;
  createdAt?: string | number | Date;
  importance?: number;
  /** 数据库持久化的访问次数，会与进程内热度共同参与排序。 */
  accessCount?: number;
  lastAccessedAt?: string | number | Date;
}

export interface RankedMemory extends MemoryCandidate {
  id: string;
  score: number;
  relevanceScore: number;
  recencyScore: number;
  importanceScore: number;
  frequencyScore: number;
  estimatedTokens: number;
}

export interface MemoryRankingOptions {
  query: string;
  candidates: readonly MemoryCandidate[];
  limit?: number;
  maxTokens?: number;
  nowMs?: number;
}

interface AccessStat {
  count: number;
  lastAccessedAtMs: number;
}

interface MemoryRankingStore {
  access: Map<string, AccessStat>;
}

const GLOBAL_MEMORY_RANKING_KEY = Symbol.for("multi-agent.memory-ranking.v1");
const DEFAULT_LIMIT = 10;
const DEFAULT_MAX_TOKENS = 2_400;
const MAX_ACCESS_RECORDS = 2_000;
const IMPORTANCE_HINTS =
  /(决定|结论|要求|约束|错误|失败|修复|风险|禁止|必须|接口|路径|配置|版本|decision|constraint|error|failed|fix|risk|must|api|path|config|version)/giu;

type GlobalWithMemoryRanking = typeof globalThis & {
  [GLOBAL_MEMORY_RANKING_KEY]?: MemoryRankingStore;
};

function getStore(): MemoryRankingStore {
  const globalScope = globalThis as GlobalWithMemoryRanking;
  if (!globalScope[GLOBAL_MEMORY_RANKING_KEY]) {
    globalScope[GLOBAL_MEMORY_RANKING_KEY] = { access: new Map() };
  }
  return globalScope[GLOBAL_MEMORY_RANKING_KEY];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizeContent(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function createMemoryId(candidate: MemoryCandidate): string {
  if (candidate.id?.trim()) return candidate.id.trim();
  return createHash("sha256")
    .update(`${candidate.source}:${normalizeContent(candidate.content)}`)
    .digest("hex")
    .slice(0, 24);
}

function tokenize(value: string): Set<string> {
  const normalized = value.toLowerCase();
  const tokens = new Set<string>();
  const latinWords = normalized.match(/[a-z0-9_./:@-]{2,}/gu) || [];
  latinWords.forEach((word) => tokens.add(word));

  const cjk = normalized.match(/[\u3400-\u9fff]/gu) || [];
  cjk.forEach((character) => tokens.add(character));
  for (let index = 0; index < cjk.length - 1; index += 1) {
    tokens.add(`${cjk[index]}${cjk[index + 1]}`);
  }
  return tokens;
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / Math.sqrt(left.size * right.size);
}

function parseCreatedAt(value: MemoryCandidate["createdAt"]): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function calculateRecencyScore(
  candidate: MemoryCandidate,
  fallbackPosition: number,
  candidateCount: number,
  nowMs: number,
): number {
  const createdAtMs = parseCreatedAt(candidate.createdAt);
  if (createdAtMs !== null) {
    const ageDays = Math.max(0, nowMs - createdAtMs) / 86_400_000;
    return Math.exp(-ageDays / 30);
  }
  if (candidateCount <= 1) return 1;
  return 0.35 + 0.65 * (fallbackPosition / (candidateCount - 1));
}

function calculateImportanceScore(candidate: MemoryCandidate): number {
  if (
    candidate.importance !== undefined &&
    Number.isFinite(candidate.importance)
  ) {
    return clamp01(candidate.importance);
  }
  const content = candidate.content;
  const matches = content.match(IMPORTANCE_HINTS)?.length || 0;
  const structuralBonus = /\n|:|：|`|\/|\\/u.test(content) ? 0.12 : 0;
  const density = Math.min(0.35, matches * 0.07);
  const lengthBonus = Math.min(0.18, content.length / 1_500);
  return clamp01(0.3 + structuralBonus + density + lengthBonus);
}

function calculateFrequencyScore(
  candidate: MemoryCandidate,
  stat: AccessStat | undefined,
  nowMs: number,
): number {
  const persistedCount = Math.max(0, candidate.accessCount || 0);
  const processCount = Math.max(0, stat?.count || 0);
  const countScore = clamp01(
    Math.log1p(persistedCount + processCount) / Math.log(32),
  );
  const lastAccessedAtMs = parseCreatedAt(candidate.lastAccessedAt);
  if (lastAccessedAtMs === null) return countScore;

  const ageDays = Math.max(0, nowMs - lastAccessedAtMs) / 86_400_000;
  const accessRecency = Math.exp(-ageDays / 45);
  return clamp01(countScore * 0.75 + accessRecency * 0.25);
}

function deduplicateCandidates(
  candidates: readonly MemoryCandidate[],
): MemoryCandidate[] {
  const seen = new Set<string>();
  const result: MemoryCandidate[] = [];
  for (const candidate of candidates) {
    const content = normalizeContent(candidate.content);
    if (!content) continue;
    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...candidate, content });
  }
  return result;
}

function pruneAccessStore(store: MemoryRankingStore): void {
  if (store.access.size <= MAX_ACCESS_RECORDS) return;
  const oldest = Array.from(store.access.entries())
    .sort(
      (left, right) =>
        left[1].lastAccessedAtMs - right[1].lastAccessedAtMs,
    )
    .slice(0, store.access.size - MAX_ACCESS_RECORDS);
  oldest.forEach(([id]) => store.access.delete(id));
}

function updateAccessStats(
  selected: readonly RankedMemory[],
  nowMs: number,
): void {
  const store = getStore();
  selected.forEach((memory) => {
    const previous = store.access.get(memory.id);
    store.access.set(memory.id, {
      count: (previous?.count || 0) + 1,
      lastAccessedAtMs: nowMs,
    });
  });
  pruneAccessStore(store);
}

/**
 * 使用加权排序 + MMR 多样性选择，避免同一结论的多个近似表述占满预算。
 */
export function rankMemories(options: MemoryRankingOptions): RankedMemory[] {
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
  const maxTokens = Math.max(64, options.maxTokens ?? DEFAULT_MAX_TOKENS);
  const candidates = deduplicateCandidates(options.candidates);
  const queryTokens = tokenize(options.query);
  const store = getStore();

  const scored = candidates.map((candidate, index) => {
    const id = createMemoryId(candidate);
    const relevanceScore = similarity(queryTokens, tokenize(candidate.content));
    const recencyScore = calculateRecencyScore(
      candidate,
      index,
      candidates.length,
      nowMs,
    );
    const importanceScore = calculateImportanceScore(candidate);
    const frequencyScore = calculateFrequencyScore(
      candidate,
      store.access.get(id),
      nowMs,
    );
    const sourceBonus =
      candidate.source === "long_term"
        ? 0.05
        : candidate.source === "working"
          ? 0.03
          : 0;
    const score = clamp01(
      relevanceScore * 0.48 +
        recencyScore * 0.22 +
        importanceScore * 0.2 +
        frequencyScore * 0.1 +
        sourceBonus,
    );

    return {
      ...candidate,
      id,
      score,
      relevanceScore,
      recencyScore,
      importanceScore,
      frequencyScore,
      estimatedTokens: estimateTextTokens(candidate.content) + 12,
    };
  });

  const selected: RankedMemory[] = [];
  const remaining = [...scored];
  let usedTokens = 0;

  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestMmrScore = Number.NEGATIVE_INFINITY;

    remaining.forEach((candidate, index) => {
      const candidateTokens = tokenize(candidate.content);
      const highestSimilarity = selected.reduce(
        (maximum, selectedMemory) =>
          Math.max(
            maximum,
            similarity(candidateTokens, tokenize(selectedMemory.content)),
          ),
        0,
      );
      const mmrScore = candidate.score * 0.88 - highestSimilarity * 0.12;
      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore;
        bestIndex = index;
      }
    });

    const [next] = remaining.splice(bestIndex, 1);
    if (usedTokens + next.estimatedTokens > maxTokens) continue;
    selected.push(next);
    usedTokens += next.estimatedTokens;
  }

  updateAccessStats(selected, nowMs);
  return selected;
}

/** 仅供测试或进程级诊断使用，不应在业务请求中频繁调用。 */
export function resetMemoryRankingStats(): void {
  getStore().access.clear();
}
