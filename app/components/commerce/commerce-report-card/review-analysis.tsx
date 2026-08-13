"use client";
/**
 * 模块职责：Amazon 评论分析区块（评分分布 + 情感主题 + 评论样本）。
 * 复用现有 MetricBar 风格的 div 条形与 conic-gradient 环形，不引入图表库。
 */
import { useState } from "react";
import type { CommerceReviewAnalysis } from "../../../lib/commerce/types";

function RatingDistributionBar({
  star,
  count,
  total,
}: {
  star: number;
  count: number;
  total: number;
}) {
  const ratio = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 shrink-0 text-[9px] tabular-nums text-[var(--text-tertiary)]">
        {star} ★
      </span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--glass)]">
        <span
          className="block h-full rounded-full bg-[linear-gradient(90deg,#0a84ff,#64d2ff)] transition-[width] duration-500"
          style={{ width: `${ratio}%` }}
        />
      </div>
      <span className="w-6 shrink-0 text-right font-mono text-[9px] tabular-nums text-[var(--text-secondary)]">
        {count}
      </span>
    </div>
  );
}

function TopicChips({ topics }: { topics: string[] }) {
  if (!topics.length) return <span className="text-[9px] text-[var(--text-quaternary)]">暂无</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {topics.slice(0, 6).map((topic) => (
        <span
          key={topic}
          className="rounded-full border px-2 py-0.5 text-[9px] font-medium"
          style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
        >
          {topic}
        </span>
      ))}
    </div>
  );
}

function ReviewSample({
  sample,
}: {
  sample: CommerceReviewAnalysis["samples"][number];
}) {
  const stars = sample.rating ? "★".repeat(Math.max(1, Math.min(5, Math.round(sample.rating)))) : "—";
  return (
    <div className="rounded-[10px] border border-[var(--border)] bg-[var(--glass-soft)] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] font-semibold text-[var(--text-primary)]">
          {stars}
        </span>
        <span className="truncate text-[9px] text-[var(--text-quaternary)]">
          {sample.verifiedPurchase ? "已验证购买" : "未验证"} · {sample.date || "日期未知"}
        </span>
      </div>
      {sample.title && (
        <div className="mt-1 text-[10px] font-medium text-[var(--text-primary)]">
          {sample.title}
        </div>
      )}
      {sample.text && (
        <p className="mt-0.5 line-clamp-2 text-[9px] leading-4 text-[var(--text-secondary)]">
          {sample.text}
        </p>
      )}
    </div>
  );
}

export function ReviewAnalysisBlock({
  analyses,
}: {
  analyses: CommerceReviewAnalysis[];
}) {
  const [expanded, setExpanded] = useState<string | null>(analyses[0]?.asin ?? null);
  if (!analyses.length) return null;

  return (
    <div className="border-t border-[var(--border)] px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold text-[var(--text-primary)]">
            Amazon 评论分析
          </div>
          <div className="mt-0.5 text-[9px] text-[var(--text-tertiary)]">
            对评论数最高的 {analyses.length} 个商品采集公开评论并提炼口碑重点
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {analyses.map((analysis) => {
          const isDemo = analysis.dataSource.isDemo;
          const isOpen = expanded === analysis.asin;
          const ratio = analysis.stats.positiveRatio ?? 0;
          const average = analysis.stats.averageRating;
          const sentiment = analysis.sentiment;
          return (
            <div
              key={analysis.asin}
              className="overflow-hidden rounded-[13px] border border-[var(--border)] bg-[var(--glass-soft)]"
            >
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : analysis.asin)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--glass-hover)]"
              >
                <div className="min-w-0">
                  <div className="truncate text-[10px] font-semibold text-[var(--text-primary)]">
                    {analysis.productTitle}
                  </div>
                  <div className="mt-0.5 text-[9px] text-[var(--text-tertiary)]">
                    {analysis.stats.sampleSize} 条 · 均分 {average ?? "—"} ·{" "}
                    {isDemo ? "演示样本" : "公开评论"}
                  </div>
                </div>
                {isDemo && (
                  <span
                    className="shrink-0 rounded-full px-2 py-0.5 text-[8px] font-semibold"
                    style={{
                      color: "#ff9f0a",
                      background: "rgba(255,159,10,0.12)",
                    }}
                  >
                    演示
                  </span>
                )}
                <span className="shrink-0 text-[9px] text-[var(--text-tertiary)]">
                  {isOpen ? "收起 ▾" : "展开 ▸"}
                </span>
              </button>

              {isOpen && (
                <div className="space-y-3 border-t border-[var(--border)] px-3 py-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <div
                      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full"
                      style={{
                        background: `conic-gradient(#30d158 ${ratio * 100}%, var(--glass) ${ratio * 100}% 100%)`,
                      }}
                    >
                      <div className="flex h-[38px] w-[38px] items-center justify-center rounded-full bg-[var(--glass-solid)] font-mono text-[10px] font-semibold text-[var(--text-primary)]">
                        {Math.round(ratio * 100)}%
                      </div>
                    </div>
                    <div className="min-w-[180px] flex-1 space-y-1.5">
                      <RatingDistributionBar
                        star={5}
                        count={analysis.stats.ratingDistribution["5"] ?? 0}
                        total={analysis.stats.sampleSize}
                      />
                      <RatingDistributionBar
                        star={4}
                        count={analysis.stats.ratingDistribution["4"] ?? 0}
                        total={analysis.stats.sampleSize}
                      />
                      <RatingDistributionBar
                        star={3}
                        count={analysis.stats.ratingDistribution["3"] ?? 0}
                        total={analysis.stats.sampleSize}
                      />
                      <RatingDistributionBar
                        star={2}
                        count={analysis.stats.ratingDistribution["2"] ?? 0}
                        total={analysis.stats.sampleSize}
                      />
                      <RatingDistributionBar
                        star={1}
                        count={analysis.stats.ratingDistribution["1"] ?? 0}
                        total={analysis.stats.sampleSize}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 text-[9px] font-semibold text-[var(--text-secondary)]">
                      口碑总结{analysis.sentimentSource === "llm" ? "（LLM 增强）" : ""}
                    </div>
                    <p className="text-[10px] leading-5 text-[var(--text-secondary)]">
                      {sentiment.summary}
                    </p>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[9px] font-semibold text-[var(--text-secondary)]">
                        正面重点
                      </div>
                      <TopicChips topics={analysis.positiveTopics} />
                    </div>
                    <div>
                      <div className="mb-1 text-[9px] font-semibold text-[var(--text-secondary)]">
                        负面重点
                      </div>
                      <TopicChips topics={analysis.negativeTopics} />
                    </div>
                  </div>

                  {sentiment.keyFindings && sentiment.keyFindings.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[9px] font-semibold text-[var(--text-secondary)]">
                        关键发现
                      </div>
                      <ul className="list-disc space-y-0.5 pl-4 text-[9px] leading-4 text-[var(--text-secondary)]">
                        {sentiment.keyFindings.map((finding) => (
                          <li key={finding}>{finding}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div>
                    <div className="mb-1.5 text-[9px] font-semibold text-[var(--text-secondary)]">
                      评论样本
                    </div>
                    <div className="space-y-1.5">
                      {analysis.samples.map((sample, index) => (
                        <ReviewSample key={index} sample={sample} />
                      ))}
                    </div>
                  </div>

                  {analysis.warnings.length > 0 && (
                    <div className="space-y-0.5 text-[8px] leading-4 text-[var(--text-quaternary)]">
                      {analysis.warnings.map((warning) => (
                        <p key={warning}>• {warning}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
