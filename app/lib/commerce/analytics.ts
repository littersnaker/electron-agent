/**
 * 模块职责：Lib Commerce Analytics 对外兼容入口。
 * 说明：内部实现已按企业级单一职责拆分；保留原导入路径，避免影响调用方。
 */
export { buildDemoInsights } from "./analytics/market-insights";
export { buildDeterministicInsights } from "./analytics/market-insights";
export { calculateMarketIntelligenceMetrics } from "./analytics/market-metrics";
export { calculateMarketMetrics } from "./analytics/market-metrics";
export { calculateSourceConfidence } from "./analytics/market-insights";
export { enrichProductsWithEstimates } from "./analytics/market-metrics";
export { estimateMonthlyUnitsFromRank } from "./analytics/market-statistics";
export { inferDataQuality } from "./analytics/market-insights";
