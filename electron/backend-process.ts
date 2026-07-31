/**
 * 模块职责：启动、探活和关闭本地 FastAPI 子进程。
 * 说明：开发环境运行 Python 源码；生产环境运行 PyInstaller 生成的可执行文件。
 */
import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findAvailableServerPort, SERVER_HOST } from "./server-port";

export interface BackendRuntime {
  process: ChildProcess;
  port: number;
  baseUrl: string;
}

export interface BackendStartupProgress {
  title: string;
  detail: string;
  progress: number;
}

export type BackendProgressListener = (
  progress: BackendStartupProgress,
) => void;

let activeRuntime: BackendRuntime | null = null;

/**
 * 安全发送启动进度，避免加载页自身异常影响 FastAPI 启动。
 */
function reportStartupProgress(
  listener: BackendProgressListener | undefined,
  progress: BackendStartupProgress,
): void {
  try {
    listener?.(progress);
  } catch (error) {
    console.warn("[Electron] 更新启动进度失败", error);
  }
}

/**
 * 判断当前 Electron 是否处于开发模式。
 */
export function isDevelopmentMode(): boolean {
  return !app.isPackaged;
}

/**
 * 返回第一个真实存在的文件路径。
 */
function firstExistingPath(candidates: string[]): string | null {
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/**
 * 解析开发环境使用的 Python 解释器。
 *
 * 优先级：显式环境变量 -> 项目虚拟环境 -> 系统 python/python3。
 */
function resolveDevelopmentPython(): string {
  const root = process.cwd();
  const configured = process.env.PYTHON_EXECUTABLE?.trim();
  if (configured) return configured;

  const virtualPython = firstExistingPath([
    path.join(root, ".venv", "Scripts", "python.exe"),
    path.join(root, ".venv", "bin", "python"),
    path.join(root, "venv", "Scripts", "python.exe"),
    path.join(root, "venv", "bin", "python"),
  ]);
  if (virtualPython) return virtualPython;
  return process.platform === "win32" ? "python" : "python3";
}

/**
 * 解析生产包内的 Python 后端可执行文件。
 */
function resolvePackagedBackend(): string {
  const executableName =
    process.platform === "win32"
      ? "multi-agent-backend.exe"
      : "multi-agent-backend";
  const executablePath = path.join(
    process.resourcesPath,
    "backend",
    executableName,
  );
  if (!fs.existsSync(executablePath)) {
    throw new Error(`未找到打包后的 Python 后端：${executablePath}`);
  }
  return executablePath;
}

/**
 * 生成 FastAPI 子进程的环境变量。
 */
function buildBackendEnvironment(port: number): NodeJS.ProcessEnv {
  const development = isDevelopmentMode();
  const envFile = development
    ? path.join(process.cwd(), ".env.local")
    : path.join(process.resourcesPath, "config", ".env.local");
  const frontendDirectory = development
    ? path.join(process.cwd(), "dist")
    : path.join(process.resourcesPath, "frontend");

  return {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    BACKEND_HOST: SERVER_HOST,
    BACKEND_PORT: String(port),
    AGENT_DATA_DIR: path.join(app.getPath("userData"), "python-data"),
    FRONTEND_DIR: frontendDirectory,
    ...(fs.existsSync(envFile) ? { APP_ENV_FILE: envFile } : {}),
  };
}

/**
 * 创建后端子进程，并返回可复用的运行时信息。
 */
function spawnBackend(port: number): BackendRuntime {
  const development = isDevelopmentMode();
  const command = development
    ? resolveDevelopmentPython()
    : resolvePackagedBackend();
  const args = development
    ? ["-m", "backend.main", "--host", SERVER_HOST, "--port", String(port)]
    : ["--host", SERVER_HOST, "--port", String(port)];

  const child = spawn(command, args, {
    cwd: development ? process.cwd() : process.resourcesPath,
    env: buildBackendEnvironment(port),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    console.log(`[FastAPI] ${chunk.toString().trimEnd()}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    console.error(`[FastAPI] ${chunk.toString().trimEnd()}`);
  });

  return {
    process: child,
    port,
    baseUrl: `http://${SERVER_HOST}:${port}`,
  };
}

/**
 * 轮询健康检查，直到 FastAPI 真正可接受请求。
 */
async function waitUntilHealthy(
  runtime: BackendRuntime,
  listener?: BackendProgressListener,
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + 45_000;
  let lastError = "后端尚未响应";
  let lastProgressUpdate = 0;

  while (Date.now() < deadline) {
    if (runtime.process.exitCode !== null) {
      throw new Error(`Python 后端提前退出，退出码：${runtime.process.exitCode}`);
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1_500);
      const response = await fetch(`${runtime.baseUrl}/api/health`, {
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
      if (response.ok) {
        reportStartupProgress(listener, {
          title: "本地智能服务已就绪",
          detail: "正在打开工作台界面…",
          progress: 0.94,
        });
        return;
      }
      lastError = `健康检查返回 HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    const now = Date.now();
    if (now - lastProgressUpdate >= 800) {
      const elapsed = now - startedAt;
      reportStartupProgress(listener, {
        title: "正在初始化 FastAPI",
        detail: `正在等待 Agent、数据库和本地接口就绪（${Math.max(1, Math.ceil(elapsed / 1000))} 秒）`,
        progress: Math.min(0.9, 0.42 + elapsed / 90_000),
      });
      lastProgressUpdate = now;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待 Python 后端启动超时：${lastError}`);
}

/**
 * 启动本地 FastAPI；重复调用时直接返回现有实例。
 */
export async function startBackend(
  listener?: BackendProgressListener,
): Promise<BackendRuntime> {
  if (activeRuntime && activeRuntime.process.exitCode === null) {
    reportStartupProgress(listener, {
      title: "本地智能服务正在运行",
      detail: "正在恢复工作台窗口…",
      progress: 0.94,
    });
    return activeRuntime;
  }

  reportStartupProgress(listener, {
    title: "正在准备本地服务",
    detail: "正在检查可用端口和 Python 运行环境…",
    progress: 0.18,
  });
  const port = await findAvailableServerPort();
  reportStartupProgress(listener, {
    title: "正在启动 Python 服务",
    detail: `FastAPI 将在本机端口 ${port} 上运行`,
    progress: 0.34,
  });
  const runtime = spawnBackend(port);
  activeRuntime = runtime;
  runtime.process.once("exit", () => {
    if (activeRuntime?.process === runtime.process) activeRuntime = null;
  });
  await waitUntilHealthy(runtime, listener);
  return runtime;
}

/**
 * 关闭 FastAPI 子进程，避免退出 Electron 后残留后台进程。
 */
export function stopBackend(): void {
  const runtime = activeRuntime;
  activeRuntime = null;
  if (!runtime || runtime.process.exitCode !== null) return;

  runtime.process.kill("SIGTERM");
  const forceTimer = setTimeout(() => {
    if (runtime.process.exitCode === null) runtime.process.kill("SIGKILL");
  }, 3_000);
  forceTimer.unref();
}
