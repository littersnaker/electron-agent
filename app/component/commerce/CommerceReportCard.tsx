"use client";

import { useMemo, useState } from "react";
import { exportCommerceReportPdf } from "../../lib/commerce/pdf-export";
import {
  getCommerceRunModeMeta,
  resolveCommerceReportRunMode,
} from "../../lib/commerce/run-mode";
import type {
  CommerceMarketMetrics,
  CommerceMarketObservation,
  CommerceProductSignal,
  CommerceResearchReport,
} from "../../lib/commerce/types";

function formatCompact(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString();
}

function formatPrice(
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

function scoreLabel(score: number): string {
  if (score >= 80) return "机会较强";
  if (score >= 65) return "值得验证";
  if (score >= 50) return "中性观察";
  return "谨慎进入";
}

function MetricBar({
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

function MetricSnapshot({
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

function observationTypeLabel(type: CommerceMarketObservation["resultType"]): string {
  if (type === "shopping") return "Shopping";
  if (type === "organic") return "Web";
  if (type === "ad") return "Ad";
  if (type === "related") return "Related";
  return "Other";
}

function ObservationRow({ observation }: { observation: CommerceMarketObservation }) {
  return (
    <div className="grid grid-cols-[70px_minmax(0,1fr)_88px] items-center gap-2 border-t border-[var(--border)] px-2 py-2.5 text-[10px] first:border-t-0">
      <span className="font-mono text-[9px] text-[var(--text-tertiary)]">
        {observationTypeLabel(observation.resultType)}
      </span>
      <div className="min-w-0">
        {observation.url ? (
          <a
            href={observation.url}
            target="_blank"
            rel="noreferrer"
            className="block truncate font-medium text-[var(--text-primary)] transition-opacity hover:opacity-70"
            title={observation.title}
          >
            {observation.title}
          </a>
        ) : (
          <div className="truncate font-medium text-[var(--text-primary)]" title={observation.title}>
            {observation.title}
          </div>
        )}
        <div className="mt-0.5 truncate text-[9px] text-[var(--text-tertiary)]">
          {observation.domain || observation.merchant || "公开搜索结果"}
        </div>
      </div>
      <div className="text-right font-mono text-[var(--text-secondary)]">
        {formatPrice(observation.price, observation.currency)}
      </div>
    </div>
  );
}

function ProductRow({ product }: { product: CommerceProductSignal }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_78px_62px_66px] items-center gap-2 border-t border-[var(--border)] px-2 py-2.5 text-[10px] first:border-t-0">
      <div className="min-w-0">
        {product.productUrl ? (
          <a
            href={product.productUrl}
            target="_blank"
            rel="noreferrer"
            className="block truncate font-medium text-[var(--text-primary)] transition-opacity hover:opacity-70"
            title={product.title}
          >
            {product.title}
          </a>
        ) : (
          <div
            className="truncate font-medium text-[var(--text-primary)]"
            title={product.title}
          >
            {product.title}
          </div>
        )}
        <div className="mt-0.5 flex items-center gap-2 text-[9px] text-[var(--text-tertiary)]">
          <span className="font-mono">{product.platform === "amazon" || !product.platform ? product.asin : product.platform}</span>
          {product.brand && <span className="truncate">{product.brand}</span>}
        </div>
      </div>
      <div className="text-right font-mono text-[var(--text-secondary)]">
        {formatPrice(product.price, product.currency)}
      </div>
      <div className="text-right font-mono text-[var(--text-secondary)]">
        {product.salesRank ? `#${formatCompact(product.salesRank)}` : "—"}
      </div>
      <div className="text-right font-mono text-[var(--text-secondary)]">
        {product.recentPurchaseLowerBound
          ? `${formatCompact(product.recentPurchaseLowerBound)}+/mo`
          : product.estimatedMonthlyUnits
            ? `~${formatCompact(product.estimatedMonthlyUnits.median)}`
            : "—"}
      </div>
    </div>
  );
}

function sourceStatusLabel(status: CommerceResearchReport["sources"][number]["status"]): string {
  if (status === "collected") return "已获取";
  if (status === "partial") return "部分获取";
  if (status === "unconfigured") return "未配置";
  if (status === "empty") return "无匹配数据";
  if (status === "demo") return "演示数据";
  return "获取失败";
}

function amazonRouteLabel(
  source: CommerceResearchReport["sources"][number],
): string | undefined {
  if (source.id !== "amazon") return undefined;
  if (source.amazonDataRoute === "api") return "API";
  if (source.amazonDataRoute === "crawler") return "爬虫";
  return undefined;
}

function amazonAttemptedRouteLabel(
  source: CommerceResearchReport["sources"][number],
): string | undefined {
  if (source.id !== "amazon" || source.amazonDataRoute) return undefined;
  const routes = source.amazonAttemptedRoutes || [];
  if (!routes.length) return undefined;
  return routes
    .map((route) => (route === "api" ? "API" : "爬虫"))
    .join(" → ");
}

function SourceCoverage({ report }: { report: CommerceResearchReport }) {
  const runMode = resolveCommerceReportRunMode(report);
  const isDemoMode = runMode === "demo";

  return (
    <div className="mt-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold text-[var(--text-primary)]">数据源覆盖</div>
          <div className="mt-0.5 text-[9px] text-[var(--text-tertiary)]">
            {isDemoMode
              ? "真实数据覆盖 0/100 · 当前仅展示模拟流程"
              : `综合可信度 ${report.confidenceScore}/100 · 未获取来源不会参与事实性结论`}
          </div>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {report.sources.map((source) => {
          const isDemoSource = source.status === "demo";
          const ok =
            source.status === "collected" || source.status === "partial";
          const routeLabel = amazonRouteLabel(source);
          const attemptedRouteLabel = amazonAttemptedRouteLabel(source);
          return (
            <div
              key={source.id}
              className="rounded-[13px] border px-3 py-2.5"
              style={{ background: "var(--glass-soft)", borderColor: "var(--border)" }}
              title={source.error || source.summary}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[10px] font-semibold text-[var(--text-primary)]">
                    {source.label}
                  </span>
                  {routeLabel ? (
                    <span
                      className="shrink-0 rounded-full px-1.5 py-0.5 text-[7px] font-semibold"
                      style={{
                        color: routeLabel === "API" ? "#30d158" : "#ff9f0a",
                        background:
                          routeLabel === "API"
                            ? "rgba(48,209,88,0.10)"
                            : "rgba(255,159,10,0.10)",
                      }}
                    >
                      {routeLabel}
                    </span>
                  ) : attemptedRouteLabel ? (
                    <span
                      className="shrink-0 rounded-full px-1.5 py-0.5 text-[7px] font-semibold"
                      style={{
                        color: "#ff453a",
                        background: "rgba(255,69,58,0.10)",
                      }}
                      title="本轮已实际尝试这些 Amazon 数据链路，但未取得可用样本"
                    >
                      已尝试 {attemptedRouteLabel}
                    </span>
                  ) : null}
                </div>
                <span
                  className="rounded-full px-1.5 py-0.5 text-[8px] font-medium"
                  style={{
                    color: isDemoSource
                      ? "#ff9f0a"
                      : ok
                        ? "#0a84ff"
                        : source.status === "error"
                          ? "#ff453a"
                          : "var(--text-tertiary)",
                    background: isDemoSource
                      ? "rgba(255,159,10,0.12)"
                      : ok
                        ? "rgba(10,132,255,0.10)"
                        : "var(--glass)",
                  }}
                >
                  {sourceStatusLabel(source.status)}
                </span>
              </div>
              <div className="mt-1 font-mono text-[10px] text-[var(--text-secondary)]">
                {source.sampleSize} samples
              </div>
              <div className="mt-1 line-clamp-2 text-[8px] leading-3.5 text-[var(--text-tertiary)]">
                {source.error
                  ? source.error
                  : source.coverage.length
                    ? source.coverage.join(" · ")
                    : source.summary}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {report.sources.map((source) => (
          <div
            key={`${source.id}-detail`}
            className="rounded-[11px] border px-3 py-2 text-[9px] leading-4"
            style={{ background: "var(--glass)", borderColor: "var(--border)", color: "var(--text-tertiary)" }}
          >
            <span className="font-semibold text-[var(--text-secondary)]">
              {source.label}
              {amazonRouteLabel(source)
                ? `（${amazonRouteLabel(source)}）`
                : amazonAttemptedRouteLabel(source)
                  ? `（已尝试 ${amazonAttemptedRouteLabel(source)}）`
                  : ""}：
            </span>
            {source.error ? `未分析 · ${source.error}` : source.summary}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Cross-border Market Intelligence Agent 的结构化结果卡片。
 *
 * 首先展示公开市场 observations；Amazon 商品数据会明确显示来自 API 还是爬虫。
 * 没有 Amazon API 时自动使用公开页面爬虫，只有所有真实来源都失败时才进入 Demo。
 */
export default function CommerceReportCard({
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
