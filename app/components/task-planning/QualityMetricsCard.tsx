// 模块说明：以 Apple 风格玻璃卡片展示 Code Agent 的质量与 Token 指标。
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
 * 展示后端真实质量门结果和上下文压缩收益。
 *
 * 最终质量报告尚未产生时仍显示运行中的 Token 与 Work 指标，避免卡片闪烁消失。
 */
export default function QualityMetricsCard({
  snapshot,
}: QualityMetricsCardProps) {
  const quality = snapshot.quality;
  const metrics = snapshot.metrics;
  if (!quality && !metrics) {
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
    </section>
  );
}
