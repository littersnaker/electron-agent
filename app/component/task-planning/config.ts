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
  },
  {
    id: "context",
    title: "收集上下文",
    description: "检索索引、代码、文件和项目记忆",
    agentTypes: ["researcher"],
    activityKeys: ["search", "read", "搜索", "读取", "上下文"],
  },
  {
    id: "plan",
    title: "拆解计划",
    description: "生成模块计划和可并行任务",
    agentTypes: ["planner"],
    activityKeys: ["planner", "planning", "规划", "任务拆解"],
  },
  {
    id: "execute",
    title: "并行执行",
    description: "读取、修改并准备文件变更",
    agentTypes: ["coder"],
    activityKeys: ["propose_file_change", "apply_file_change", "代码任务"],
  },
  {
    id: "verify",
    title: "合并与验证",
    description: "检查差异并运行 lint、build 和 test",
    agentTypes: ["terminal"],
    activityKeys: ["get_diff", "run_terminal_command", "lint", "build", "test"],
  },
  {
    id: "review",
    title: "统一审查",
    description: "审查质量、风险并生成最终回答",
    agentTypes: ["reviewer"],
    activityKeys: ["review", "final_report", "审查", "最终报告"],
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
