// 模块说明：以 Apple 风格玻璃卡片展示 Code Agent 的质量、Token 与性能指标。
import type { WorkListSnapshotPayload } from "../../types/workspace";

interface QualityMetricsCardProps {
  snapshot: WorkListSnapshotPayload;
}

/**
 * 把 Token 数转换为紧凑但可读的界面文案。
 *
 * 该函数仅负责展示格式，不改变后端提供的真实统计值。
 */
function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(value);
}

/** 五维质量分的中文标签。 */
const QUALITY_DIMENSION_LABELS: Record<string, string> = {
  validation: "验证",
  risk: "风险",
  review: "审核",
  process: "过程",
  efficiency: "效率",
};

/** 性能行：TTFT / tok/s / 总 token。 */
function PerformanceRow({ snapshot }: { snapshot: WorkListSnapshotPayload }) {
  const step = snapshot.stepMetrics;
  if (!step || step.steps === 0) return null;
  const ttft =
    step.avgTtftMs != null ? `${(step.avgTtftMs / 1000).toFixed(1)}s` : "—";
  const tps = step.avgTokPerSec != null ? `${step.avgTokPerSec}` : "—";
  const totalTokens = step.totalPromptTokens + step.totalCompletionTokens;
  return (
    <div
      className="mt-2 flex items-center justify-between rounded-[10px] px-2.5 py-1.5 font-mono text-[8px] tabular-nums"
      style={{
        color: "var(--text-tertiary)",
        background: "rgba(0,0,0,0.07)",
      }}
      title={`${step.steps} 次 LLM 调用 · prompt ${step.totalPromptTokens} · completion ${step.totalCompletionTokens} · cached ${step.totalCachedTokens}`}
    >
      <span>TTFT {ttft}</span>
      <span>{tps} tok/s</span>
      <span>Total {formatTokenCount(totalTokens)}</span>
    </div>
  );
}

/** 质量分：主分数 + 五维条形（无数据维度显示 —，不显示 0）。 */
function QualityScoreRow({ snapshot }: { snapshot: WorkListSnapshotPayload }) {
  const qualityScore = snapshot.quality?.qualityScore;
  if (!qualityScore) return null;
  const score = qualityScore.score;
  const scoreTone =
    score == null
      ? "var(--text-quaternary)"
      : score >= 80
        ? "var(--accent-green)"
        : score >= 60
          ? "#ff9f0a"
          : "var(--accent-red)";
  return (
    <div className="mt-2 rounded-[12px] border px-2.5 py-2" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-center justify-between">
        <span className="text-[8px] font-medium" style={{ color: "var(--text-tertiary)" }}>
          Quality Score
        </span>
        <span
          className="font-mono text-[13px] font-semibold tabular-nums"
          style={{ color: scoreTone }}
        >
          {score == null ? "—" : Math.round(score)}
        </span>
      </div>
      <div className="mt-2 space-y-1.5">
        {Object.entries(QUALITY_DIMENSION_LABELS).map(([key, label]) => {
          const value = qualityScore.dimensions[key];
          const hasValue = typeof value === "number";
          return (
            <div key={key} className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-[8px]" style={{ color: "var(--text-tertiary)" }}>
                {label}
              </span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--glass)]">
                <span
                  className="block h-full rounded-full bg-[linear-gradient(90deg,#0a84ff,#64d2ff)]"
                  style={{ width: hasValue ? `${Math.max(0, Math.min(100, value))}%` : "0%" }}
                />
              </div>
              <span className="w-6 shrink-0 text-right font-mono text-[8px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
                {hasValue ? Math.round(value) : "—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 渲染一个带状态圆点的质量指标单元。
 *
 * 颜色仅用于快速识别结果，文字始终保留，确保不能只依赖颜色判断状态。
 */
function MetricCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div
      className="rounded-[12px] border px-2.5 py-2"
      style={{
        background: "rgba(255,255,255,0.035)",
        borderColor: "var(--border)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.055)",
      }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: tone, boxShadow: `0 0 8px ${tone}` }}
        />
        <span
          className="text-[8px] font-medium"
          style={{ color: "var(--text-tertiary)" }}
        >
          {label}
        </span>
      </div>
      <div
        className="mt-1 truncate font-mono text-[11px] font-semibold tabular-nums"
        style={{ color: "var(--text-primary)" }}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * 展示后端真实质量门结果、Token、性能与质量分指标。
 *
 * 最终质量报告尚未产生时仍显示运行中的 Token 与 Work 指标，避免卡片闪烁消失。
 */
export default function QualityMetricsCard({
  snapshot,
}: QualityMetricsCardProps) {
  const quality = snapshot.quality;
  const metrics = snapshot.metrics;
  if (!quality && !metrics && !snapshot.stepMetrics) {
    return null;
  }

  const riskTone =
    quality?.risk === "high"
      ? "var(--accent-red)"
      : quality?.risk === "medium"
        ? "#ff9f0a"
        : "var(--accent-green)";
  const validationTone = quality?.validationPassed
    ? "var(--accent-green)"
    : quality?.validationExecuted
      ? "var(--accent-red)"
      : "var(--text-quaternary)";
  const regressionTone = quality?.regression
    ? "var(--accent-red)"
    : "var(--accent-green)";

  return (
    <section
      className="mb-3 rounded-[16px] border p-2.5"
      style={{
        background:
          "linear-gradient(145deg, rgba(255,255,255,0.065), rgba(255,255,255,0.025))",
        borderColor: "var(--border)",
        boxShadow:
          "0 10px 30px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.08)",
        backdropFilter: "blur(24px) saturate(145%)",
        WebkitBackdropFilter: "blur(24px) saturate(145%)",
      }}
    >
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span
          className="text-[9px] font-semibold tracking-[-0.01em]"
          style={{ color: "var(--text-secondary)" }}
        >
          Engineering Quality
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-[8px] font-medium"
          style={{
            color: quality?.codeGatePassed
              ? "var(--accent-green)"
              : "var(--text-tertiary)",
            background: quality?.codeGatePassed
              ? "rgba(48,209,88,0.10)"
              : "var(--glass)",
          }}
        >
          {quality
            ? quality.codeGatePassed
              ? "Quality Gate Passed"
              : "Review Required"
            : "Running"}
        </span>
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        <MetricCell
          label="Changes"
          value={String(quality?.changes ?? 0)}
          tone="#64b5ff"
        />
        <MetricCell
          label="Risk"
          value={quality ? `${quality.riskScore}` : "—"}
          tone={riskTone}
        />
        <MetricCell
          label="Validation"
          value={quality?.validationPassed ? "Passed" : "Pending"}
          tone={validationTone}
        />
        <MetricCell
          label="Regression"
          value={quality?.regression ? "Detected" : "None"}
          tone={regressionTone}
        />
      </div>

      {metrics && (
        <div
          className={
            "mt-2 flex items-center justify-between rounded-[10px] px-2.5 " +
            "py-1.5 font-mono text-[8px] tabular-nums"
          }
          style={{
            color: "var(--text-tertiary)",
            background: "rgba(0,0,0,0.07)",
          }}
        >
          <span>Total {formatTokenCount(metrics.totalTokens)}</span>
          <span>Active {formatTokenCount(metrics.activeTokens)}</span>
          <span>
            Compressed {formatTokenCount(metrics.compressedTokens)}
          </span>
          <span>Retry {metrics.retryCount}</span>
        </div>
      )}

      <PerformanceRow snapshot={snapshot} />
      <QualityScoreRow snapshot={snapshot} />
    </section>
  );
}
