/**
 * 模块职责：包管理器识别、验证策略与构建测试执行。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import fs from "fs";
import path from "path";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { DEFAULT_VERIFICATION_RESULT, VerificationCheckResult, VerificationProfile, VerificationResult } from "../types";
import { AgentRuntimeState, buildLifecycleStateUpdate, createLifecycleTracker } from "./runtime-lifecycle";
import { truncateText } from "./terminal-and-memory";
import { runTerminalCommand } from "./workspace-file-tools";
// 这个节点负责真实工程校验，而不是模型主观判断。
// 也就是常说的“最后再跑一遍 lint / build / test 看看有没有真炸”。
export function detectProjectPackageManager(workingDir: string): {
  name: "pnpm" | "npm" | "yarn" | "bun";
  runScript: (script: string) => string;
  runBinary: (binary: string, args: string) => string;
} {
  if (fs.existsSync(path.join(workingDir, "pnpm-lock.yaml"))) {
    return {
      name: "pnpm",
      runScript: (script) => `pnpm run ${script}`,
      runBinary: (binary, args) => `pnpm exec ${binary} ${args}`.trim(),
    };
  }
  if (
    fs.existsSync(path.join(workingDir, "bun.lockb")) ||
    fs.existsSync(path.join(workingDir, "bun.lock"))
  ) {
    return {
      name: "bun",
      runScript: (script) => `bun run ${script}`,
      runBinary: (binary, args) => `bunx ${binary} ${args}`.trim(),
    };
  }
  if (fs.existsSync(path.join(workingDir, "yarn.lock"))) {
    return {
      name: "yarn",
      runScript: (script) => `yarn ${script}`,
      runBinary: (binary, args) => `yarn ${binary} ${args}`.trim(),
    };
  }
  return {
    name: "npm",
    runScript: (script) => `npm run ${script}`,
    runBinary: (binary, args) => `npx ${binary} ${args}`.trim(),
  };
}

export const DOCUMENT_FILE_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".adoc",
]);

/** 根据真实落盘文件决定验证强度，避免文档修改触发整个项目的 build/test。 */
export function resolveVerificationProfile(
  touchedFiles: string[],
): VerificationProfile {
  if (!touchedFiles.length) return "none";

  if (
    touchedFiles.every((file) =>
      DOCUMENT_FILE_EXTENSIONS.has(path.extname(file).toLowerCase()),
    )
  ) {
    return "document";
  }

  if (
    touchedFiles.every((file) =>
      [".ts", ".tsx", ".js", ".jsx"].includes(path.extname(file).toLowerCase()),
    )
  ) {
    return "targeted";
  }

  return "full";
}

export async function lintBuildTestNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "verification_agent",
    "verification_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("VERIFYING", "正在根据变更类型选择工程验证策略。");

  const buildCheck = (
    status: VerificationCheckResult["status"],
    command: string | null,
    output: string,
  ): VerificationCheckResult => ({ status, command, output });

  const formatVerification = (result: VerificationResult): string =>
    [
      `Package Manager:\n${result.packageManager}`,
      `Overall:\n${result.overall}`,
      `Lint [${result.lint.status}]${
        result.lint.command ? ` (${result.lint.command})` : ""
      }:\n${truncateText(result.lint.output, 3000)}`,
      `Build [${result.build.status}]${
        result.build.command ? ` (${result.build.command})` : ""
      }:\n${truncateText(result.build.output, 3000)}`,
      `Test [${result.test.status}]${
        result.test.command ? ` (${result.test.command})` : ""
      }:\n${truncateText(result.test.output, 3000)}`,
      `Summary:\n${result.summary}`,
    ].join("\n\n");

  if (state.interactiveRequest) {
    const verificationResult: VerificationResult = {
      ...DEFAULT_VERIFICATION_RESULT,
      lint: buildCheck("blocked", null, "存在挂起交互请求，暂不执行 lint。"),
      build: buildCheck("blocked", null, "存在挂起交互请求，暂不执行 build。"),
      test: buildCheck("blocked", null, "存在挂起交互请求，暂不执行 test。"),
      overall: "blocked",
      summary: "存在挂起交互请求，工程验证已暂停。",
    };
    tracker.transition("BLOCKED", verificationResult.summary);
    return {
      verificationResult,
      lintSummary: formatVerification(verificationResult),
      ...buildLifecycleStateUpdate(tracker),
    };
  }

  if (
    state.mergeResult?.status === "conflict" ||
    state.mergeResult?.status === "failed"
  ) {
    const verificationResult: VerificationResult = {
      ...DEFAULT_VERIFICATION_RESULT,
      lint: buildCheck("blocked", null, "Merge 未成功，未执行 lint。"),
      build: buildCheck("blocked", null, "Merge 未成功，未执行 build。"),
      test: buildCheck("blocked", null, "Merge 未成功，未执行 test。"),
      overall: "blocked",
      summary: "Merge 冲突或写入失败，工程验证不会在不确定工作区上运行。",
    };
    tracker.transition("BLOCKED", verificationResult.summary);
    return {
      verificationResult,
      lintSummary: formatVerification(verificationResult),
      ...buildLifecycleStateUpdate(tracker),
    };
  }

  if (!state.requiresChanges) {
    const verificationResult: VerificationResult = {
      ...DEFAULT_VERIFICATION_RESULT,
      summary: "当前请求无需代码修改，跳过工程验证。",
    };
    tracker.transition("COMPLETED", verificationResult.summary);
    return {
      verificationResult,
      lintSummary: formatVerification(verificationResult),
      ...buildLifecycleStateUpdate(tracker),
    };
  }

  const touchedFiles: string[] = state.touchedFiles || [];
  const workingDir = state.workingDir || process.cwd();
  const verificationProfile = resolveVerificationProfile(touchedFiles);

  /**
   * 文档修改的正确验证目标是“文件是否已经成功落盘”，而不是整个应用能否构建。
   * 项目原有的 TypeScript/build 错误不能反向把 README 修改判成失败。
   */
  if (verificationProfile === "document") {
    const missingFiles = touchedFiles.filter((file) => {
      try {
        return !fs.existsSync(path.resolve(workingDir, file));
      } catch {
        return true;
      }
    });
    const overall: VerificationResult["overall"] = missingFiles.length
      ? "failed"
      : "passed";
    const verificationResult: VerificationResult = {
      ...DEFAULT_VERIFICATION_RESULT,
      profile: "document",
      lint: buildCheck(
        "skipped",
        null,
        "仅修改文档文件，不运行代码 lint。",
      ),
      build: buildCheck(
        "skipped",
        null,
        "仅修改文档文件，不运行项目 build。",
      ),
      test: buildCheck(
        "skipped",
        null,
        "仅修改文档文件，不运行项目 test。",
      ),
      overall,
      summary: missingFiles.length
        ? `文档落盘检查失败，缺少文件: ${missingFiles.join(", ")}`
        : `文档落盘检查通过：${touchedFiles.join(", ")}。`,
    };

    tracker.transition(
      overall === "passed" ? "COMPLETED" : "FAILED",
      verificationResult.summary,
    );
    return {
      verificationResult,
      lintSummary: formatVerification(verificationResult),
      ...buildLifecycleStateUpdate(tracker),
    };
  }

  const packageJsonPath = path.join(workingDir, "package.json");
  const packageManager = detectProjectPackageManager(workingDir);
  const lintableFiles = touchedFiles.filter((file: string) =>
    [".ts", ".tsx", ".js", ".jsx"].includes(path.extname(file)),
  );

  let scripts: Record<string, string> = {};
  let packageJsonError = "";
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(packageJsonPath, "utf-8"),
      ) as { scripts?: Record<string, string> };
      scripts = packageJson.scripts || {};
    } catch (error) {
      packageJsonError = `package.json 解析失败: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  } else {
    packageJsonError = "未找到 package.json。";
  }

  let lint = buildCheck(
    "skipped",
    null,
    lintableFiles.length
      ? "尚未执行 lint。"
      : "没有需要单文件 lint 的 JS/TS 变更。",
  );
  if (lintableFiles.length > 0) {
    const quotedFiles = lintableFiles.map((file: string) => `"${file}"`).join(" ");
    const command = packageManager.runBinary("eslint", quotedFiles);
    const outcome = await runTerminalCommand(
      command,
      workingDir,
      state,
      120_000,
    );
    lint = buildCheck(
      outcome.success ? "passed" : "failed",
      command,
      outcome.output || (outcome.success ? "Lint 成功。" : "Lint 失败。"),
    );
  }

  let build = buildCheck(
    "skipped",
    null,
    packageJsonError || "未配置 build 脚本，跳过。",
  );
  if (scripts.build) {
    const command = packageManager.runScript("build");
    const outcome = await runTerminalCommand(
      command,
      workingDir,
      state,
      120_000,
    );
    build = buildCheck(
      outcome.success ? "passed" : "failed",
      command,
      outcome.output || (outcome.success ? "Build 成功。" : "Build 失败。"),
    );
  }

  let test = buildCheck(
    "skipped",
    null,
    packageJsonError || "未配置 test 脚本，跳过。",
  );
  if (scripts.test) {
    const command = packageManager.runScript("test");
    const outcome = await runTerminalCommand(
      command,
      workingDir,
      state,
      120_000,
    );
    test = buildCheck(
      outcome.success ? "passed" : "failed",
      command,
      outcome.output || (outcome.success ? "Test 成功。" : "Test 失败。"),
    );
  }

  const checks = [lint, build, test];
  const overall: VerificationResult["overall"] = checks.some(
    (item) => item.status === "failed",
  )
    ? "failed"
    : checks.some((item) => item.status === "passed")
      ? "passed"
      : "skipped";
  const verificationResult: VerificationResult = {
    packageManager: packageManager.name,
    profile: verificationProfile,
    lint,
    build,
    test,
    overall,
    summary:
      overall === "failed"
        ? "工程验证存在失败项，必须由最终 Reviewer 决定返工或终止。"
        : overall === "passed"
          ? "已执行的工程验证全部通过。"
          : "项目未提供可执行的验证项，本轮验证已跳过。",
  };

  if (overall === "failed") {
    tracker.transition("FAILED", verificationResult.summary);
  } else {
    tracker.transition("COMPLETED", verificationResult.summary);
  }

  return {
    verificationResult,
    lintSummary: formatVerification(verificationResult),
    ...buildLifecycleStateUpdate(tracker),
  };
}
