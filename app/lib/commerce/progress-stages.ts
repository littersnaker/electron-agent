// 模块说明：集中维护 Commerce 工作流阶段，避免活动面板与任务规划各写一套文案。
import type { CommerceWorkflowMode } from "./listing/types";
import type { CommerceResearchStage } from "./types";

export interface CommerceProgressStageDefinition {
  stage: CommerceResearchStage;
  title: string;
  description: string;
}

/** 市场研究模式真实执行的六个阶段。 */
export const COMMERCE_RESEARCH_PROGRESS_STAGES: readonly CommerceProgressStageDefinition[] = [
  {
    stage: "intent",
    title: "理解市场目标",
    description: "识别目标市场、品类范围与研究决策目标",
  },
  {
    stage: "category",
    title: "生成市场检索计划",
    description: "将自然语言描述解析为公开 SERP / Shopping 检索词与细分方向",
  },
  {
    stage: "collect",
    title: "采集公开市场信号",
    description: "优先调用真实数据源；不可用时按配置降级到公开页面采集",
  },
  {
    stage: "normalize",
    title: "统一市场观察",
    description: "去重公开结果并统一价格、评分、品牌和商品增强字段",
  },
  {
    stage: "analyze",
    title: "计算市场信号",
    description: "以确定性代码计算市场活跃度、竞争开放度与价格信号",
  },
  {
    stage: "strategy",
    title: "生成情报结论",
    description: "区分已获取与缺失数据，生成机会、风险和下一步验证动作",
  },
];

/** Amazon Listing Demo 模式真实执行的七个阶段。 */
export const AMAZON_LISTING_PROGRESS_STAGES: readonly CommerceProgressStageDefinition[] = [
  {
    stage: "intent",
    title: "理解 Listing 目标",
    description: "识别商品 Brief、目标站点、语言和禁止补充的事实",
  },
  {
    stage: "category",
    title: "识别商品类目",
    description: "解析商品类型、核心类目词和目标站点语言",
  },
  {
    stage: "collect",
    title: "采集 Amazon 竞品信号",
    description: "采集竞品标题、Bullet、价格、评分和公开商品信息",
  },
  {
    stage: "erp",
    title: "构建模拟 ERP 档案",
    description: "整理商品事实，并明确标记模拟字段与待确认字段",
  },
  {
    stage: "keywords",
    title: "提取并分配 Listing 关键词",
    description: "聚类核心词、属性词和场景词，并分配到前台与后台字段",
  },
  {
    stage: "draft",
    title: "生成 Amazon Listing",
    description: "生成标题、五点描述、产品描述和后台搜索词",
  },
  {
    stage: "validate",
    title: "检查 Listing 合规与事实",
    description: "检查字段长度、关键词覆盖、竞品品牌泄漏和待确认事实",
  },
];

const DONE_LABELS: Record<CommerceWorkflowMode, string> = {
  research: "完成市场研究",
  listing: "完成 Listing Demo",
};

/** 为不同 Commerce 模式生成互不冲突的稳定活动阶段 ID。 */
export function getCommerceActivityStageId(
  mode: CommerceWorkflowMode,
  stage: CommerceResearchStage,
): string {
  return `commerce-${mode}:${stage}`;
}

export function getCommerceProgressStages(
  mode: CommerceWorkflowMode,
): readonly CommerceProgressStageDefinition[] {
  return mode === "listing"
    ? AMAZON_LISTING_PROGRESS_STAGES
    : COMMERCE_RESEARCH_PROGRESS_STAGES;
}

/**
 * 活动面板和任务规划必须通过该函数读取标题。
 * 这样修改阶段名称时不会再出现左侧已执行、右侧仍停留在旧步骤的问题。
 */
export function getCommerceProgressTitle(
  mode: CommerceWorkflowMode,
  stage: CommerceResearchStage,
): string {
  if (stage === "done") return DONE_LABELS[mode];

  return (
    getCommerceProgressStages(mode).find((item) => item.stage === stage)?.title ??
    stage
  );
}
