"use client";
/**
 * 模块职责：市场指标格式化和基础指标组件。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import type { CommerceMarketMetrics } from "../../../lib/commerce/types";
export function formatCompact(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString();
}

export function formatPrice(
  value: number | undefined,
  currency: string | undefined,
): string {
  if (value === undefined) return "—";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: currency === "JPY" ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency || ""} ${value.toFixed(2)}`.trim();
  }
}

export function scoreLabel(score: number): string {
  if (score >= 80) return "机会较强";
  if (score >= 65) return "值得验证";
  if (score >= 50) return "中性观察";
  return "谨慎进入";
}

export function MetricBar({
  label,
  score,
}: {
  label: string;
  score: number;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="text-[10px] font-medium text-[var(--text-secondary)]">
          {label}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-[var(--text-tertiary)]">
          {score}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[var(--glass)]">
        <span
          className="block h-full rounded-full bg-[linear-gradient(90deg,#0a84ff,#64d2ff)] transition-[width] duration-500"
          style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
        />
      </div>
    </div>
  );
}

export function MetricSnapshot({
  metrics,
  isDemo,
}: {
  metrics: CommerceMarketMetrics;
  isDemo: boolean;
}) {
  const snapshots = [
    {
      label: isDemo ? "演示样本" : "有效市场样本",
      value: `${metrics.sampleSize}`,
    },
    {
      label: "Shopping 结果",
      value: `${metrics.shoppingResultCount || 0}`,
    },
    {
      label: "可见域名",
      value: `${metrics.uniqueDomainCount || 0}`,
    },
    {
      label: "中位价格",
      value: formatPrice(metrics.medianPrice, metrics.currency),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {snapshots.map((item) => (
        <div
          key={item.label}
          className="rounded-[13px] border px-3 py-2.5"
          style={{
            background: "var(--glass-soft)",
            borderColor: "var(--border)",
          }}
        >
          <div className="text-[9px] text-[var(--text-tertiary)]">
            {item.label}
          </div>
          <div className="mt-1 truncate text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}
