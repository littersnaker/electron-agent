import type {
  CommerceResearchReport,
  CommerceRunMode,
  CommerceSourceReport,
} from "./types";

export interface CommerceRunModeMeta {
  label: string;
  shortLabel: string;
  description: string;
}

const MODE_META: Record<CommerceRunMode, CommerceRunModeMeta> = {
  full: {
    label: "完整研究模式",
    shortLabel: "完整研究",
    description:
      "已取得公开市场数据，并至少取得一个真实增强来源，可进行多源交叉分析。",
  },
  "market-intelligence": {
    label: "基础市场洞察模式",
    shortLabel: "市场洞察",
    description:
      "已取得真实公开市场或单一平台数据，但增强数据不足；报告只解释当前可验证字段。",
  },
  demo: {
    label: "无 API 演示模式",
    shortLabel: "演示模式",
    description:
      "没有取得真实外部数据，系统使用明确标记的模拟样本展示完整流程，不能用于商业决策。",
  },
};

export function getCommerceRunModeMeta(
  mode: CommerceRunMode,
): CommerceRunModeMeta {
  return MODE_META[mode];
}

/**
 * 根据真实数据源覆盖判断运行模式。
 *
 * 完整研究并不要求“所有 API 都存在”，而是要求：
 * 1. 核心公开市场来源有真实数据；
 * 2. Amazon / Keepa / TikTok Shop / Temu / 1688 中至少一个增强来源有真实样本。
 *
 * 这样用户只配置 TalorData 时会稳定进入基础市场洞察，而不会被误判为失败。
 */
export function inferCommerceRunMode(
  sources: CommerceSourceReport[],
): Exclude<CommerceRunMode, "demo"> {
  const hasCoreMarketData = sources.some(
    (source) =>
      source.id === "market-search" &&
      source.sampleSize > 0 &&
      (source.status === "collected" || source.status === "partial"),
  );
  const hasEnhancementData = sources.some(
    (source) =>
      source.id !== "market-search" &&
      source.sampleSize > 0 &&
      (source.status === "collected" || source.status === "partial"),
  );

  return hasCoreMarketData && hasEnhancementData
    ? "full"
    : "market-intelligence";
}

/** 历史 v2/v3 报告没有 runMode 时，统一回退到基础市场洞察模式。 */
export function resolveCommerceReportRunMode(
  report: CommerceResearchReport,
): CommerceRunMode {
  return report.runMode || "market-intelligence";
}
