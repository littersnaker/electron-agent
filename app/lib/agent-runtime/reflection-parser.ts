/** Reflection 模型 JSON 的安全解析与归一化。 */
import type {
  ReflectionDecision,
  ReflectionMemoryCandidate,
  ReflectionPayload,
  ReflectionScores,
} from "./reflection-types";

const VALID_MEMORY_CATEGORIES = new Set([
  "preference",
  "constraint",
  "architecture",
  "decision",
  "lesson",
]);

function clamp01(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function normalizeStringArray(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean)),
  ).slice(0, limit);
}

function normalizeRetryTasks(
  value: unknown,
  taskCount: number,
): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item))
        .filter((item) => item >= 0 && item < taskCount),
    ),
  );
}

function normalizeScores(value: unknown): ReflectionScores {
  const scores =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    requirementCoverage: clamp01(scores.requirementCoverage),
    correctness: clamp01(scores.correctness),
    verification: clamp01(scores.verification),
    safety: clamp01(scores.safety),
    maintainability: clamp01(scores.maintainability),
  };
}

function normalizeMemoryCandidates(
  value: unknown,
): ReflectionMemoryCandidate[] {
  if (!Array.isArray(value)) return [];
  const result: ReflectionMemoryCandidate[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const category = String(record.category || "");
    const content = String(record.content || "").trim().replace(/\s+/gu, " ");
    if (!VALID_MEMORY_CATEGORIES.has(category) || !content) continue;
    result.push({
      category: category as ReflectionMemoryCandidate["category"],
      content: content.slice(0, 800),
      importance: clamp01(record.importance, 0.6),
    });
  }

  return result.slice(0, 8);
}

/** 容忍模型附带代码块或说明文字，但最终始终返回受控结构。 */
export function parseReflectionPayload(
  content: string,
  taskCount: number,
): ReflectionPayload | null {
  const trimmed = content.trim();
  const objectMatch = trimmed.match(/\{[\s\S]*\}/u);
  const candidates = [trimmed, objectMatch?.[0] || ""].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const decision = String(parsed.decision || "").toUpperCase();
      if (!["ACCEPT", "REVISE", "STOP"].includes(decision)) continue;
      const scores = normalizeScores(parsed.scores);
      const meanScore =
        Object.values(scores).reduce((total, score) => total + score, 0) / 5;
      return {
        decision: decision as ReflectionDecision,
        qualityScore: clamp01(parsed.qualityScore, meanScore),
        scores,
        diagnosis: String(parsed.diagnosis || "Reflection 未提供诊断。")
          .trim()
          .slice(0, 2_000),
        lessons: normalizeStringArray(parsed.lessons),
        retryTasks: normalizeRetryTasks(parsed.retryTasks, taskCount),
        memoryCandidates: normalizeMemoryCandidates(parsed.memoryCandidates),
      };
    } catch {
      continue;
    }
  }

  return null;
}
