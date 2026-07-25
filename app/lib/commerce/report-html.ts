import {
  getCommerceRunModeMeta,
  resolveCommerceReportRunMode,
} from "./run-mode";
import type {
  CommerceMarketMetrics,
  CommerceMarketObservation,
  CommerceProductSignal,
  CommerceResearchReport,
} from "./types";

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function formatCompact(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString("en-US");
}

function formatPrice(value: number | undefined, currency?: string): string {
  if (value === undefined) return "-";
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

function renderMetricBars(metrics: CommerceMarketMetrics): string {
  const items = [
    ["市场活跃度", metrics.demandScore],
    ["竞争开放度", metrics.competitionScore],
    ["价格信号", metrics.priceHealthScore],
    ["进入研究度", metrics.newEntryScore],
  ] as const;

  return items
    .map(
      ([label, score]) => `
        <div class="metric-row">
          <div class="metric-head"><span>${label}</span><strong>${score}</strong></div>
          <div class="metric-track"><span style="width:${Math.max(0, Math.min(100, score))}%"></span></div>
        </div>`,
    )
    .join("");
}

function renderProductRows(products: CommerceProductSignal[]): string {
  return products
    .slice(0, 20)
    .map((product) => {
      const isAmazon = !product.platform || product.platform === "amazon";
      const purchase = product.recentPurchaseLabel
        ? escapeHtml(product.recentPurchaseLabel)
        : isAmazon && product.estimatedMonthlyUnits
          ? `~${formatCompact(product.estimatedMonthlyUnits.median)}/月`
          : product.recentPurchaseLowerBound
            ? `${formatCompact(product.recentPurchaseLowerBound)}+ 已售`
            : "-";
      return `
        <tr>
          <td>
            <div class="product-title">${escapeHtml(product.title)}</div>
            <div class="product-meta">${escapeHtml(product.platform || "amazon")} · ${escapeHtml(product.asin)}${product.brand ? ` · ${escapeHtml(product.brand)}` : ""}</div>
          </td>
          <td>${escapeHtml(formatPrice(product.price, product.currency))}</td>
          <td>${product.rating ?? "-"}</td>
          <td>${formatCompact(product.reviewCount)}</td>
          <td>${product.salesRank ? `#${formatCompact(product.salesRank)}` : "-"}</td>
          <td>${purchase}</td>
        </tr>`;
    })
    .join("");
}

function renderObservationRows(observations: CommerceMarketObservation[]): string {
  return observations
    .slice(0, 24)
    .map((item) => `
      <tr>
        <td>${escapeHtml(item.resultType)}</td>
        <td>
          <div class="product-title">${escapeHtml(item.title)}</div>
          <div class="product-meta">${escapeHtml(item.domain || item.merchant || "公开搜索结果")}</div>
        </td>
        <td>${escapeHtml(formatPrice(item.price, item.currency))}</td>
        <td>${item.rating ?? "-"}</td>
        <td>${formatCompact(item.reviewCount)}</td>
      </tr>`)
    .join("");
}


function renderPlatformComparisonRows(
  metrics: CommerceMarketMetrics,
): string {
  return (metrics.platformComparisons || [])
    .map(
      (item) => `<tr>
        <td><strong>${escapeHtml(item.label)}</strong></td>
        <td>${item.sampleSize}</td>
        <td>${escapeHtml(formatPrice(item.medianPrice, item.currency))}</td>
        <td>${item.medianRating ?? "-"}</td>
        <td>${formatCompact(item.medianReviewCount)}</td>
        <td>${item.priceSampleSize}/${item.sampleSize}</td>
      </tr>`,
    )
    .join("");
}

function sourceStatusLabel(
  status: CommerceResearchReport["sources"][number]["status"],
): string {
  if (status === "collected") return "已获取";
  if (status === "partial") return "部分获取";
  if (status === "unconfigured") return "未配置";
  if (status === "empty") return "无匹配数据";
  if (status === "demo") return "演示数据";
  return "获取失败";
}

function sourceDisplayLabel(
  source: CommerceResearchReport["sources"][number],
): string {
  const route = source.dataRoute || source.amazonDataRoute;
  if (route === "api") return `${source.label}（API）`;
  if (route === "crawler") {
    const engine =
      source.crawlerEngine === "browser"
        ? "浏览器爬虫"
        : source.crawlerEngine === "http"
          ? "HTTP 爬虫"
          : "爬虫";
    return `${source.label}（${engine}）`;
  }
  const attempted = source.attemptedRoutes || source.amazonAttemptedRoutes || [];
  return attempted.length
    ? `${source.label}（已尝试 ${attempted.map((item) => (item === "api" ? "API" : "爬虫")).join(" → ")}）`
    : source.label;
}

function renderList(title: string, items: string[], accent: string): string {
  if (!items.length) return "";
  return `
    <section class="insight-card">
      <div class="insight-title" style="color:${accent}">${escapeHtml(title)}</div>
      <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </section>`;
}

/** 生成适合 Chromium printToPDF 的独立 HTML 文档。 */
export function buildCommerceReportHtml(report: CommerceResearchReport): string {
  const runMode = resolveCommerceReportRunMode(report);
  const modeMeta = getCommerceRunModeMeta(runMode);
  const isDemo = runMode === "demo";
  const generatedAt = new Date(report.generatedAt).toLocaleString("zh-CN", {
    hour12: false,
  });
  const estimate = report.metrics.estimatedMonthlyUnits;
  const qualityLabel = isDemo
    ? "模拟数据"
    : report.dataSource.quality === "high"
      ? "高"
      : report.dataSource.quality === "medium"
        ? "中"
        : "有限";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(report.category.categoryName)} - 跨境市场研究</title>
<style>
  @page { size: A4; margin: 13mm 12mm 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; color: #1d1d1f; background: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
    font-size: 10px; line-height: 1.55; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .page { max-width: 100%; }
  .hero { padding: 22px 24px; border-radius: 22px; background: linear-gradient(145deg,#f4f9ff,#f6f8ff); border: 1px solid #e5e7eb; }
  .eyebrow { color:#0a67c7; font-size:9px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
  h1 { margin: 7px 0 3px; font-size: 25px; line-height: 1.2; letter-spacing:-.03em; }
  .goal { max-width: 82%; color:#6e6e73; font-size:10px; }
  .hero-grid { display:grid; grid-template-columns:1fr 150px; gap:20px; align-items:start; }
  .score { text-align:center; padding:14px; border-radius:18px; background:#fff; border:1px solid #e5e7eb; }
  .score strong { display:block; font-size:32px; line-height:1; color:#0a67c7; }
  .score span { display:block; margin-top:5px; color:#6e6e73; }
  .meta { margin-top:13px; display:flex; gap:14px; flex-wrap:wrap; color:#86868b; }
  .section { margin-top:18px; break-inside:avoid; }
  .section h2 { margin:0 0 8px; font-size:14px; letter-spacing:-.02em; }
  .metrics { display:grid; grid-template-columns:1fr 1fr; gap:10px 18px; }
  .metric-head { display:flex; justify-content:space-between; margin-bottom:4px; color:#6e6e73; }
  .metric-head strong { color:#1d1d1f; }
  .metric-track { height:6px; border-radius:999px; background:#eef0f2; overflow:hidden; }
  .metric-track span { display:block; height:100%; border-radius:999px; background:linear-gradient(90deg,#0a84ff,#64d2ff); }
  .snapshots { margin-top:12px; display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
  .snapshot { padding:10px; border-radius:12px; background:#f5f5f7; }
  .snapshot small { display:block; color:#86868b; }
  .snapshot strong { display:block; margin-top:3px; font-size:12px; }
  .estimate { margin-top:10px; padding:11px 12px; border-radius:12px; background:#fff8ec; border:1px solid #f5d9ad; }
  .estimate strong { font-size:13px; }
  .insight-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .insight-card { padding:12px 14px; border:1px solid #e5e7eb; border-radius:14px; break-inside:avoid; }
  .insight-title { font-weight:700; margin-bottom:5px; }
  ul { margin:0; padding-left:17px; }
  li { margin:3px 0; }
  table { width:100%; border-collapse:separate; border-spacing:0; overflow:hidden; border:1px solid #e5e7eb; border-radius:12px; font-size:8.5px; }
  th { background:#f5f5f7; color:#6e6e73; text-align:left; font-size:7.5px; text-transform:uppercase; letter-spacing:.05em; }
  th, td { padding:7px 8px; border-bottom:1px solid #ececef; vertical-align:top; }
  tr:last-child td { border-bottom:0; }
  .product-title { max-width:260px; font-weight:600; }
  .product-meta { margin-top:2px; color:#86868b; font-size:7.5px; }
  .notice { margin-top:18px; padding:12px 14px; border-radius:12px; background:#f5f5f7; color:#6e6e73; font-size:8.5px; }
  .footer { margin-top:14px; color:#a1a1a6; font-size:8px; display:flex; justify-content:space-between; }
  .summary { margin:8px 0 0; padding:12px 14px; border-left:3px solid #0a84ff; background:#f5f9ff; border-radius:0 10px 10px 0; }
  .demo-warning { margin-top:12px; padding:11px 13px; border-radius:12px; color:#8a4b00; background:#fff7e8; border:1px solid #f0cf96; font-weight:600; }
  @media print { a { color:inherit; text-decoration:none; } }
</style>
</head>
<body>
<div class="page">
  <section class="hero">
    <div class="hero-grid">
      <div>
        <div class="eyebrow">Cross-border Market Intelligence · ${escapeHtml(report.marketplaceLabel)} · ${escapeHtml(modeMeta.label)}</div>
        <h1>${escapeHtml(report.category.categoryName)}</h1>
        <div class="goal">${escapeHtml(report.category.researchGoal)}</div>
        <div class="meta">
          <span>检索词：${report.category.keywords.map(escapeHtml).join(" / ")}</span>
          <span>${isDemo ? "演示样本" : "公开样本"}：${report.metrics.sampleSize}</span>
          <span>数据完整度：${qualityLabel}</span>
          <span>${isDemo ? "真实数据覆盖" : "综合可信度"}：${report.confidenceScore}/100</span>
        </div>
      </div>
      <div class="score"><strong>${report.metrics.opportunityScore}</strong><span>${isDemo ? "Demo Signal" : runMode === "full" ? "Multi-source Signal" : "Public Market Signal"}</span><span>${isDemo ? "流程演示" : scoreLabel(report.metrics.opportunityScore)}</span></div>
    </div>
  </section>
  ${isDemo ? `<div class="demo-warning">无真实数据演示模式：本报告中的样本、价格、评论和评分均为模拟内容，仅用于验证流程，不能用于选品、采购、定价或投放决策。</div>` : ""}

  <section class="section">
    <h2>${isDemo ? "演示流程概览" : "市场概览"}</h2>
    <div class="metrics">${renderMetricBars(report.metrics)}</div>
    <div class="snapshots">
      <div class="snapshot"><small>${isDemo ? "演示样本" : "有效市场样本"}</small><strong>${report.metrics.sampleSize}</strong></div>
      <div class="snapshot"><small>Shopping 结果</small><strong>${report.metrics.shoppingResultCount || 0}</strong></div>
      <div class="snapshot"><small>可见域名</small><strong>${report.metrics.uniqueDomainCount || 0}</strong></div>
      <div class="snapshot"><small>中位价格</small><strong>${escapeHtml(formatPrice(report.metrics.medianPrice, report.metrics.currency))}</strong></div>
    </div>
    ${estimate && !isDemo ? `<div class="estimate"><strong>样本月销量估算 ${formatCompact(estimate.low)} - ${formatCompact(estimate.high)}</strong><div>中位估算 ${formatCompact(estimate.median)}。基于公开购买提示 / Sales Rank 的启发式区间，不是 Amazon 官方订单量。</div></div>` : ""}
    <div class="summary">${escapeHtml(report.insights.summary)}</div>
  </section>

  <section class="section">
    <h2>运营判断</h2>
    <div class="insight-grid">
      ${renderList("机会点", report.insights.opportunities, "#0a67c7")}
      ${renderList("主要风险", report.insights.risks, "#c9342f")}
      ${renderList("下一步建议", report.insights.actions, "#0071e3")}
    </div>
  </section>


  ${(report.metrics.platformComparisons || []).length >= 2 && !isDemo ? `<section class="section">
    <h2>跨平台公开样本对比</h2>
    <table>
      <thead><tr><th>Platform</th><th>Samples</th><th>Median Price</th><th>Median Rating</th><th>Median Reviews</th><th>Price Coverage</th></tr></thead>
      <tbody>${renderPlatformComparisonRows(report.metrics)}</tbody>
    </table>
    <div class="notice">各平台按自身币种独立统计；样本数不代表市场份额，价格未做自动汇率换算。</div>
  </section>` : ""}

  <section class="section">
    <h2>数据源覆盖</h2>
    <table>
      <thead><tr><th>Source</th><th>Status</th><th>Samples</th><th>Coverage / Notes</th></tr></thead>
      <tbody>${report.sources.map((source) => `<tr><td><strong>${escapeHtml(sourceDisplayLabel(source))}</strong></td><td>${escapeHtml(sourceStatusLabel(source.status))}</td><td>${source.sampleSize}</td><td>${escapeHtml(source.coverage.length ? source.coverage.join(" · ") : source.error || source.summary)}</td></tr>`).join("")}</tbody>
    </table>
  </section>

  ${(report.observations || []).length ? `<section class="section">
    <h2>公开市场观察</h2>
    <table>
      <thead><tr><th>Type</th><th>Result</th><th>Price</th><th>Rating</th><th>Reviews</th></tr></thead>
      <tbody>${renderObservationRows(report.observations || [])}</tbody>
    </table>
    <div class="notice">${isDemo ? "当前为模拟 SERP / Shopping 结果，仅用于展示报告结构。" : "公开 SERP / Shopping 结果用于市场情报初筛，不等同于平台真实销量、GMV 或市场份额。"}</div>
  </section>` : ""}

  ${report.products.length ? `<section class="section">
    <h2>${isDemo ? "演示商品样本" : "平台商品增强样本"}</h2>
    <table>
      <thead><tr><th>Product</th><th>Price</th><th>Rating</th><th>Reviews</th><th>Rank</th><th>Demand Signal</th></tr></thead>
      <tbody>${renderProductRows(report.products)}</tbody>
    </table>
  </section>` : ""}

  <section class="notice">
    <strong>数据来源与限制</strong><br />
    ${escapeHtml(report.dataSource.description)}<br />
    ${report.warnings.map((warning) => `• ${escapeHtml(warning)}`).join("<br />")}
  </section>

  <div class="footer"><span>Multi-agent · Cross-border Market Intelligence</span><span>生成时间：${escapeHtml(generatedAt)}</span></div>
</div>
</body>
</html>`;
}

export function buildCommercePdfFileName(report: CommerceResearchReport): string {
  const safeCategory = report.category.categoryName
    .replace(/[\\/:*?"<>|]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 40) || "跨境市场情报";
  const date = report.generatedAt.slice(0, 10);
  return `${safeCategory}-${report.marketplace}-${date}.pdf`;
}
