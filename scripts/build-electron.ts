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
 * 探测解释器是否具备打包所需的全部依赖（含 langgraph 与 PyInstaller）。
 */
function pythonCanBuild(python: string): boolean {
  try {
    execFileSync(
      python,
      ["-c", "import fastapi, uvicorn, pydantic, langgraph, PyInstaller"],
      { cwd: rootDirectory, stdio: "pipe", env: process.env },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 查找可用于构建后端、且已安装完整依赖的 Python 解释器。
 *
 * 不再盲目信任 .venv 或 PATH：坏掉的虚拟环境（例如 pyvenv.cfg 路径含中文导致
 * 启动器无法解析）会被探测跳过，避免用它覆盖出缺少 langgraph 的残缺后端包。
 */
function resolvePythonExecutable(): string {
  const configured = process.env.PYTHON_EXECUTABLE?.trim() ?? "";
  if (configured && pythonCanBuild(configured)) return configured;
  const candidates = [
    path.join(rootDirectory, ".venv", "Scripts", "python.exe"),
    path.join(rootDirectory, ".venv", "bin", "python"),
    process.platform === "win32" ? "python" : "python3",
  ];
  for (const candidate of candidates) {
    if (!candidate.includes(path.sep) || fs.existsSync(candidate)) {
      if (pythonCanBuild(candidate)) return candidate;
    }
  }
  throw new Error(
    "未找到可用于打包的 Python 解释器：需要已安装 fastapi / uvicorn / pydantic / langgraph / PyInstaller。\n" +
      "建议显式指定 PYTHON_EXECUTABLE，例如：\n" +
      "set PYTHON_EXECUTABLE=C:\\Users\\小艳艳的电脑\\AppData\\Local\\Programs\\Python\\Python314\\python.exe",
  );
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
  const backendDirectory = path.join(
    rootDirectory,
    "python-dist",
    "multi-agent-backend",
  );
  const backendExecutable = path.join(
    backendDirectory,
    process.platform === "win32"
      ? "multi-agent-backend.exe"
      : "multi-agent-backend",
  );
  required.push(backendExecutable, path.join(backendDirectory, "_internal"));
  const missing = required.filter((file) => !fs.existsSync(file));
  if (missing.length) throw new Error(`构建产物缺失：\n${missing.join("\n")}`);
}

/**
 * 按顺序构建三层运行时。
 */
function main(): void {
  console.log("=== 1/4 同步单一模型配置 ===");
  runCommand("pnpm models:sync");
  console.log("=== 2/4 编译 Electron 主进程 ===");
  runCommand("pnpm electron:compile");
  console.log("=== 3/4 构建 Vite React 前端 ===");
  runCommand("pnpm build");
  console.log("=== 4/4 构建 PyInstaller FastAPI 后端 ===");
  buildPythonBackend();
  assertBuildOutputs();
  console.log("Electron 打包资源准备完成。 ");
}

main();
