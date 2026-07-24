import type { AgentRequestMode } from "./types";

const CHANGE_REQUEST_PATTERN =
  /(修改|改造|重构|优化|修复|实现|新增|添加|加上|创建|开发|删除|迁移|替换|更新|写代码|apply|fix|refactor|implement|create|delete)/i;
const WORKSPACE_INFO_PATTERN =
  /(当前目录|工作目录|项目路径|项目根目录|文件夹名|项目名称|当前项目|绑定项目)/i;
const PROJECT_CONTENT_PATTERN =
  /(有哪些|有什么|包含|结构|文件(?!夹)|代码|内容|依赖|模块|搜索|查找|分析)/i;

/**
 * 轻量修改目前只覆盖文档类文件。
 *
 * 这里刻意不把 package.json / tsconfig 等配置文件纳入 fast path，
 * 因为这些文件虽然常见，但修改后通常仍需要工程级验证。
 */
const SIMPLE_EDIT_FILE_PATTERN =
  /((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.(?:md|mdx|txt|rst|adoc))/gi;

/**
 * 只有“修改既有文件”的语义才需要询问是否新建。
 * 明确的创建/删除任务不进入确认流程，避免出现“要创建文件，却先问是否创建”的重复交互。
 */
const EXISTING_FILE_MUTATION_PATTERNS = [
  /(?:修改|更新|修复|重写|调整|改造|优化|替换|编辑)\s*(?:文件)?\s*[`"']?((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/gi,
  /把\s*[`"']?((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)[`"']?\s*(?:文件)?\s*(?:修改|更新|替换|改成|调整|重写)/gi,
  /(?:modify|update|fix|rewrite|edit|replace)\s+[`"']?((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/gi,
];

const EXPLICIT_CREATE_FILE_PATTERN =
  /(?:(?:创建|新建|生成|create|generate)\s*(?:一个|新的|文件)?|(?:新增|添加|add)\s*(?:一个|新的)?\s*文件)\s*[`"']?((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/i;

const EXPLICIT_DELETE_FILE_PATTERN =
  /(?:删除|移除|delete|remove)\s*(?:文件)?\s*[`"']?((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/i;

const CREATE_IF_MISSING_PATTERN =
  /(?:不存在|没有|找不到|缺失).{0,20}(?:创建|新建|生成)|(?:if\s+(?:it\s+)?(?:does\s+not|doesn't)\s+exist).{0,20}create/i;

function normalizeCandidateFilePath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/[),.;:，。；：]+$/u, "")
    .trim();
}

function collectPatternMatches(
  input: string,
  pattern: RegExp,
  captureIndex: number,
): string[] {
  const matches: string[] = [];
  pattern.lastIndex = 0;

  for (const match of input.matchAll(pattern)) {
    const filePath = match[captureIndex];
    if (!filePath) continue;
    const normalized = normalizeCandidateFilePath(filePath);
    if (normalized && !normalized.toLowerCase().startsWith("http")) {
      matches.push(normalized);
    }
  }

  return matches;
}

/** 从用户请求中提取显式出现的文档路径，供 simple_edit 直接生成单任务计划。 */
export function extractSimpleEditFiles(userRequest: string): string[] {
  const files: string[] = [];
  SIMPLE_EDIT_FILE_PATTERN.lastIndex = 0;

  for (const match of userRequest.matchAll(SIMPLE_EDIT_FILE_PATTERN)) {
    const filePath = normalizeCandidateFilePath(match[1] || "");
    if (filePath && !filePath.toLowerCase().startsWith("http")) {
      files.push(filePath);
    }
  }

  return Array.from(new Set(files));
}

/**
 * 提取“用户明确认为应该已经存在”的修改目标文件。
 *
 * 这不是通用文件提取器：例如“参考 package.json 修改 README.md”只应把 README.md
 * 当成需要确认的目标，避免把上下文文件误判成待创建文件。
 */
export function extractExistingFileMutationTargets(
  userRequest: string,
): string[] {
  if (
    EXPLICIT_CREATE_FILE_PATTERN.test(userRequest) ||
    EXPLICIT_DELETE_FILE_PATTERN.test(userRequest) ||
    CREATE_IF_MISSING_PATTERN.test(userRequest)
  ) {
    return [];
  }

  const targets: string[] = [];
  for (const pattern of EXISTING_FILE_MUTATION_PATTERNS) {
    targets.push(...collectPatternMatches(userRequest, pattern, 1));
  }

  if (targets.length) {
    return Array.from(new Set(targets));
  }

  // 单文档轻量任务通常只有一个显式文件名。即使自然语言顺序不标准，
  // 也可以安全地把它当作“既有文件修改”的确认目标。
  const simpleEditFiles = extractSimpleEditFiles(userRequest);
  return simpleEditFiles.length === 1 ? simpleEditFiles : [];
}

/**
 * 使用确定性规则分类 Code Agent 请求。
 *
 * 修改意图优先级最高；若用户明确指出一个文档文件，则进入 simple_edit，
 * 避免 README/CHANGELOG 之类任务也走完整的多层 Planner。
 */
export function classifyAgentRequest(userRequest: string): AgentRequestMode {
  if (userRequest.startsWith("[INTERACTIVE_REPLY]")) {
    return "code_change";
  }

  if (CHANGE_REQUEST_PATTERN.test(userRequest)) {
    const simpleEditFiles = extractSimpleEditFiles(userRequest);
    if (simpleEditFiles.length === 1) {
      return "simple_edit";
    }
    return "code_change";
  }

  if (
    WORKSPACE_INFO_PATTERN.test(userRequest) &&
    !PROJECT_CONTENT_PATTERN.test(userRequest)
  ) {
    return "workspace_info";
  }

  return "read_only";
}
