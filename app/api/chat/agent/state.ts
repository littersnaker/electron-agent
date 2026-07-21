import { BaseMessage } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import {
  DEFAULT_PLANNER_PAYLOAD,
  DEFAULT_REVIEW_PAYLOAD,
  InteractiveRequest,
  ModifyTaskResult,
  PlannerPayload,
  PlannerValidationStatus,
  ReviewPayload,
} from "./types";

/*
 * 这个文件定义的是整张 LangGraph 图共享的“总状态”。
 *
 * 可以把它想象成一个全局白板：
 * - 每个节点来这里读自己需要的信息；
 * - 每个节点把自己的输出也写回这里；
 * - 后面的节点再继续接着用。
 *
 * 为什么要拆这么细？
 * 因为这套流程不是单 Agent 串行跑，而是：
 * 1. 前面多个 Agent 并发收集上下文；
 * 2. 中间 Planner / 校验 / 修复 / 降级多分支流转；
 * 3. 后面 Modify A/B/C 并发执行；
 * 4. Reviewer 再决定局部返工还是进入最终校验。
 *
 * 如果状态字段不拆开，后面就很难知道“当前到底在哪一步、为什么走到这里、谁产出的这份数据”。
 */
export const AgentState = Annotation.Root({
  // LangGraph 自带的消息通道，保存用户、助手、工具调用的完整轨迹。
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  model: Annotation<string>,
  // 长期记忆摘要：跨多轮对话保留高价值上下文，避免每轮都把全量消息送给模型。
  summary: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  // 三个上下文 Agent 的独立输出。
  searchContext: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  memoryContext: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  fileContext: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  mergedContext: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  // Planner 的结构化输出：每一项就是一个可并行执行的子任务。
  // 注意：这里存的是“已经通过解析后的任务数组”，不是模型原始文本。
  plannerOutput: Annotation<PlannerPayload>({
    reducer: (x, y) => y ?? x,
    default: () => DEFAULT_PLANNER_PAYLOAD,
  }),
  // Planner 原始文本输出，供后续 JSON Schema 校验节点单独解析。
  // 单独保留原始文本，是为了调试和重规划时能知道模型第一次到底返回了什么。
  plannerRawOutput: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  // 记录 Planner 校验/修复/降级当前所处阶段，方便图路由与前端状态展示。
  // 这相当于 Planner 子流程里的“状态机状态”。
  plannerValidationStatus: Annotation<PlannerValidationStatus>({
    reducer: (x, y) => y ?? x,
    default: () => "pending",
  }),
  // 给人看的说明文本：
  // 当前是 schema 失败、文件重复、规则修复，还是已经降级，都会写在这里。
  plannerValidationMessage: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  // Planner 重试计数器：用于限制 Retry Planner 最多执行 2~3 次。
  // 这样做是为了避免模型持续输出坏结构，导致图无限自旋。
  plannerRetryCount: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => 0,
  }),
  // 记录“为什么要重试 Planner”，下一次重规划时会把这段原因喂回给模型。
  plannerRetryReason: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  // Structured Task List 节点会把结构化任务再整理成一份可读摘要。
  structuredTaskListSummary: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  // 这个布尔值的含义很朴素：当前请求到底要不要进入代码修改链路。
  // 比如有些场景只是解释、总结、分析，就不一定真的要改文件。
  requiresChanges: Annotation<boolean>({
    reducer: (x, y) => y ?? x,
    default: () => false,
  }),
  // 三路 Modify 的执行结果会按 slot 合并到这里。
  modifyResults: Annotation<ModifyTaskResult[]>({
    reducer: (currentState, newValue) => {
      if (!newValue?.length) return currentState;
      const resultMap = new Map(currentState.map((item) => [item.slot, item]));
      newValue.forEach((item) => resultMap.set(item.slot, item));
      return Array.from(resultMap.values()).sort(
        (left, right) => left.slot - right.slot,
      );
    },
    default: () => [],
  }),
  // Merge Patch 节点只汇总三路结果，不自动合并同文件 patch。
  mergedPatchSummary: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  // Reviewer 的结构化审查结论与控制字段。
  // 这几个字段共同决定“返工谁、返工多少轮、为什么返工”。
  reviewPayload: Annotation<ReviewPayload>({
    reducer: (x, y) => y ?? x,
    default: () => DEFAULT_REVIEW_PAYLOAD,
  }),
  reviewFeedback: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  reviewDecision: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "PASS",
  }),
  // Reviewer 指定要返工的任务槽位列表。
  // 例如 [0] 表示只重跑 Modify A，不要把 B/C 也重新跑一遍。
  retryTaskSlots: Annotation<number[]>({
    reducer: (x, y) => y ?? x,
    default: () => [],
  }),
  // Reviewer 已经打回了多少轮，用来阻止无限返工。
  reviewIteration: Annotation<number>({
    reducer: (x, y) => y ?? x,
    default: () => 0,
  }),
  // Lint / Build / Test 节点的原始输出。
  lintSummary: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  // Final Report 节点生成的最终可读结论。
  finalReportSummary: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  // 所有在本轮流程里被读取/提议修改/实际修改过的文件集合。
  // 后面的 Reviewer、Lint / Build / Test、Final Report 都依赖这份清单。
  touchedFiles: Annotation<string[]>({
    reducer: (currentState, newValue) => {
      if (!newValue) return currentState;
      return Array.from(new Set([...currentState, ...newValue]));
    },
    default: () => [],
  }),
  // 当 PTY 命令在中途出现交互式 Prompt，且自动策略无法安全继续时，
  // 会把“待回答的问题”写到这里。
  // 这样前端就能显示按钮，下一轮也能知道要恢复的是哪一次交互。
  interactiveRequest: Annotation<InteractiveRequest | null>({
    reducer: (_currentState, newValue) => newValue ?? null,
    default: () => null,
  }),
  // 运行环境相关字段。
  workingDir: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  projectId: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  apiKey: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  // 全局 Token 累加器：每个节点把本轮消耗写进来，这里做自动累加。
  tokenUsage: Annotation<{ prompt: number; completion: number; total: number }>({
    reducer: (currentState, newValue) => {
      if (!newValue) return currentState;
      return {
        prompt: currentState.prompt + (newValue.prompt || 0),
        completion: currentState.completion + (newValue.completion || 0),
        total: currentState.total + (newValue.total || 0),
      };
    },
    default: () => ({ prompt: 0, completion: 0, total: 0 }),
  }),
});
