// 模块说明：负责 config 用户界面组件。
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
 * Cross-border Market Intelligence Agent 的阶段直接对应独立市场研究流程。
 * 它不使用 Code Agent 的 Planner / Merge / Build 语义，避免运营任务出现误导性状态。
 */
export const COMMERCE_STAGE_DEFINITIONS: PlanningStageDefinition[] = [
  {
    id: "commerce-intent",
    title: "理解研究目标",
    description: "识别目标市场、品类范围与研究决策目标",
    agentTypes: [],
    activityKeys: ["理解运营目标", "intent", "运营目标"],
  },
  {
    id: "commerce-category",
    title: "生成市场检索计划",
    description: "将自然语言描述解析为公开 SERP / Shopping 检索词与细分方向",
    agentTypes: [],
    activityKeys: ["解析跨平台类目", "category", "类目"],
  },
  {
    id: "commerce-collect",
    title: "采集公开市场信号",
    description: "TalorData 为核心；Amazon、Keepa、TikTok、Temu、1688 作为可选增强",
    agentTypes: [],
    activityKeys: ["并行采集市场数据", "collect", "市场数据"],
  },
  {
    id: "commerce-normalize",
    title: "统一市场观察",
    description: "去重公开结果并统一域名、价格、评分与商品增强字段",
    agentTypes: [],
    activityKeys: ["清洗市场样本", "normalize", "清洗"],
  },
  {
    id: "commerce-analyze",
    title: "计算市场指标",
    description: "以确定性代码计算市场活跃度、竞争开放度与价格信号",
    agentTypes: [],
    activityKeys: ["计算市场指标", "analyze", "市场指标"],
  },
  {
    id: "commerce-strategy",
    title: "生成市场情报结论",
    description: "区分已获取数据与缺失数据，生成机会、风险和下一步验证动作",
    agentTypes: [],
    activityKeys: ["生成运营策略", "完成市场研究", "strategy", "策略"],
  },
];

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
  error: {
    label: "异常",
    color: "var(--accent-red)",
    background: "rgba(255, 69, 58, 0.11)",
  },
};
