// 模块说明：负责 config 用户界面组件。
import {
  AMAZON_LISTING_PROGRESS_STAGES,
  COMMERCE_RESEARCH_PROGRESS_STAGES,
  getCommerceActivityStageId,
} from "../../lib/commerce/progress-stages";
import type { CommerceWorkflowMode } from "../../lib/commerce/listing/types";
import type {
  PlanningStageDefinition,
  PlanningStageStatus,
} from "./types";

/** QA / Code Agent 使用的稳定阶段定义。 */
export const CODE_STAGE_DEFINITIONS: PlanningStageDefinition[] = [
  {
    id: "understand",
    title: "理解需求",
    description: "识别任务类型、目标与执行边界",
    agentTypes: ["orchestrator"],
    activityKeys: ["router", "请求分类", "接收请求", "工作区信息"],
    lifecycleRoles: ["router"],
  },
  {
    id: "context",
    title: "获取上下文",
    description: "读取项目文件、索引和相关上下文",
    agentTypes: ["researcher"],
    activityKeys: ["search", "read", "搜索", "读取", "上下文"],
    lifecycleRoles: [
      "search_agent",
      "memory_agent",
      "file_agent",
      "context_merge",
    ],
  },
  {
    id: "prompt",
    title: "优化任务提示词",
    description: "补全目标、约束、验收标准和禁止事项，同时保留用户原始参数",
    agentTypes: ["planner"],
    activityKeys: ["prompt_optimizer", "提示词优化", "任务规格"],
    lifecycleRoles: ["prompt_optimizer"],
  },
  {
    id: "plan",
    title: "制定计划",
    description: "生成执行计划；轻量任务会直接生成单文件计划",
    agentTypes: ["planner"],
    activityKeys: ["planner", "planning", "规划", "任务拆解"],
    lifecycleRoles: ["high_level_planner", "task_planner"],
  },
  {
    id: "execute",
    title: "执行修改",
    description: "读取真实文件并准备可合并变更",
    agentTypes: ["coder"],
    activityKeys: ["propose_file_change", "apply_file_change", "代码任务"],
    lifecycleRoles: ["modify_worker"],
  },
  {
    id: "merge",
    title: "合并变更",
    description: "检测冲突并将 Worker 结果统一写入工作区",
    agentTypes: ["orchestrator"],
    activityKeys: ["merge", "合并", "落盘"],
    lifecycleRoles: ["merge_agent"],
  },
  {
    id: "verify",
    title: "工程验证",
    description: "按变更类型运行文档检查、lint、build 或 test",
    agentTypes: ["terminal"],
    activityKeys: ["run_terminal_command", "lint", "build", "test", "验证"],
    lifecycleRoles: ["verification_agent"],
  },
  {
    id: "review",
    title: "质量审查",
    description: "执行代码审查与认知复盘，并决定通过、返工或停止",
    agentTypes: ["reviewer"],
    activityKeys: ["review", "reflection", "审查", "复盘"],
    lifecycleRoles: ["reviewer_agent", "reflection_agent"],
  },
  {
    id: "deliver",
    title: "生成结果",
    description: "沉淀稳定经验，并汇总已执行事实生成最终交付说明",
    agentTypes: ["orchestrator"],
    activityKeys: [
      "memory_consolidation",
      "final_report",
      "记忆沉淀",
      "最终报告",
      "交付",
    ],
    lifecycleRoles: ["memory_consolidation_agent", "final_report_agent"],
  },
];


/**
 * 将 Commerce 的共享阶段定义映射为右侧任务规划结构。
 * 标题、顺序和稳定 stage ID 都来自同一来源，避免活动面板与任务规划漂移。
 */
function toCommercePlanningStages(
  mode: CommerceWorkflowMode,
  stages: typeof COMMERCE_RESEARCH_PROGRESS_STAGES,
): PlanningStageDefinition[] {
  return stages.map((item) => ({
    id: `commerce-${mode}-${item.stage}`,
    title: item.title,
    description: item.description,
    agentTypes: [],
    activityKeys: [item.title],
    activityStageIds: [getCommerceActivityStageId(mode, item.stage)],
  }));
}

/** 市场研究模式只展示实际执行的六个阶段。 */
export const COMMERCE_RESEARCH_STAGE_DEFINITIONS = toCommercePlanningStages(
  "research",
  COMMERCE_RESEARCH_PROGRESS_STAGES,
);

/** Listing Demo 模式只展示实际执行的七个阶段。 */
export const AMAZON_LISTING_STAGE_DEFINITIONS = toCommercePlanningStages(
  "listing",
  AMAZON_LISTING_PROGRESS_STAGES,
);

/**
 * 媒体任务使用独立阶段。
 * 这样右侧面板不会继续显示“代码修改、lint、build”等不相关步骤。
 */
export const MEDIA_STAGE_DEFINITIONS: PlanningStageDefinition[] = [
  {
    id: "media-understand",
    title: "识别创作需求",
    description: "确认生图、改图或视频任务",
    agentTypes: ["orchestrator"],
    activityKeys: ["媒体", "图片", "视频", "生成"],
  },
  {
    id: "media-prompt",
    title: "优化提示词",
    description: "补充构图、材质、灯光与文字策略",
    agentTypes: ["media"],
    activityKeys: ["提示词", "文字策略", "构图"],
  },
  {
    id: "media-submit",
    title: "提交模型任务",
    description: "调用百炼视觉模型并校验参数",
    agentTypes: ["media"],
    activityKeys: ["提交", "百炼", "模型请求"],
  },
  {
    id: "media-generate",
    title: "生成媒体内容",
    description: "等待模型生成并轮询任务状态",
    agentTypes: ["media"],
    activityKeys: ["生成内容", "轮询", "等待结果"],
  },
  {
    id: "media-review",
    title: "结果检查",
    description: "检查重影、重复元素、无关改动与文件可下载性",
    agentTypes: ["reviewer"],
    activityKeys: ["检查结果", "质量检查", "重影", "审查", "预览", "下载"],
  },
  {
    id: "media-deliver",
    title: "交付结果",
    description: "保存到会话并显示消耗额度",
    agentTypes: ["reviewer"],
    activityKeys: ["保存", "额度", "交付"],
  },
];

export const STATUS_META: Record<
  PlanningStageStatus,
  { label: string; color: string; background: string }
> = {
  idle: {
    label: "未开始",
    color: "var(--text-tertiary)",
    background: "var(--glass)",
  },
  queued: {
    label: "等待中",
    color: "var(--accent-amber)",
    background: "rgba(255, 214, 10, 0.11)",
  },
  active: {
    label: "进行中",
    color: "#64b5ff",
    background: "rgba(10, 132, 255, 0.13)",
  },
  completed: {
    label: "已完成",
    color: "var(--accent-green)",
    background: "rgba(48, 209, 88, 0.11)",
  },
  skipped: {
    label: "已跳过",
    color: "var(--text-secondary)",
    background: "var(--glass)",
  },
  error: {
    label: "异常",
    color: "var(--accent-red)",
    background: "rgba(255, 69, 58, 0.11)",
  },
};
