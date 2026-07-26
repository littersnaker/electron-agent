// 模块说明：负责 evaluation 核心服务与领域逻辑。
import { createHash } from "crypto";
import type {
  MergeResult,
  ModifyTaskResult,
  ReviewPayload,
  VerificationResult,
} from "@/app/api/chat/agent/types";
import {
  getAgentTraceToolStats,
  getCurrentAgentTraceContext,
  saveAgentEvaluation,
} from "./trace-store";

export const AGENT_EVALUATION_ENGINE = "ragas-compatible-heuristic-v1";

export interface AgentEvaluationMetric {
  score: number;
  label: string;
  explanation: string;
  /** 本轮是否具备计算该指标所需的上下文或执行证据。 */
  applicable: boolean;
}

export interface AgentEvaluationReport {
  id: string;
  traceId: string | null;
  engine: typeof AGENT_EVALUATION_ENGINE;
  createdAt: string;
  ragas: {
    contextPrecision: AgentEvaluationMetric;
    contextRecall: AgentEvaluationMetric;
    faithfulness: AgentEvaluationMetric;
    responseRelevance: AgentEvaluationMetric;
  };
  agent: {
    goalAccuracy: AgentEvaluationMetric;
    toolCallAccuracy: AgentEvaluationMetric;
    taskCompletionRate: AgentEvaluationMetric;
    verificationScore: AgentEvaluationMetric;
  };
  overallScore: number;
  diagnosis: string[];
  /** 可直接交给 Python Ragas 离线实验的单轮样本。 */
  ragasSample: {
    user_input: string;
    response: string;
    retrieved_contexts: string[];
  };
}

export interface AgentEvaluationInput {
  projectId: string;
  /** 是否属于需要写文件并执行工程验证的代码变更任务。 */
  requiresChanges: boolean;
  userRequest: string;
  response: string;
  retrievedContexts: string[];
  modifyResults: ModifyTaskResult[];
  mergeResult: MergeResult;
  reviewPayload: ReviewPayload;
  reviewDecision: string;
  verificationResult: VerificationResult;
}

const MAX_SAMPLE_REQUEST_CHARACTERS = 2_000;
const MAX_SAMPLE_RESPONSE_CHARACTERS = 4_000;
const MAX_SAMPLE_CONTEXTS = 6;
const MAX_SAMPLE_CONTEXT_CHARACTERS = 2_500;

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "一个",
  "这个",
  "需要",
  "进行",
  "以及",
  "可以",
  "如何",
  "什么",
  "项目",
  "代码",
]);

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function roundScore(value: number): number {
  return Math.round(clampScore(value) * 1_000) / 1_000;
}

function tokenize(value: string): string[] {
  const latinTokens = value.toLowerCase().match(/[a-z0-9_./-]{2,}/gu) || [];
  const chineseTokens = value.match(/[\u4e00-\u9fff]{2,6}/gu) || [];
  return Array.from(new Set([...latinTokens, ...chineseTokens])).filter(
    (token) => !STOP_WORDS.has(token),
  );
}

function overlapScore(source: string, target: string): number {
  const sourceTokens = tokenize(source);
  if (!sourceTokens.length) return 1;
  const targetTokens = new Set(tokenize(target));
  const matched = sourceTokens.filter((token) => targetTokens.has(token)).length;
  return matched / sourceTokens.length;
}

function sentenceSupportScore(response: string, evidence: string): number {
  const statements = response
    .split(/[。！？!?\n]+/gu)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length >= 6)
    .slice(0, 30);
  if (!statements.length) return 1;

  const supported = statements.filter(
    (statement) => overlapScore(statement, evidence) >= 0.22,
  ).length;
  return supported / statements.length;
}

function buildMetric(
  score: number,
  label: string,
  explanation: string,
  applicable = true,
): AgentEvaluationMetric {
  return { score: roundScore(score), label, explanation, applicable };
}

function calculateContextPrecision(
  request: string,
  response: string,
  contexts: readonly string[],
): number {
  if (!contexts.length) return response.trim() ? 0 : 1;
  const target = `${request}\n${response}`;
  let weightedRelevant = 0;
  let totalWeight = 0;

  contexts.forEach((context, index) => {
    const weight = 1 / (index + 1);
    const relevance = overlapScore(target, context);
    weightedRelevant += weight * (relevance >= 0.08 ? 1 : relevance / 0.08);
    totalWeight += weight;
  });
  return totalWeight > 0 ? weightedRelevant / totalWeight : 0;
}

function calculateTaskCompletion(results: readonly ModifyTaskResult[]): number {
  if (!results.length) return 1;
  const completed = results.filter((result) =>
    ["done", "satisfied", "skipped"].includes(result.status),
  ).length;
  return completed / results.length;
}

function calculateVerificationScore(
  verification: VerificationResult,
): number {
  if (verification.overall === "passed") return 1;
  if (verification.overall === "skipped") return 0.65;
  if (verification.overall === "failed") return 0.15;
  return 0.4;
}

function truncateSampleText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  return `${value.slice(0, maxCharacters)}\n...[评估样本已截断]`;
}

/**
 * 运行低成本在线评估。
 *
 * Ragas 官方实现以 Python/LLM Judge 为主；本项目是 TypeScript 桌面应用，因此在线
 * 链路采用同名维度的确定性近似指标，避免每次任务额外调用多个 Judge 模型。
 * report.ragasSample 同时保留 Ragas 标准字段，可定期导出到 Python Ragas 做离线校准。
 */
export function evaluateAgentRun(
  input: AgentEvaluationInput,
): AgentEvaluationReport {
  const traceContext = getCurrentAgentTraceContext();
  const toolStats = traceContext
    ? getAgentTraceToolStats(traceContext.traceId)
    : { total: 0, succeeded: 0, failed: 0, repaired: 0 };
  const contexts = input.retrievedContexts.filter(Boolean).slice(0, 12);
  const hasRetrievedContext = contexts.length > 0;
  const hasExecutionEvidence = input.modifyResults.length > 0;
  const faithfulnessApplicable =
    hasRetrievedContext || hasExecutionEvidence;
  const combinedContext = contexts.join("\n\n");
  const evidence = [
    combinedContext,
    JSON.stringify(input.mergeResult),
    JSON.stringify(input.reviewPayload),
    JSON.stringify(input.verificationResult),
  ].join("\n\n");

  const contextPrecision = hasRetrievedContext
    ? calculateContextPrecision(input.userRequest, input.response, contexts)
    : 1;
  const contextRecall = hasRetrievedContext
    ? overlapScore(input.userRequest, combinedContext)
    : 1;
  const faithfulness = faithfulnessApplicable
    ? sentenceSupportScore(input.response, evidence)
    : 1;
  const responseRelevance = overlapScore(input.userRequest, input.response);
  const taskCompletionRate = calculateTaskCompletion(input.modifyResults);
  const verificationScore = calculateVerificationScore(
    input.verificationResult,
  );
  const toolCallApplicable = toolStats.total > 0;
  const toolCallAccuracy = toolCallApplicable
    ? toolStats.succeeded / toolStats.total
    : 1;
  const changeEvaluationApplicable = input.requiresChanges;
  const mergeScore =
    input.mergeResult.status === "success"
      ? 1
      : input.mergeResult.status === "blocked"
        ? 0.5
        : 0;
  const changeGoalAccuracy = [
    input.reviewDecision === "PASS"
      ? 1
      : input.reviewDecision === "RETRY"
        ? 0.5
        : 0,
    mergeScore,
    taskCompletionRate,
    verificationScore,
  ].reduce((sum, score) => sum + score, 0) / 4;
  const goalAccuracy = changeEvaluationApplicable
    ? changeGoalAccuracy
    : responseRelevance;

  const weightedMetrics = [
    { score: contextPrecision, weight: 0.1, applicable: hasRetrievedContext },
    { score: contextRecall, weight: 0.1, applicable: hasRetrievedContext },
    { score: faithfulness, weight: 0.18, applicable: faithfulnessApplicable },
    { score: responseRelevance, weight: 0.12, applicable: true },
    { score: goalAccuracy, weight: 0.2, applicable: true },
    { score: toolCallAccuracy, weight: 0.1, applicable: toolCallApplicable },
    {
      score: taskCompletionRate,
      weight: 0.1,
      applicable: changeEvaluationApplicable,
    },
    {
      score: verificationScore,
      weight: 0.1,
      applicable: changeEvaluationApplicable,
    },
  ].filter((metric) => metric.applicable);
  const totalWeight = weightedMetrics.reduce(
    (sum, metric) => sum + metric.weight,
    0,
  );
  const overallScore = roundScore(
    totalWeight > 0
      ? weightedMetrics.reduce(
          (sum, metric) => sum + metric.score * metric.weight,
          0,
        ) / totalWeight
      : 0,
  );

  const diagnosis: string[] = [];
  if (hasRetrievedContext && contextPrecision < 0.6) {
    diagnosis.push("检索上下文中存在较多低相关片段，建议提高检索阈值或增加重排。");
  }
  if (hasRetrievedContext && contextRecall < 0.55) {
    diagnosis.push(
      "上下文没有覆盖用户请求中的关键概念，优先检查索引、切片和查询改写。",
    );
  }
  if (faithfulnessApplicable && faithfulness < 0.65) {
    diagnosis.push(
      "最终报告有部分陈述缺少执行证据支撑，应强化 Reviewer 的证据约束。",
    );
  }
  if (toolCallApplicable && toolCallAccuracy < 0.8) {
    diagnosis.push(
      "工具调用失败率偏高，应检查参数 Schema、自动修复记录和 MCP 服务健康度。",
    );
  }
  if (changeEvaluationApplicable && verificationScore < 0.6) {
    diagnosis.push("Lint/Build/Test 未通过，不能把本轮结果视为可交付状态。");
  }
  if (!diagnosis.length) {
    diagnosis.push(
      "本轮在线指标未发现明显短板，建议继续通过离线 Ragas 数据集做回归比较。",
    );
  }

  const createdAt = new Date().toISOString();
  const report: AgentEvaluationReport = {
    id: createHash("sha1")
      .update(`${traceContext?.traceId || "no-trace"}\0${createdAt}`)
      .digest("hex")
      .slice(0, 20),
    traceId: traceContext?.traceId || null,
    engine: AGENT_EVALUATION_ENGINE,
    createdAt,
    ragas: {
      contextPrecision: buildMetric(
        contextPrecision,
        "Context Precision",
        "高排名上下文是否与用户请求和最终回答相关。",
        hasRetrievedContext,
      ),
      contextRecall: buildMetric(
        contextRecall,
        "Context Recall",
        "检索上下文对用户请求关键概念的覆盖程度。",
        hasRetrievedContext,
      ),
      faithfulness: buildMetric(
        faithfulness,
        "Faithfulness",
        "最终报告中的陈述是否能从上下文、Merge、Review 和验证证据中得到支持。",
        faithfulnessApplicable,
      ),
      responseRelevance: buildMetric(
        responseRelevance,
        "Response Relevance",
        "最终报告是否直接覆盖用户原始目标。",
      ),
    },
    agent: {
      goalAccuracy: buildMetric(
        goalAccuracy,
        "Agent Goal Accuracy",
        "综合 Reviewer、Merge、任务完成率和工程验证判断目标完成度。",
      ),
      toolCallAccuracy: buildMetric(
        toolCallAccuracy,
        "Tool Call Accuracy",
        `本轮工具调用 ${toolStats.total} 次，成功 ${toolStats.succeeded} 次，自动修复 ${toolStats.repaired} 次。`,
        toolCallApplicable,
      ),
      taskCompletionRate: buildMetric(
        taskCompletionRate,
        "Task Completion Rate",
        "Planner 叶子任务进入 done/satisfied/skipped 的比例。",
        changeEvaluationApplicable,
      ),
      verificationScore: buildMetric(
        verificationScore,
        "Verification Score",
        `工程验证总体状态为 ${input.verificationResult.overall}。`,
        changeEvaluationApplicable,
      ),
    },
    overallScore,
    diagnosis,
    ragasSample: {
      user_input: truncateSampleText(
        input.userRequest,
        MAX_SAMPLE_REQUEST_CHARACTERS,
      ),
      response: truncateSampleText(
        input.response,
        MAX_SAMPLE_RESPONSE_CHARACTERS,
      ),
      retrieved_contexts: contexts
        .slice(0, MAX_SAMPLE_CONTEXTS)
        .map((context) =>
          truncateSampleText(context, MAX_SAMPLE_CONTEXT_CHARACTERS),
        ),
    },
  };

  if (traceContext) {
    saveAgentEvaluation(
      traceContext.traceId,
      input.projectId || traceContext.projectId,
      report.engine,
      report.overallScore,
      report as unknown as Record<string, unknown>,
    );
  }
  return report;
}

function formatMetricScore(metric: AgentEvaluationMetric): string {
  return metric.applicable ? (metric.score * 100).toFixed(1) : "N/A";
}

export function formatAgentEvaluation(report: AgentEvaluationReport): string {
  return [
    `在线评估总分: ${(report.overallScore * 100).toFixed(1)}/100`,
    `Context Precision: ${formatMetricScore(report.ragas.contextPrecision)}`,
    `Context Recall: ${formatMetricScore(report.ragas.contextRecall)}`,
    `Faithfulness: ${formatMetricScore(report.ragas.faithfulness)}`,
    `Response Relevance: ${formatMetricScore(report.ragas.responseRelevance)}`,
    `Agent Goal Accuracy: ${formatMetricScore(report.agent.goalAccuracy)}`,
    `Tool Call Accuracy: ${formatMetricScore(report.agent.toolCallAccuracy)}`,
    `Task Completion: ${formatMetricScore(report.agent.taskCompletionRate)}`,
    `Verification: ${formatMetricScore(report.agent.verificationScore)}`,
    `诊断:\n- ${report.diagnosis.join("\n- ")}`,
  ].join("\n");
}
