import type {
  PlanningStageDefinition,
  PlanningStageStatus,
} from "./types";

/** 任务规划面板展示的稳定阶段定义。 */
export const STAGE_DEFINITIONS: PlanningStageDefinition[] = [
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
    activityKeys: [
      "search_project_index",
      "search_codebase",
      "read_file_from_disk",
      "list_directory",
      "searchagent",
      "fileagent",
      "搜索",
      "读取项目",
      "上下文",
    ],
  },
  {
    id: "plan",
    title: "拆解计划",
    description: "生成模块计划和可并行叶子任务",
    agentTypes: ["planner"],
    activityKeys: ["planner", "planning", "structured", "规划", "任务拆解"],
  },
  {
    id: "execute",
    title: "并行执行",
    description: "Worker 读取、修改并准备文件变更",
    agentTypes: ["coder"],
    activityKeys: [
      "propose_file_change",
      "apply_file_change",
      "worker",
      "生成修改方案",
      "应用文件修改",
      "代码任务",
    ],
  },
  {
    id: "verify",
    title: "合并与验证",
    description: "检查差异并运行 lint、build 和 test",
    agentTypes: ["terminal"],
    activityKeys: [
      "get_diff",
      "run_terminal_command",
      "merge",
      "lint",
      "build",
      "test",
      "合并",
      "构建",
      "测试",
    ],
  },
  {
    id: "review",
    title: "统一审查",
    description: "审查质量、风险并生成最终回答",
    agentTypes: ["reviewer"],
    activityKeys: ["review", "final_report", "只读项目回答", "审查", "最终报告"],
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
