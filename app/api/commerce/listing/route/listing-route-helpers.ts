/** Amazon Listing Demo Route 的请求解析、SSE 进度和摘要文本。 */
import { sendSse } from "@/app/api/chat/server/sse";
import type {
  CommerceMarketplaceCode,
  CommerceProgressEvent,
} from "@/app/lib/commerce/types";
import type {
  AmazonListingDemoReport,
  AmazonListingDemoRequest,
} from "@/app/lib/commerce/listing/types";

const SUPPORTED_MARKETPLACES = new Set<CommerceMarketplaceCode>([
  "US",
  "CA",
  "UK",
  "DE",
  "FR",
  "IT",
  "ES",
  "JP",
]);

function parseMarketplace(value: unknown): CommerceMarketplaceCode {
  return typeof value === "string" &&
    SUPPORTED_MARKETPLACES.has(value as CommerceMarketplaceCode)
    ? (value as CommerceMarketplaceCode)
    : "US";
}

export function parseListingRequest(value: unknown): AmazonListingDemoRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Amazon Listing Demo 请求格式无效");
  }
  const record = value as Record<string, unknown>;
  const query = typeof record.query === "string" ? record.query.trim() : "";
  if (!query) {
    throw new Error("请输入商品名称、用途，以及已知的材质、尺寸或包装信息");
  }
  const messages = (Array.isArray(record.messages) ? record.messages : []).flatMap(
    (message) => {
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
    },
  );
  return {
    query,
    marketplace: parseMarketplace(record.marketplace),
    sampleSize:
      typeof record.sampleSize === "number"
        ? Math.min(24, Math.max(6, Math.round(record.sampleSize)))
        : 16,
    messages: messages.slice(-8),
  };
}

export function listingProgress(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  stage: CommerceProgressEvent["stage"],
  progress: number,
  detail: string,
): void {
  const payload: CommerceProgressEvent = { stage, progress, detail };
  sendSse(controller, encoder, { type: "COMMERCE_PROGRESS", payload });
  sendSse(controller, encoder, { type: "STATUS", content: detail });
}

export function renderListingText(report: AmazonListingDemoReport): string {
  const score = report.validation.score.overall;
  const errors = report.validation.issues.filter(
    (issue) => issue.severity === "error",
  ).length;
  const sourceLabel = report.source.isDemo
    ? "模拟 Amazon 竞品样本"
    : report.source.dataRoute === "crawler"
      ? "Amazon 公开页面爬虫"
      : "Amazon 数据接口";
  return [
    `## Amazon Listing Demo · ${report.marketplaceLabel}`,
    "",
    `**Demo 质量分：${score}/100 · 阻断错误 ${errors} 项**`,
    "",
    `商品档案：${report.mockErp.sourceName}（SKU: ${report.mockErp.sku}）`,
    `竞品参考：${sourceLabel} · ${report.source.sampleSize} 个样本`,
    `关键词：${report.keywords.length} 个候选，已覆盖 ${report.validation.keywordCoverage.covered.length} 个`,
    "",
    "> 当前没有连接真实 ERP，也没有执行 Seller Central 发布。所有待确认字段必须由产品团队核实。",
    "",
    "结构化 Listing 卡片已生成，可直接编辑标题、Bullet、描述和 Search Terms，并复制 JSON 到本地继续联调。",
  ].join("\n");
}
