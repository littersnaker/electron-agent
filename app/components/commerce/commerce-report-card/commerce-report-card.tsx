"use client";
/**
 * 模块职责：跨境市场研究报告主卡片组件。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { useMemo, useState } from "react";
import { exportCommerceReportPdf } from "../../../lib/commerce/pdf-export";
import { getCommerceRunModeMeta, resolveCommerceReportRunMode } from "../../../lib/commerce/run-mode";
import type { CommerceProductSignal, CommerceResearchReport } from "../../../lib/commerce/types";
import { MetricBar, MetricSnapshot, formatCompact, scoreLabel } from "./metric-widgets";
import { PlatformComparison, SourceCoverage } from "./source-coverage";
import { ObservationRow, ProductRow } from "./product-signal-rows";
import { ReviewAnalysisBlock } from "./review-analysis";
/**
 * Cross-border Market Intelligence Agent 的结构化结果卡片。
 *
 * 首先展示公开市场 observations；Amazon、TikTok Shop、Temu 与 1688
 * 都会明确显示来自 API 还是爬虫。只有所有真实来源都失败时才进入 Demo。
 */
export function CommerceReportCard({
  report,
}: {
  report: CommerceResearchReport;
}) {
  const runMode = resolveCommerceReportRunMode(report);
  const modeMeta = getCommerceRunModeMeta(runMode);
  const isDemo = runMode === "demo";
  const [showAllProducts, setShowAllProducts] = useState(false);
  const [showAllObservations, setShowAllObservations] = useState(false);
  const [pdfState, setPdfState] = useState<
    "idle" | "exporting" | "saved" | "error"
  >("idle");
  const products = useMemo(
    () => (showAllProducts ? report.products : report.products.slice(0, 6)),
    [report.products, showAllProducts],
  );
  const observations = report.observations || [];
  const visibleObservations = showAllObservations
    ? observations
    : observations.slice(0, 8);
  const score = report.metrics.opportunityScore;
  const handleExportPdf = async () => {
    if (pdfState === "exporting") return;
    setPdfState("exporting");
    try {
      const result = await exportCommerceReportPdf(report);
      setPdfState(result.canceled ? "idle" : "saved");
    } catch {
      setPdfState("error");
    }
  };

  const qualityLabel = isDemo
    ? "模拟数据 · 不可用于决策"
    : report.dataSource.quality === "high"
      ? "数据完整度高"
      : report.dataSource.quality === "medium"
        ? "数据完整度中等"
        : "数据完整度有限";

  return (
    <section
      className="mb-4 overflow-hidden rounded-[20px] border"
      style={{
        background:
          "linear-gradient(145deg, color-mix(in srgb, var(--glass-strong) 88%, transparent), var(--glass-soft))",
        borderColor: "var(--border)",
        boxShadow: "var(--shadow-soft), inset 0 1px 0 rgba(255,255,255,0.06)",
      }}
    >
      <div className="p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="rounded-full px-2 py-1 text-[9px] font-semibold"
                style={{
                  color: "#64b5ff",
                  background: "rgba(10,132,255,0.12)",
                }}
              >
                {report.marketplaceLabel}
              </span>
              <span
                className="rounded-full px-2 py-1 text-[9px] font-semibold"
                style={{
                  color: isDemo ? "#ff9f0a" : "#0a84ff",
                  background: isDemo
                    ? "rgba(255,159,10,0.12)"
                    : "rgba(10,132,255,0.10)",
                }}
              >
                {modeMeta.label}
              </span>
              <span className="text-[9px] text-[var(--text-tertiary)]">
                {qualityLabel}
              </span>
            </div>
            <h3 className="mt-2 truncate text-[16px] font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
              {report.category.categoryName}
            </h3>
            <p className="mt-1 max-w-[640px] text-[10px] leading-5 text-[var(--text-secondary)]">
              {report.category.researchGoal}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-3 rounded-[16px] border border-[var(--border)] bg-[var(--glass-soft)] px-3 py-2.5">
            <div
              className="flex h-12 w-12 items-center justify-center rounded-full"
              style={{
                background: `conic-gradient(#0a84ff ${score}%, var(--glass) ${score}% 100%)`,
              }}
            >
              <div className="flex h-[38px] w-[38px] items-center justify-center rounded-full bg-[var(--glass-solid)] font-mono text-[12px] font-semibold text-[var(--text-primary)]">
                {score}
              </div>
            </div>
            <div>
              <div className="text-[9px] text-[var(--text-tertiary)]">
                {isDemo
                  ? "Demo Signal"
                  : runMode === "full"
                    ? "Multi-source Signal"
                    : "Public Market Signal"}
              </div>
              <div className="mt-0.5 text-[12px] font-semibold text-[var(--text-primary)]">
                {isDemo ? "流程演示" : scoreLabel(score)}
              </div>
            </div>
          </div>
        </div>

        {isDemo && (
          <div
            className="mt-4 rounded-[13px] border px-3 py-2.5 text-[10px] leading-5"
            style={{
              background: "rgba(255,159,10,0.08)",
              borderColor: "rgba(255,159,10,0.22)",
              color: "var(--text-secondary)",
            }}
          >
            <strong style={{ color: "#ff9f0a" }}>无真实数据演示模式：</strong>
            当前没有取得真实外部市场数据。页面中的样本、价格和评分均为模拟内容，
            只用于验证完整流程，不能用于选品、采购、定价或投放决策。
          </div>
        )}

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => void handleExportPdf()}
            disabled={pdfState === "exporting"}
            className="flex items-center gap-2 rounded-[10px] border px-3 py-2 text-[10px] font-semibold transition-all hover:bg-[var(--glass-hover)] active:scale-[0.985] disabled:opacity-50"
            style={{
              borderColor: "var(--border)",
              color: pdfState === "error" ? "#ff453a" : "var(--text-primary)",
              background: "var(--glass-soft)",
            }}
            title="导出完整跨境市场情报 PDF"
          >
            <span aria-hidden="true">↓</span>
            {pdfState === "exporting"
              ? "正在生成 PDF…"
              : pdfState === "saved"
                ? "PDF 已保存"
                : pdfState === "error"
                  ? "导出失败，重试"
                  : "导出 PDF 报告"}
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <MetricBar label="市场活跃度" score={report.metrics.demandScore} />
          <MetricBar
            label="竞争开放度"
            score={report.metrics.competitionScore}
          />
          <MetricBar
            label="价格信号"
            score={report.metrics.priceHealthScore}
          />
          <MetricBar label="进入研究度" score={report.metrics.newEntryScore} />
        </div>

        <div className="mt-4">
          <MetricSnapshot metrics={report.metrics} isDemo={isDemo} />
        </div>

        <SourceCoverage report={report} />

        {!isDemo && <PlatformComparison metrics={report.metrics} />}

        {!isDemo && report.metrics.estimatedMonthlyUnits && (
          <div
            className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[13px] border px-3 py-2.5"
            style={{
              background: "rgba(255,159,10,0.07)",
              borderColor: "rgba(255,159,10,0.16)",
            }}
          >
            <div>
              <div className="text-[9px] font-medium text-[var(--text-secondary)]">
                样本月销量估算区间
              </div>
              <div className="mt-0.5 font-mono text-[12px] font-semibold text-[var(--text-primary)]">
                {formatCompact(report.metrics.estimatedMonthlyUnits.low)} – {" "}
                {formatCompact(report.metrics.estimatedMonthlyUnits.high)}
                <span className="ml-2 text-[9px] font-normal text-[var(--text-tertiary)]">
                  中位估算 {formatCompact(report.metrics.estimatedMonthlyUnits.median)}
                </span>
              </div>
            </div>
            <span className="text-[9px] text-[var(--text-tertiary)]">
              基于公开购买提示 / Sales Rank 的区间估算 · 非 Amazon 官方成交量
            </span>
          </div>
        )}
      </div>


      {observations.length > 0 && (
        <div className="border-t border-[var(--border)] px-4 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold text-[var(--text-primary)]">
                公开市场观察
              </div>
              <div className="mt-0.5 text-[9px] text-[var(--text-tertiary)]">
                {isDemo
                  ? "模拟 SERP / Shopping 结果 · 仅用于展示交互和报告结构"
                  : "来自 SERP / Shopping 的真实公开结果 · 不等同于平台销量或市场份额"}
              </div>
            </div>
            {observations.length > 8 && (
              <button
                type="button"
                onClick={() => setShowAllObservations((value: boolean) => !value)}
                className="rounded-[9px] border px-2.5 py-1.5 text-[9px] font-medium transition-colors hover:bg-[var(--glass-hover)]"
                style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
              >
                {showAllObservations ? "收起" : `查看全部 ${observations.length}`}
              </button>
            )}
          </div>
          <div className="overflow-hidden rounded-[13px] border border-[var(--border)] bg-[var(--glass-soft)]">
            <div className="grid grid-cols-[70px_minmax(0,1fr)_88px] gap-2 px-2 py-2 text-[8px] font-semibold uppercase tracking-[0.08em] text-[var(--text-quaternary)]">
              <span>Type</span>
              <span>Result</span>
              <span className="text-right">Price</span>
            </div>
            {visibleObservations.map((observation) => (
              <ObservationRow key={observation.id} observation={observation} />
            ))}
          </div>
        </div>
      )}

      {report.products.length > 0 && (
        <div className="border-t border-[var(--border)] px-4 py-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold text-[var(--text-primary)]">
                {isDemo ? "演示商品样本" : "平台商品增强样本"}
              </div>
              <div className="mt-0.5 text-[9px] text-[var(--text-tertiary)]">
                {isDemo
                  ? "当前展示的是明确标记的模拟商品样本"
                  : "仅在真实获取到平台结构化商品字段时展示"}
              </div>
            </div>
            {report.products.length > 6 && (
              <button
                type="button"
                onClick={() => setShowAllProducts((value: boolean) => !value)}
                className="rounded-[9px] border px-2.5 py-1.5 text-[9px] font-medium transition-colors hover:bg-[var(--glass-hover)]"
                style={{
                  borderColor: "var(--border)",
                  color: "var(--text-secondary)",
                }}
              >
                {showAllProducts ? "收起" : `查看全部 ${report.products.length}`}
              </button>
            )}
          </div>

          <div className="overflow-hidden rounded-[13px] border border-[var(--border)] bg-[var(--glass-soft)]">
            <div className="grid grid-cols-[minmax(0,1fr)_78px_62px_66px] gap-2 px-2 py-2 text-[8px] font-semibold uppercase tracking-[0.08em] text-[var(--text-quaternary)]">
              <span>Product</span>
              <span className="text-right">Price</span>
              <span className="text-right">Rank</span>
              <span className="text-right">Demand</span>
            </div>
            {products.map((product: CommerceProductSignal) => (
              <ProductRow key={product.asin} product={product} />
            ))}
          </div>
        </div>
      )}

      {report.reviewAnalyses && report.reviewAnalyses.length > 0 && (
        <ReviewAnalysisBlock analyses={report.reviewAnalyses} />
      )}

      <div className="border-t border-[var(--border)] px-4 py-3">
        <details>
          <summary className="cursor-pointer list-none text-[9px] font-medium text-[var(--text-tertiary)]">
            数据来源与限制
          </summary>
          <div className="mt-2 space-y-1.5 text-[9px] leading-4 text-[var(--text-tertiary)]">
            <p>{report.dataSource.description}</p>
            {report.warnings.map((warning) => (
              <p key={warning}>• {warning}</p>
            ))}
          </div>
        </details>
      </div>
    </section>
  );
}
