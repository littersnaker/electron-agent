/**
 * 模块职责：研究请求解析、来源诊断、报告文本和进度事件。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { getCommerceRunModeMeta } from "@/app/lib/commerce/run-mode";
import type { CommerceMarketplaceCode, CommerceProgressEvent, CommerceResearchReport, CommerceResearchRequest } from "@/app/lib/commerce/types";
import { sendSse } from "@/app/api/chat/server/sse";
export const runtime = "nodejs";

export const SUPPORTED_MARKETPLACES = new Set<CommerceMarketplaceCode>([
  "US",
  "CA",
  "UK",
  "DE",
  "FR",
  "IT",
  "ES",
  "JP",
]);

export function parseMarketplace(value: unknown): CommerceMarketplaceCode {
  return typeof value === "string" &&
    SUPPORTED_MARKETPLACES.has(value as CommerceMarketplaceCode)
    ? (value as CommerceMarketplaceCode)
    : "US";
}

export function parseRequest(value: unknown): CommerceResearchRequest {
  if (!value || typeof value !== "object") {
    throw new Error("跨境市场情报请求格式无效");
  }
  const record = value as Record<string, unknown>;
  const query = typeof record.query === "string" ? record.query.trim() : "";
  if (!query) throw new Error("请输入要研究的商品类目或运营问题");

  const rawMessages = Array.isArray(record.messages) ? record.messages : [];
  const messages = rawMessages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const item = message as Record<string, unknown>;
    if (
      (item.role !== "user" && item.role !== "assistant") ||
      typeof item.content !== "string"
    ) {
      return [];
    }
    const role: "user" | "assistant" = item.role;
    return [{ role, content: item.content }];
  });

  return {
    query,
    marketplace: parseMarketplace(record.marketplace),
    sampleSize:
      typeof record.sampleSize === "number"
        ? Math.min(40, Math.max(5, Math.round(record.sampleSize)))
        : 24,
    messages: messages.slice(-8),
  };
}

export function sourceStatusLabel(
  status: CommerceResearchReport["sources"][number]["status"],
): string {
  if (status === "collected") return "已获取";
  if (status === "partial") return "部分获取";
  if (status === "unconfigured") return "未配置";
  if (status === "empty") return "无匹配数据";
  if (status === "demo") return "演示数据";
  return "获取失败";
}

export function sourceDisplayLabel(
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
  return source.label;
}

export function compactSourceError(value: string | undefined, maximum = 220): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maximum
    ? `${normalized.slice(0, maximum - 1)}…`
    : normalized;
}

export function sourceRouteDiagnostic(
  source: CommerceResearchReport["sources"][number],
): string | undefined {
  if (source.dataRoute || source.amazonDataRoute) return undefined;
  const routes = source.attemptedRoutes || source.amazonAttemptedRoutes || [];
  if (!routes.length) return undefined;
  return `已尝试 ${routes.map((route) => (route === "api" ? "API" : "爬虫")).join(" → ")}`;
}

export function platformRouteSummary(
  sources: CommerceResearchReport["sources"],
): string {
  const platformIds = new Set(["amazon", "tiktok-shop", "temu", "1688"]);
  const summaries = sources
    .filter((source) => platformIds.has(source.id))
    .map((source) => {
      const route = source.dataRoute || source.amazonDataRoute;
      if (route === "api") return `${source.label} API ${source.sampleSize} 条`;
      if (route === "crawler") {
        const engine =
          source.crawlerEngine === "browser"
            ? "浏览器爬虫"
            : source.crawlerEngine === "http"
              ? "HTTP 爬虫"
              : "爬虫";
        return `${source.label} ${engine} ${source.sampleSize} 条`;
      }
      const attempted = source.attemptedRoutes || source.amazonAttemptedRoutes || [];
      return attempted.length
        ? `${source.label} 已尝试 ${attempted.map((item) => (item === "api" ? "API" : "爬虫")).join("→")}，0 条`
        : `${source.label} 0 条`;
    });
  return summaries.join("；");
}

export function renderReportText(report: CommerceResearchReport): string {
  const mode = report.runMode || "market-intelligence";
  const modeMeta = getCommerceRunModeMeta(mode);
  const score = report.metrics.opportunityScore;
  const verdict =
    mode === "demo"
      ? "仅供流程演示"
      : score >= 75
        ? "值得继续深挖"
        : score >= 60
          ? "可继续验证"
          : "建议谨慎进入";
  const scoreLabel =
    mode === "full"
      ? "多源市场信号分"
      : mode === "demo"
        ? "演示流程评分"
        : "公开市场信号分";

  return [
    `## ${report.category.categoryName} · ${report.marketplaceLabel}`,
    "",
    `**运行模式：${modeMeta.label}**`,
    "",
    `**${scoreLabel}：${score}/100 · ${verdict}**`,
    "",
    mode === "demo"
      ? "> 当前没有取得真实外部市场数据。以下样本和评分均为模拟内容，不能用于商业决策。"
      : "",
    report.insights.summary,
    "",
    report.insights.opportunities.length
      ? `**机会点**\n${report.insights.opportunities.map((item) => `- ${item}`).join("\n")}`
      : "",
    report.insights.risks.length
      ? `**主要风险**\n${report.insights.risks.map((item) => `- ${item}`).join("\n")}`
      : "",
    report.insights.actions.length
      ? `**下一步建议**\n${report.insights.actions.map((item) => `- ${item}`).join("\n")}`
      : "",
    `**数据覆盖**\n${report.sources
      .map(
        (source) => {
          const diagnostic = sourceRouteDiagnostic(source);
          const error = compactSourceError(source.error);
          return `- ${sourceDisplayLabel(source)}: ${sourceStatusLabel(source.status)} · ${source.sampleSize} 个样本${diagnostic ? ` · ${diagnostic}` : ""}${error ? ` · 原因：${error}` : ""}`;
        },
      )
      .join("\n")}`,
    "**PDF 报告**\nCross-border Market Intelligence 结构化报告已就绪，可在上方市场卡片中点击「导出 PDF 报告」保存完整版本。",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function progress(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: CommerceProgressEvent,
): void {
  sendSse(controller, encoder, {
    type: "COMMERCE_PROGRESS",
    payload: event,
  });
  sendSse(controller, encoder, {
    type: "STATUS",
    content: event.detail,
  });
}
