/*
 * 这个文件只放“结构定义”，不放业务逻辑。
 *
 * 交互终端相关的数据也统一放在这里，保证：
 * - 后端终端会话；
 * - LangGraph 状态；
 * - SSE 接口；
 * - 前端交互卡片
 * 使用同一套字段。
 */

export interface PlanTask {
  task: string;
  files: string[];
}

export type PlannerPayload = PlanTask[];

export const DEFAULT_PLANNER_PAYLOAD: PlannerPayload = [];

export type PlannerValidationStatus =
  | "pending"
  | "schema_valid"
  | "schema_invalid"
  | "files_unique"
  | "files_duplicated"
  | "rules_repaired"
  | "single_agent_degraded";

export interface ModifyTaskResult {
  slot: number;
  task: string;
  files: string[];
  summary: string;
  touchedFiles: string[];
  status: "pending" | "done" | "skipped" | "blocked";
}

export type CommandExecutionMode = "normal" | "pty";

export type InteractiveResponseMode = "auto" | "llm" | "user" | "cancel";

export type InteractivePromptKind =
  | "confirm"
  | "select"
  | "multiselect"
  | "input";

export type InteractiveTerminalStatus =
  | "idle"
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface InteractiveOption {
  /** 前端展示文字 */
  label: string;
  /** 稳定值，前端提交时优先传这个字段 */
  value: string;
  /** 菜单中的顺序，用于生成方向键序列 */
  index: number;
  /** CLI 当前是否已经选中 */
  selected?: boolean;
  /** CLI 当前光标是否停在这一项 */
  focused?: boolean;
}

export interface InteractiveRequest {
  id: string;
  command: string;
  prompt: string;
  mode: CommandExecutionMode;
  kind: InteractivePromptKind;
  suggestedMode: InteractiveResponseMode;
  options: Array<{ label: string; value: string }>;
  allowMultiple: boolean;
  promptRound: number;
  recentOutput: string;
}

/**
 * 前端点击按钮后直接 POST 这个对象，不再把选择伪装成普通聊天文本。
 */
export interface InteractiveReply {
  requestId: string;
  mode: InteractiveResponseMode;
  /** input/confirm，或兼容旧前端时使用 */
  answer?: string;
  /** select 时推荐只传一个 value */
  selectedValue?: string;
  /** multiselect 时传所有最终选中的 value */
  selectedValues?: string[];
}

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
