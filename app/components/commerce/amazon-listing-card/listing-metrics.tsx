"use client";

import type { AmazonListingScore } from "../../../lib/commerce/listing/types";

const METRICS: Array<{ key: keyof AmazonListingScore; label: string }> = [
  { key: "compliance", label: "合规" },
  { key: "keywordCoverage", label: "关键词" },
  { key: "completeness", label: "完整度" },
  { key: "readability", label: "可读性" },
  { key: "factualSafety", label: "事实安全" },
];

export function ListingMetrics({ score }: { score: AmazonListingScore }) {
  return (
    <div className="grid gap-2 sm:grid-cols-5">
      {METRICS.map((metric) => (
        <div
          key={metric.key}
          className="rounded-[12px] border border-[var(--border)] bg-[var(--glass-soft)] px-2.5 py-2"
        >
          <div className="flex items-center justify-between text-[9px] text-[var(--text-tertiary)]">
            <span>{metric.label}</span>
            <span className="font-mono">{score[metric.key]}</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--glass)]">
            <div
              className="h-full rounded-full bg-[var(--accent-blue)]"
              style={{ width: `${score[metric.key]}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
