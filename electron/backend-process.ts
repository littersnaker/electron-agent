/**
 * 模块职责：连接开发 FastAPI，或在生产环境启动打包后的 Python 子进程。
 *
 * 生产后端使用 PyInstaller onedir，避免 onefile 每次启动都先解压到临时目录。
 * 启动阶段会把 Python 输出同时写入稳定日志文件，失败时直接展示真实响应和日志尾部。
 */
import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getStableDataPath } from "./data-paths";
import { findAvailableServerPort, SERVER_HOST } from "./server-port";

export interface BackendRuntime {
  process: ChildProcess | null;
  port: number;
  baseUrl: string;
  ownedByElectron: boolean;
  startupLogPath?: string;
  recentOutput?: string[];
  spawnError?: string;
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
  sourceModifiedAt?: string | null;
}

class DevelopmentBackendMismatchError extends Error {
  /** 标记开发端口连接到了另一个项目或打包后端。 */
  constructor(message: string) {
    super(message);
    this.name = "DevelopmentBackendMismatchError";
  }
}

const MAX_RECENT_OUTPUT_LINES = 80;
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

/** 解析生产包内的 onedir Python 后端，并兼容旧 onefile 布局。 */
function resolvePackagedBackend(): string {
  const executableName =
    process.platform === "win32"
      ? "multi-agent-backend.exe"
      : "multi-agent-backend";
  const candidates = [
    path.join(process.resourcesPath, "backend", executableName),
    path.join(
      process.resourcesPath,
      "backend",
      "multi-agent-backend",
      executableName,
    ),
  ];
  const executablePath = firstExistingPath(candidates);
  if (!executablePath) {
    throw new Error(
      `未找到打包后的 Python 后端。已检查：\n${candidates.join("\n")}`,
    );
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
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: development
      ? "1"
      : process.env.PYTHONDONTWRITEBYTECODE,
    BACKEND_RELOAD: development ? "1" : "0",
    BACKEND_HOST: SERVER_HOST,
    BACKEND_PORT: String(port),
    AGENT_DATA_DIR: getStableDataPath("python-data"),
    FRONTEND_DIR: frontendDirectory,
    // run_code 批量执行通道：把随安装包分发的独立 Python 运行时注入后端，
    // 开发模式用系统 Python（后端 sys.executable 兜底），这里只在打包时指定。
    ...(development
      ? {}
      : {
          CODE_AGENT_PYTHON: path.join(
            process.resourcesPath,
            "python-runtime",
            "python.exe",
          ),
        }),
    ...(fs.existsSync(envFile) ? { APP_ENV_FILE: envFile } : {}),
  };
}

/** 创建启动日志文件；失败时返回 undefined，不阻断应用。 */
function createStartupLog(): {
  path: string;
  stream: fs.WriteStream;
} | undefined {
  try {
    const logDirectory = getStableDataPath("logs");
    fs.mkdirSync(logDirectory, { recursive: true });
    const logPath = path.join(logDirectory, "backend-startup.log");
    return {
      path: logPath,
      stream: fs.createWriteStream(logPath, { flags: "w", encoding: "utf8" }),
    };
  } catch (error) {
    console.warn("[Electron] 无法创建 Python 启动日志", error);
    return undefined;
  }
}

/** 记录一段 Python 输出，并保留有限行数供错误提示使用。 */
function recordBackendOutput(
  runtime: BackendRuntime,
  text: string,
  logStream?: fs.WriteStream,
): void {
  if (!text) return;
  logStream?.write(text);
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const recent = runtime.recentOutput ?? [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed) recent.push(trimmed);
  }
  if (recent.length > MAX_RECENT_OUTPUT_LINES) {
    recent.splice(0, recent.length - MAX_RECENT_OUTPUT_LINES);
  }
  runtime.recentOutput = recent;
}

/** 将子进程字节流按 UTF-8 解码，避免中文字符被拆包后乱码。 */
function bindBackendStream(
  runtime: BackendRuntime,
  stream: NodeJS.ReadableStream | null,
  label: "stdout" | "stderr",
  logStream?: fs.WriteStream,
): void {
  if (!stream) return;
  const decoder = new StringDecoder("utf8");
  stream.on("data", (chunk: Buffer) => {
    const text = decoder.write(chunk);
    recordBackendOutput(runtime, `[${label}] ${text}`, logStream);
    const printer = label === "stderr" ? console.error : console.log;
    printer(`[FastAPI] ${text.trimEnd()}`);
  });
  stream.on("end", () => {
    const tail = decoder.end();
    if (tail) recordBackendOutput(runtime, `[${label}] ${tail}`, logStream);
  });
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
  const startupLog = createStartupLog();
  const child = spawn(command, args, {
    cwd: development ? process.cwd() : path.dirname(command),
    env: buildBackendEnvironment(port),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const runtime: BackendRuntime = {
    process: child,
    port,
    baseUrl: `http://${SERVER_HOST}:${port}`,
    ownedByElectron: true,
    startupLogPath: startupLog?.path,
    recentOutput: [],
  };

  bindBackendStream(runtime, child.stdout, "stdout", startupLog?.stream);
  bindBackendStream(runtime, child.stderr, "stderr", startupLog?.stream);
  child.once("error", (error) => {
    runtime.spawnError = error.message;
    recordBackendOutput(
      runtime,
      `[spawn-error] ${error.stack ?? error.message}\n`,
      startupLog?.stream,
    );
  });
  child.once("exit", (code, signal) => {
    recordBackendOutput(
      runtime,
      `[exit] code=${String(code)} signal=${String(signal)}\n`,
      startupLog?.stream,
    );
    startupLog?.stream.end();
  });
  return runtime;
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
  return {
    process: null,
    port: Number(url.port || "80"),
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

/** 在限定时间内获取接口响应。 */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** 限制错误响应长度，避免系统对话框被整页 HTML 撑满。 */
async function responsePreview(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/gu, " ").trim().slice(0, 800);
  } catch {
    return "无法读取响应正文";
  }
}

/** 把最近 Python 输出和日志路径附加到启动异常。 */
function backendFailure(runtime: BackendRuntime, summary: string): Error {
  const recent = runtime.recentOutput?.slice(-24).join("\n").trim();
  const sections = [summary];
  if (runtime.spawnError) sections.push(`进程启动错误：${runtime.spawnError}`);
  if (runtime.startupLogPath) {
    sections.push(`完整启动日志：${runtime.startupLogPath}`);
  }
  if (recent) sections.push(`最近的 Python 输出：\n${recent}`);
  const error = new Error(sections.join("\n\n"));
  error.name = "BackendStartupError";
  return error;
}

/** 获取详细健康信息；生产环境中诊断失败只记录，不阻断启动。 */
async function readHealthDiagnostics(runtime: BackendRuntime): Promise<void> {
  try {
    const response = await fetchWithTimeout(
      `${runtime.baseUrl}/api/health`,
      2_500,
    );
    if (!response.ok) {
      console.warn(
        `[Electron] 详细健康检查返回 HTTP ${response.status}：` +
          (await responsePreview(response)),
      );
      return;
    }
    const payload = (await response.json()) as HealthPayload;
    validateDevelopmentBackend(payload);
    console.info(
      `[Electron] FastAPI 源码：${payload.sourceRoot || "打包版本"}，` +
        `PID=${payload.processId || "unknown"}，` +
        `modified=${payload.sourceModifiedAt || "unknown"}`,
    );
  } catch (error) {
    if (error instanceof DevelopmentBackendMismatchError) throw error;
    console.warn("[Electron] 无法读取 FastAPI 详细诊断，已继续启动", error);
  }
}

/** 轮询轻量存活接口，直到 FastAPI 真正可接受请求。 */
async function waitUntilHealthy(
  runtime: BackendRuntime,
  listener?: BackendProgressListener,
): Promise<void> {
  const startedAt = Date.now();
  const production = !isDevelopmentMode();
  const deadline = startedAt + (production ? 120_000 : 45_000);
  let lastError = "后端尚未响应";
  let lastProgressUpdate = 0;

  while (Date.now() < deadline) {
    if (runtime.spawnError) {
      throw backendFailure(runtime, "Python 后端进程无法创建");
    }
    if (runtime.process && runtime.process.exitCode !== null) {
      throw backendFailure(
        runtime,
        `Python 后端提前退出，退出码：${runtime.process.exitCode}`,
      );
    }

    try {
      const response = await fetchWithTimeout(
        `${runtime.baseUrl}/api/health/live`,
        production ? 3_000 : 1_500,
      );
      if (response.ok) {
        await readHealthDiagnostics(runtime);
        reportStartupProgress(listener, {
          title: "本地智能服务已就绪",
          detail: production ? "正在打开工作台…" : "正在打开最新 Vite 工作台…",
          progress: 0.94,
        });
        return;
      }
      const body = await responsePreview(response);
      lastError = `存活检查返回 HTTP ${response.status}：${body}`;
      if (response.status >= 500) {
        throw backendFailure(runtime, lastError);
      }
    } catch (error) {
      if (
        error instanceof DevelopmentBackendMismatchError ||
        (error instanceof Error && error.name === "BackendStartupError")
      ) {
        throw error;
      }
      lastError = error instanceof Error ? error.message : String(error);
    }

    const now = Date.now();
    if (now - lastProgressUpdate >= 800) {
      const elapsedSeconds = Math.max(1, Math.ceil((now - startedAt) / 1000));
      reportStartupProgress(listener, {
        title: "正在初始化 FastAPI",
        detail:
          production && elapsedSeconds >= 8
            ? `首次启动可能正在接受安全软件扫描（${elapsedSeconds} 秒）`
            : `正在等待 Python 后端就绪（${elapsedSeconds} 秒）`,
        progress: Math.min(0.9, 0.42 + (now - startedAt) / 180_000),
      });
      lastProgressUpdate = now;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw backendFailure(runtime, `等待 Python 后端启动超时：${lastError}`);
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
