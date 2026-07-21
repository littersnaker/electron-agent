/*
 * 这个文件只放“结构定义”，不放业务逻辑。
 *
 * 你可以把它理解成整套 Agent 流程的“数据词典”：
 * 1. Planner 会产出什么结构；
 * 2. Modify 会把执行结果整理成什么结构；
 * 3. Reviewer 会返回什么结构；
 * 4. 这些结构在状态图里如何流转。
 *
 * 以后如果你想先搞懂“节点之间到底传了什么数据”，优先从这里开始看。
 */

// Planner 输出的最小单元：一个子任务对应一组目标文件。
export interface PlanTask {
  task: string;
  files: string[];
}

// PlannerPayload 是 Planner 最终产出的任务数组。
// 之所以设计成数组，是因为后面要把它拆给 Modify A / B / C 并发执行。
export type PlannerPayload = PlanTask[];

export const DEFAULT_PLANNER_PAYLOAD: PlannerPayload = [];

// 这是 Planner 校验链路里的状态枚举。
// 你可以把它理解成 Planner 在图里“走到了哪一步”的路标：
// pending -> 还没校验
// schema_valid / schema_invalid -> JSON 结构是否合法
// files_unique / files_duplicated -> 文件是否重复
// rules_repaired -> 规则修复后可继续
// single_agent_degraded -> 最后降级成单 Agent 执行
export type PlannerValidationStatus =
  | "pending"
  | "schema_valid"
  | "schema_invalid"
  | "files_unique"
  | "files_duplicated"
  | "rules_repaired"
  | "single_agent_degraded";

// 单个 Modify 槽位的执行结果，会被合并到状态里的 modifyResults。
// slot 对应 A / B / C 三个并行槽位。
export interface ModifyTaskResult {
  slot: number;
  task: string;
  files: string[];
  summary: string;
  touchedFiles: string[];
  status: "pending" | "done" | "skipped" | "blocked";
}

// Code Agent 的命令现在不再一刀切地全走同步 exec，
// 而是会先做一层“命令路由”：
// 1. 普通命令：例如 ls / git status / npm run build，直接短命令执行；
// 2. PTY 命令：例如 npm create / pnpm dlx / python manage.py，需要模拟交互会话；
// 3. Interactive Manager：当 PTY 命令中途弹出 Prompt 时，决定是自动回答、LLM 回答还是等用户按钮回答。
export type CommandExecutionMode = "normal" | "pty";

export type InteractiveResponseMode = "auto" | "llm" | "user";

export interface InteractiveOption {
  label: string;
  value: string;
}

export interface InteractiveRequest {
  id: string;
  command: string;
  prompt: string;
  mode: CommandExecutionMode;
  suggestedMode: InteractiveResponseMode;
  options: InteractiveOption[];
}

// Reviewer 只负责做“通过 / 返工”的结构化判定。
// 它不直接改代码，而是告诉图：
// 1. 当前结果能不能过；
// 2. 为什么不过；
// 3. 哪几个任务槽位需要返工。
export interface ReviewPayload {
  decision: "PASS" | "RETRY";
  feedback: string;
  risks: string[];
  retryTasks: number[];
}

export const DEFAULT_REVIEW_PAYLOAD: ReviewPayload = {
  decision: "PASS",
  feedback: "",
  risks: [],
  retryTasks: [],
};

/*
 * 这个函数的作用不是给模型看，而是给人看。
 *
 * Planner 真实存的是 JSON 数组，但 JSON 直接读起来不够顺手。
 * 所以后续 Structured Task List、Modify 提示词、Final Report
 * 都会把它格式化成更适合阅读的文本。
 */
export function formatPlannerPayload(plan: PlannerPayload): string {
  if (!plan.length) return "暂无计划任务。";

  return plan
    .map(
      (item, index) =>
        `${index + 1}. ${item.task}\n文件: ${
          item.files.length ? item.files.join(", ") : "未指定"
        }`,
    )
    .join("\n\n");
}
