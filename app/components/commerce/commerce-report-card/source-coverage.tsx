"use client";
/**
 * 模块职责：来源覆盖、路由状态和平台对比组件。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { resolveCommerceReportRunMode } from "../../../lib/commerce/run-mode";
import type { CommerceMarketMetrics, CommerceResearchReport } from "../../../lib/commerce/types";
import { formatCompact, formatPrice } from "./metric-widgets";
export function sourceStatusLabel(status: CommerceResearchReport["sources"][number]["status"]): string {
  if (status === "collected") return "已获取";
  if (status === "partial") return "部分获取";
  if (status === "unconfigured") return "未配置";
  if (status === "empty") return "无匹配数据";
  if (status === "demo") return "演示数据";
  return "获取失败";
}

export function sourceRouteLabel(
  source: CommerceResearchReport["sources"][number],
): string | undefined {
  const route = source.dataRoute || source.amazonDataRoute;
  if (route === "api") return "API";
  if (route === "crawler") {
    if (source.crawlerEngine === "browser") return "浏览器爬虫";
    if (source.crawlerEngine === "http") return "HTTP 爬虫";
    return "爬虫";
  }
  return undefined;
}

export function sourceAttemptedRouteLabel(
  source: CommerceResearchReport["sources"][number],
): string | undefined {
  if (sourceRouteLabel(source)) return undefined;
  const routes = source.attemptedRoutes || source.amazonAttemptedRoutes || [];
  if (!routes.length) return undefined;
  return routes
    .map((route) => (route === "api" ? "API" : "爬虫"))
    .join(" → ");
}

export function SourceCoverage({ report }: { report: CommerceResearchReport }) {
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
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {report.sources.map((source) => {
          const isDemoSource = source.status === "demo";
          const ok =
            source.status === "collected" || source.status === "partial";
          const routeLabel = sourceRouteLabel(source);
          const attemptedRouteLabel = sourceAttemptedRouteLabel(source);
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
                      title="本轮已实际尝试这些数据链路，但未取得可用样本"
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
              {sourceRouteLabel(source)
                ? `（${sourceRouteLabel(source)}）`
                : sourceAttemptedRouteLabel(source)
                  ? `（已尝试 ${sourceAttemptedRouteLabel(source)}）`
                  : ""}：
            </span>
            {source.error ? `未分析 · ${source.error}` : source.summary}
          </div>
        ))}
      </div>
    </div>
  );
}

export function PlatformComparison({
  metrics,
}: {
  metrics: CommerceMarketMetrics;
}) {
  const comparisons = metrics.platformComparisons || [];
  if (comparisons.length < 2) return null;

  return (
    <div className="mt-4">
      <div className="mb-2">
        <div className="text-[11px] font-semibold text-[var(--text-primary)]">
          跨平台公开样本对比
        </div>
        <div className="mt-0.5 text-[9px] text-[var(--text-tertiary)]">
          各平台按自身币种独立统计；样本数不代表市场份额，价格不做自动汇率换算
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {comparisons.map((item) => (
          <div
            key={item.platform}
            className="rounded-[13px] border px-3 py-2.5"
            style={{
              background: "var(--glass-soft)",
              borderColor: "var(--border)",
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[10px] font-semibold text-[var(--text-primary)]">
                {item.label}
              </span>
              <span className="font-mono text-[9px] text-[var(--text-tertiary)]">
                {item.sampleSize} 样本
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[8px]">
              <span className="text-[var(--text-tertiary)]">中位价格</span>
              <span className="truncate text-right font-mono text-[var(--text-secondary)]">
                {formatPrice(item.medianPrice, item.currency)}
              </span>
              <span className="text-[var(--text-tertiary)]">中位评分</span>
              <span className="text-right font-mono text-[var(--text-secondary)]">
                {item.medianRating ?? "—"}
              </span>
              <span className="text-[var(--text-tertiary)]">中位评论</span>
              <span className="text-right font-mono text-[var(--text-secondary)]">
                {formatCompact(item.medianReviewCount)}
              </span>
              <span className="text-[var(--text-tertiary)]">价格覆盖</span>
              <span className="text-right font-mono text-[var(--text-secondary)]">
                {item.priceSampleSize}/{item.sampleSize}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
