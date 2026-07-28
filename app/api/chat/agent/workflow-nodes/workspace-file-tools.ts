/**
 * 模块职责：工作区文件读取、差异生成、变更暂存与审批请求。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import type { InteractiveRequest, ModifyTaskResult, WorkerFileChange } from "../types";
import { runNormalTerminalCommand, runPtyLikeCommand, truncateText } from "./terminal-and-memory";
import { type AgentRuntimeState, type TerminalCommandOutcome, type ToolRuntimeState, type WorkerToolRuntime, classifyCommandMode, createEmptyTokenUsage, validateTerminalCommand } from "./runtime-lifecycle";
export function normalizeFileKey(filePath: string): string {
  const normalized = path.normalize(filePath).replace(/\\/g, "/").replace(/^\.\//, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function hashContent(content: string | null): string {
  return createHash("sha256")
    .update(content === null ? "<FILE_NOT_EXISTS>" : content)
    .digest("hex");
}

// 把路径限制在当前项目工作目录内，避免 Worker 通过 ../ 或绝对路径越界写入。
export async function getSafePath(filePath: string, workingDir: string): Promise<string> {
  const rootPath = path.resolve(workingDir || process.cwd());
  const normalizedInput = filePath.trim();
  const candidatePath = path.isAbsolute(normalizedInput)
    ? path.resolve(normalizedInput)
    : path.resolve(rootPath, normalizedInput.replace(/^(\.\/|\/)/, ""));
  const relativePath = path.relative(rootPath, candidatePath);
  const outsideRoot =
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath);

  if (outsideRoot) {
    throw new Error(`路径越界，拒绝访问项目目录之外的文件: ${filePath}`);
  }
  return candidatePath;
}

export async function readRawFile(
  filePath: string,
  workingDir: string,
): Promise<{ exists: boolean; content: string | null }> {
  const safePath = await getSafePath(filePath, workingDir);
  if (!fs.existsSync(safePath)) return { exists: false, content: null };
  return { exists: true, content: fs.readFileSync(safePath, "utf-8") };
}

/**
 * 判断上一轮 Worker 生成的目标内容是否已经由 Merge 写入正式工作区。
 *
 * Reviewer 返工时最常见的 no-op 场景是：第一轮修改已经落盘，但后续校验或
 * Review 又把同一槽位派回来。此时不应该强迫 Worker 再生成一份相同提案。
 */
export async function arePreviousChangesAlreadyApplied(
  previousResult: ModifyTaskResult | null,
  workingDir: string,
): Promise<boolean> {
  const previousChanges = previousResult?.fileChanges || [];
  if (!previousChanges.length) return false;

  for (const change of previousChanges) {
    const current = await readRawFile(change.filePath, workingDir);
    if (hashContent(current.content) !== change.proposedContentHash) {
      return false;
    }
  }

  return true;
}

// Worker 读取文件时优先读取自己的内存提案，避免同一 Worker 多轮修改丢失上下文。
export async function readFileFromLocalDisk(
  filePath: string,
  workingDir: string,
  proposals?: Map<string, WorkerFileChange>,
): Promise<string> {
  try {
    const staged = proposals?.get(normalizeFileKey(filePath));
    if (staged) return staged.proposedContent;

    const file = await readRawFile(filePath, workingDir);
    return file.exists ? file.content || "" : `未找到文件: ${filePath}`;
  } catch (error) {
    return `读取失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function buildSimpleDiff(oldText: string, newText: string): string {
  const oldContent = oldText.split("\n");
  const newContent = newText.split("\n");
  const maxLen = Math.max(oldContent.length, newContent.length);
  const diffLines: string[] = [];

  for (let index = 0; index < maxLen; index += 1) {
    const oldLine = oldContent[index];
    const newLine = newContent[index];
    if (oldLine === newLine) continue;
    if (oldLine !== undefined) diffLines.push(`- ${index + 1}: ${oldLine}`);
    if (newLine !== undefined) diffLines.push(`+ ${index + 1}: ${newLine}`);
  }

  return diffLines.length ? truncateText(diffLines.join("\n"), 8000) : "无差异";
}

export async function stageWorkerFileChange(
  filePath: string,
  fileContent: string,
  workingDir: string,
  runtime: WorkerToolRuntime,
): Promise<string> {
  const key = normalizeFileKey(filePath);
  const existing = runtime.proposals.get(key);
  const base = existing
    ? {
        exists: existing.baseExists,
        content: existing.baseContent,
        contentHash: existing.baseContentHash,
      }
    : await readRawFile(filePath, workingDir).then((file) => ({
        exists: file.exists,
        content: file.content,
        contentHash: hashContent(file.content),
      }));

  runtime.proposals.set(key, {
    workerId: runtime.workerId,
    slot: runtime.slot,
    filePath,
    baseExists: base.exists,
    baseContent: base.content,
    baseContentHash: base.contentHash,
    proposedContentHash: hashContent(fileContent),
    proposedContent: fileContent,
    ready: existing?.ready || false,
    sourceWorkerIds: [runtime.workerId],
    sourceSlots: [runtime.slot],
    mergeStrategy: "single",
  });

  return `已在 ${runtime.workerId} 独立上下文中暂存变更: ${filePath}。正式文件尚未写入，将由 Merge 节点统一处理。`;
}

export async function getWorkerDiff(
  filePath: string,
  runtime: WorkerToolRuntime,
): Promise<string> {
  const change = runtime.proposals.get(normalizeFileKey(filePath));
  if (!change) return `当前 Worker 未找到待合并变更: ${filePath}`;
  return buildSimpleDiff(change.baseContent || "", change.proposedContent);
}

export function markWorkerFileReady(
  filePath: string,
  runtime: WorkerToolRuntime,
): string {
  const key = normalizeFileKey(filePath);
  const change = runtime.proposals.get(key);
  if (!change) return `当前 Worker 未找到待应用变更: ${filePath}`;

  runtime.proposals.set(key, { ...change, ready: true });
  return `已将 ${filePath} 加入 Merge 队列；并发 Worker 不直接覆盖正式工作区。`;
}

// 目录预览工具，给 FileAgent / Modify Agent 一个快速“看目录结构”的能力。
export async function listDirectory(
  dirPath = ".",
  workingDir: string,
): Promise<string> {
  try {
    const targetDir = await getSafePath(dirPath, workingDir);
    const files = fs.readdirSync(targetDir, { withFileTypes: true });
    return JSON.stringify(
      files.slice(0, 40).map((item) => ({
        name: item.name,
        type: item.isDirectory() ? "directory" : "file",
      })),
      null,
      2,
    );
  } catch (error) {
    return `读取目录失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// 这是一个简化版代码库搜索器。
// 它不是最强检索，但足够给 Planner / SearchAgent 一个轻量代码感知能力。
export async function searchCodebase(
  keyword: string,
  workingDir: string,
): Promise<string> {
  const output: string[] = [];
  const rootPath = workingDir || process.cwd();
  let matchCount = 0;

  const walk = (dir: string) => {
    if (matchCount >= 20) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (matchCount >= 20) return;
      const fullPath = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        [
          ".git",
          ".next",
          ".next-electron",
          ".electron",
          "node_modules",
          "dist",
          "build",
          "out",
          "out-server",
          "release",
        ].includes(
          entry.name,
        )
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      const ext = path.extname(entry.name);
      if (![".ts", ".tsx", ".js", ".jsx", ".json", ".md"].includes(ext)) {
        continue;
      }

      const content = fs.readFileSync(fullPath, "utf-8");
      if (!content.toLowerCase().includes(keyword.toLowerCase())) continue;

      output.push(path.relative(rootPath, fullPath));
      matchCount += 1;
    }
  };

  try {
    walk(rootPath);
    return output.length
      ? `命中 ${output.length} 个文件:\n${output.join("\n")}`
      : `未搜索到关键字 "${keyword}"`;
  } catch (error) {
    return `搜索失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// 终端命令现在不再一刀切地全走同步 execSync。
// 这里会先路由成：
// - 普通命令：直接短命令执行；
// - PTY 命令：走交互会话层，并在需要时把 Prompt 升级给 Interactive Manager。
export async function runTerminalCommand(
  command: string,
  workingDir: string,
  state: AgentRuntimeState,
  timeoutMs = 20_000,
): Promise<TerminalCommandOutcome> {
  const validationError = validateTerminalCommand(command);
  if (validationError) {
    return {
      output: validationError,
      mode: "normal",
      success: false,
      exitCode: null,
      interactiveRequest: null,
      tokenUsage: createEmptyTokenUsage(),
    };
  }

  const mode = classifyCommandMode(command);
  if (mode === "pty") {
    return runPtyLikeCommand(command, workingDir, state);
  }
  return runNormalTerminalCommand(command, workingDir, timeoutMs);
}

// 对 `.pending` 版本和正式文件做简化 diff。
// 这里的目标不是生成标准补丁，而是给模型和人看“改了哪些行”。
export async function getDiff(filePath: string, workingDir: string): Promise<string> {
  const safePath = await getSafePath(filePath, workingDir);
  const pendingPath = `${safePath}.pending`;

  if (!fs.existsSync(safePath)) return `原文件不存在: ${filePath}`;
  if (!fs.existsSync(pendingPath)) return `未找到待应用变更: ${filePath}.pending`;

  const oldContent = fs.readFileSync(safePath, "utf-8").split("\n");
  const newContent = fs.readFileSync(pendingPath, "utf-8").split("\n");
  const maxLen = Math.max(oldContent.length, newContent.length);
  const diffLines: string[] = [];

  for (let index = 0; index < maxLen; index += 1) {
    const oldLine = oldContent[index];
    const newLine = newContent[index];
    if (oldLine === newLine) continue;
    if (oldLine !== undefined) diffLines.push(`- ${index + 1}: ${oldLine}`);
    if (newLine !== undefined) diffLines.push(`+ ${index + 1}: ${newLine}`);
  }

  return diffLines.length ? diffLines.join("\n") : "无差异";
}

// 真正把 `.pending` 变更覆盖到正式文件上。
// 也就是说，propose 只是提案，apply 才是落盘。
export async function applyFileChange(
  filePath: string,
  workingDir: string,
): Promise<string> {
  const safePath = await getSafePath(filePath, workingDir);
  const pendingPath = `${safePath}.pending`;

  if (!fs.existsSync(pendingPath)) return `未找到待应用变更: ${filePath}.pending`;
  fs.copyFileSync(pendingPath, safePath);
  fs.unlinkSync(pendingPath);
  return `已应用修改: ${filePath}`;
}

// 先把模型给出的新文件内容写到 `.pending`，不立刻覆盖正式文件。
// 这样中间还能先做 diff，让链路更安全。
export async function proposeFileChange(
  filePath: string,
  fileContent: string,
  workingDir: string,
): Promise<string> {
  const safePath = await getSafePath(filePath, workingDir);
  fs.mkdirSync(path.dirname(safePath), { recursive: true });
  fs.writeFileSync(`${safePath}.pending`, fileContent, "utf-8");
  return `已生成待应用变更: ${filePath}.pending`;
}

// Reviewer 需要看“修改后的文件大概长什么样”。
// 这个函数会把若干关键文件截成预览片段，避免把整份源码都塞给 Reviewer。
export async function buildFilePreview(
  files: string[],
  workingDir: string,
  lineLimit = 120,
): Promise<string> {
  const sections: string[] = [];
  for (const file of files.slice(0, 6)) {
    const content = await readFileFromLocalDisk(file, workingDir);
    sections.push(
      `文件 ${file}:\n${truncateText(content.split("\n").slice(0, lineLimit).join("\n"), 2500)}`,
    );
  }
  return sections.join("\n\n");
}

/** 把未知工具参数安全转换为字符串，避免运行时出现对象隐式拼接。 */
export function readToolStringArgument(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

/** 为 MCP 高风险工具生成稳定审批令牌；同一参数获批后可精确恢复。 */
export function createMcpApprovalToken(
  state: ToolRuntimeState,
  toolName: string,
  args: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectId: state.projectId || "unbound-project",
        workerId: state.workerRuntime?.workerId || "main",
        toolName,
        args,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

/**
 * 生成可放入 Checkpoint/UI 的 MCP 参数预览。
 *
 * 原始参数仍只用于服务端哈希和实际调用；预览会脱敏、限深、限长，避免 API Key、
 * 大段源码或二进制字符串通过 interactiveRequest 进入 State。
 */
export function buildApprovalArgumentPreview(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return truncateText(value, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 12)
      .map((item) => buildApprovalArgumentPreview(item, depth + 1));
  }
  if (typeof value === "object") {
    const preview: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 20)) {
      preview[key] = /api.?key|authorization|password|secret|token/iu.test(key)
        ? "[REDACTED]"
        : buildApprovalArgumentPreview(item, depth + 1);
    }
    return preview;
  }
  return truncateText(String(value), 500);
}

export function buildMcpApprovalRequest(
  state: ToolRuntimeState,
  toolName: string,
  args: Record<string, unknown>,
  approvalToken: string,
): InteractiveRequest {
  return {
    id: `mcp-approval-${approvalToken}`,
    source: "mcp_tool_approval",
    command: "",
    prompt: `是否允许 Agent 执行 MCP 工具 ${toolName}？`,
    mode: "normal",
    kind: "confirm",
    suggestedMode: "user",
    options: [
      { label: "批准并继续", value: "approve", index: 0 },
      { label: "拒绝并停止", value: "reject", index: 1 },
    ],
    allowMultiple: false,
    promptRound: 1,
    recentOutput: "",
    title: "MCP 工具需要人工确认",
    description:
      "该工具在 MCP 配置中被标记为高风险。批准仅对当前任务、当前工具和当前参数生效。",
    approvalKind: "mcp_tool",
    riskLevel: "high",
    toolName,
    toolArguments: buildApprovalArgumentPreview(args) as Record<
      string,
      unknown
    >,
    approvalToken,
    originalUserRequest: state.currentUserRequest || "",
    workerId: state.workerRuntime?.workerId,
    slot: state.workerRuntime?.slot,
  };
}
