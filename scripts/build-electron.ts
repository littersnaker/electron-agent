/**
 * 模块职责：准备 Electron 生产安装包所需的 React、Electron 和 Python 三类产物。
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const rootDirectory = process.cwd();

/**
 * 在项目根目录执行 shell 命令，并实时显示输出。
 */
function runCommand(command: string): void {
  execSync(command, { cwd: rootDirectory, stdio: "inherit", env: process.env });
}

/**
 * 查找构建后端时使用的 Python 解释器。
 */
function resolvePythonExecutable(): string {
  const configured = process.env.PYTHON_EXECUTABLE?.trim();
  if (configured) return configured;
  const candidates = [
    path.join(rootDirectory, ".venv", "Scripts", "python.exe"),
    path.join(rootDirectory, ".venv", "bin", "python"),
    process.platform === "win32" ? "python" : "python3",
  ];
  return candidates.find((candidate) =>
    candidate.includes(path.sep) ? fs.existsSync(candidate) : true,
  )!;
}

/**
 * 执行 Python 后端打包脚本。
 */
function buildPythonBackend(): void {
  execFileSync(resolvePythonExecutable(), ["scripts/build-python-backend.py"], {
    cwd: rootDirectory,
    stdio: "inherit",
    env: process.env,
  });
}

/**
 * 检查生产打包依赖的关键文件。
 */
function assertBuildOutputs(): void {
  const required = [
    path.join(rootDirectory, "dist", "index.html"),
    path.join(rootDirectory, ".electron", "main.js"),
    path.join(rootDirectory, ".electron", "preload.js"),
  ];
  const backendFiles = fs.existsSync(path.join(rootDirectory, "python-dist"))
    ? fs.readdirSync(path.join(rootDirectory, "python-dist"))
    : [];
  if (!backendFiles.some((name) => name.startsWith("multi-agent-backend"))) {
    required.push(path.join(rootDirectory, "python-dist", "multi-agent-backend"));
  }
  const missing = required.filter((file) => !fs.existsSync(file));
  if (missing.length) throw new Error(`构建产物缺失：\n${missing.join("\n")}`);
}

/**
 * 按顺序构建三层运行时。
 */
function main(): void {
  console.log("=== 1/3 编译 Electron 主进程 ===");
  runCommand("pnpm electron:compile");
  console.log("=== 2/3 构建 Vite React 前端 ===");
  runCommand("pnpm build");
  console.log("=== 3/3 构建 PyInstaller FastAPI 后端 ===");
  buildPythonBackend();
  assertBuildOutputs();
  console.log("Electron 打包资源准备完成。 ");
}

main();
