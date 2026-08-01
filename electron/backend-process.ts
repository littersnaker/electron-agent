/**
 * 模块职责：连接开发 FastAPI，或在生产环境启动打包后的 Python 子进程。
 *
 * 标准 `pnpm dev` 会单独启动 Uvicorn reload，并通过 BACKEND_DEV_URL 连接。
 * 这样 Electron 主进程热重启时不会把 Python watcher 一起杀掉。
 */
import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getStableDataPath } from "./data-paths";
import { findAvailableServerPort, SERVER_HOST } from "./server-port";

export interface BackendRuntime {
  process: ChildProcess | null;
  port: number;
  baseUrl: string;
  ownedByElectron: boolean;
}

export interface BackendStartupProgress {
  title: string;
  detail: string;
  progress: number;
}

export type BackendProgressListener = (
  progress: BackendStartupProgress,
) => void;

interface HealthPayload {
  ok?: boolean;
  runtime?: string;
  reloadEnabled?: boolean;
  processId?: number;
  sourceRoot?: string;
  sourceModifiedAt?: string;
}

class DevelopmentBackendMismatchError extends Error {
  /** 标记开发端口连接到了另一个项目或打包后端。 */
  constructor(message: string) {
    super(message);
    this.name = "DevelopmentBackendMismatchError";
  }
}

let activeRuntime: BackendRuntime | null = null;

/** 安全发送启动进度，避免加载页自身异常影响 FastAPI 启动。 */
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

/** 判断当前 Electron 是否处于开发模式。 */
export function isDevelopmentMode(): boolean {
  return !app.isPackaged;
}

/** 返回第一个真实存在的文件路径。 */
function firstExistingPath(candidates: string[]): string | null {
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** 解析开发环境使用的 Python 解释器。 */
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

/** 解析生产包内的 Python 后端可执行文件。 */
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

/** 生成 Electron 自己启动 Python 时使用的环境变量。 */
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
    PYTHONDONTWRITEBYTECODE: development ? "1" : process.env.PYTHONDONTWRITEBYTECODE,
    BACKEND_RELOAD: development ? "1" : "0",
    BACKEND_HOST: SERVER_HOST,
    BACKEND_PORT: String(port),
    AGENT_DATA_DIR: getStableDataPath("python-data"),
    FRONTEND_DIR: frontendDirectory,
    ...(fs.existsSync(envFile) ? { APP_ENV_FILE: envFile } : {}),
  };
}

/** 创建 Electron 自己管理的后端子进程。 */
function spawnBackend(port: number): BackendRuntime {
  const development = isDevelopmentMode();
  const command = development
    ? resolveDevelopmentPython()
    : resolvePackagedBackend();
  const args = development
    ? [
        "-m",
        "backend.main",
        "--host",
        SERVER_HOST,
        "--port",
        String(port),
        "--reload",
        "--reload-dir",
        "backend",
      ]
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
    ownedByElectron: true,
  };
}

/** 读取标准开发命令提供的外部 Uvicorn 地址。 */
function resolveExternalDevelopmentRuntime(): BackendRuntime | null {
  if (!isDevelopmentMode()) return null;
  const configured = process.env.BACKEND_DEV_URL?.trim();
  if (!configured) return null;

  const url = new URL(configured);
  const allowedHosts = new Set(["127.0.0.1", "localhost"]);
  if (url.protocol !== "http:" || !allowedHosts.has(url.hostname)) {
    throw new Error("BACKEND_DEV_URL 只允许本机 http://127.0.0.1 地址");
  }
  const port = Number(url.port || "80");
  return {
    process: null,
    port,
    baseUrl: configured.replace(/\/+$/u, ""),
    ownedByElectron: false,
  };
}

/** 统一路径大小写，供 Windows 上比较当前项目与健康接口源码目录。 */
function normalizeFileSystemPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 严格开发模式下拒绝连接另一个目录或安装包中的旧后端。 */
function validateDevelopmentBackend(payload: HealthPayload): void {
  if (!isDevelopmentMode() || process.env.ELECTRON_DEV_STRICT !== "1") return;
  const sourceRoot = payload.sourceRoot?.trim();
  if (!sourceRoot) {
    throw new DevelopmentBackendMismatchError(
      "开发后端没有返回 sourceRoot，可能仍在运行修改前的旧版本",
    );
  }
  const expected = normalizeFileSystemPath(process.cwd());
  const actual = normalizeFileSystemPath(sourceRoot);
  if (expected !== actual || payload.runtime !== "source") {
    throw new DevelopmentBackendMismatchError(
      `开发后端源码目录不匹配。当前项目：${expected}；实际连接：${actual}`,
    );
  }
}

/** 轮询健康检查，直到 FastAPI 真正可接受请求。 */
async function waitUntilHealthy(
  runtime: BackendRuntime,
  listener?: BackendProgressListener,
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + 45_000;
  let lastError = "后端尚未响应";
  let lastProgressUpdate = 0;

  while (Date.now() < deadline) {
    if (runtime.process && runtime.process.exitCode !== null) {
      throw new Error(`Python 后端提前退出，退出码：${runtime.process.exitCode}`);
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1_500);
      const response = await fetch(`${runtime.baseUrl}/api/health`, {
        signal: controller.signal,
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      }).finally(() => clearTimeout(timeout));
      if (response.ok) {
        const payload = (await response.json()) as HealthPayload;
        validateDevelopmentBackend(payload);
        console.info(
          `[Electron] FastAPI 源码：${payload.sourceRoot || "打包版本"}，` +
            `PID=${payload.processId || "unknown"}，` +
            `modified=${payload.sourceModifiedAt || "unknown"}`,
        );
        reportStartupProgress(listener, {
          title: "本地智能服务已就绪",
          detail: "正在打开最新 Vite 工作台…",
          progress: 0.94,
        });
        return;
      }
      lastError = `健康检查返回 HTTP ${response.status}`;
    } catch (error) {
      if (error instanceof DevelopmentBackendMismatchError) throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }

    const now = Date.now();
    if (now - lastProgressUpdate >= 800) {
      const elapsed = now - startedAt;
      reportStartupProgress(listener, {
        title: "正在初始化 FastAPI",
        detail: `正在等待最新 Python 源码就绪（${Math.max(1, Math.ceil(elapsed / 1000))} 秒）`,
        progress: Math.min(0.9, 0.42 + elapsed / 90_000),
      });
      lastProgressUpdate = now;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待 Python 后端启动超时：${lastError}`);
}

/** 启动或连接 FastAPI；标准开发模式优先连接独立的 reload 服务。 */
export async function startBackend(
  listener?: BackendProgressListener,
): Promise<BackendRuntime> {
  if (
    activeRuntime &&
    (!activeRuntime.process || activeRuntime.process.exitCode === null)
  ) {
    return activeRuntime;
  }

  const externalRuntime = resolveExternalDevelopmentRuntime();
  if (externalRuntime) {
    reportStartupProgress(listener, {
      title: "正在连接热更新后端",
      detail: `检查 ${externalRuntime.baseUrl} 是否来自当前源码目录…`,
      progress: 0.38,
    });
    await waitUntilHealthy(externalRuntime, listener);
    activeRuntime = externalRuntime;
    return externalRuntime;
  }

  reportStartupProgress(listener, {
    title: "正在准备本地服务",
    detail: "正在检查可用端口和 Python 运行环境…",
    progress: 0.18,
  });
  const port = await findAvailableServerPort();
  const runtime = spawnBackend(port);
  activeRuntime = runtime;
  runtime.process?.once("exit", () => {
    if (activeRuntime?.process === runtime.process) activeRuntime = null;
  });
  await waitUntilHealthy(runtime, listener);
  return runtime;
}

/** 只关闭 Electron 自己创建的后端；外部 dev watcher 交给 concurrently 管理。 */
export function stopBackend(): void {
  const runtime = activeRuntime;
  activeRuntime = null;
  if (
    !runtime?.ownedByElectron ||
    !runtime.process ||
    runtime.process.exitCode !== null
  ) {
    return;
  }

  runtime.process.kill("SIGTERM");
  const forceTimer = setTimeout(() => {
    if (runtime.process?.exitCode === null) runtime.process.kill("SIGKILL");
  }, 3_000);
  forceTimer.unref();
}
