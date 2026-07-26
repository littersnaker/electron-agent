import {
  app,
  BrowserWindow,
  Menu,
  shell,
  ipcMain,
  dialog,
  nativeTheme,
  type WebContents,
} from "electron";
import path from "path";
import fs from "fs";
import http from "http";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as dotenv from "dotenv";
import { findAvailableServerPort, SERVER_HOST } from "./server-port";
type AppTheme = "dark" | "light";

const WINDOW_THEME = {
  dark: { backgroundColor: "#09090b" },
  light: { backgroundColor: "#eef1f6" },
} satisfies Record<AppTheme, { backgroundColor: string }>;

const STARTUP_PAGE_THEME = {
  dark: {
    pageBackground:
      "radial-gradient(circle at 72% 14%, rgba(10,132,255,0.12), transparent 30%), radial-gradient(circle at 30% 92%, rgba(191,90,242,0.08), transparent 34%), #09090b",
    text: "#f5f5f7",
    secondaryText: "rgba(235,235,245,0.62)",
    tertiaryText: "rgba(235,235,245,0.38)",
    spinnerTrack: "rgba(100,181,255,0.16)",
    spinnerHead: "#64b5ff",
    iconShadow:
      "0 18px 54px rgba(10,132,255,0.22), 0 6px 20px rgba(0,0,0,0.30)",
    errorLogBackground: "rgba(0,0,0,0.28)",
    errorLogBorder: "rgba(255,255,255,0.09)",
  },
  light: {
    pageBackground:
      "radial-gradient(circle at 72% 14%, rgba(10,132,255,0.10), transparent 31%), radial-gradient(circle at 30% 92%, rgba(191,90,242,0.07), transparent 35%), #eef1f6",
    text: "#1d1d1f",
    secondaryText: "rgba(29,29,31,0.62)",
    tertiaryText: "rgba(29,29,31,0.40)",
    spinnerTrack: "rgba(10,132,255,0.14)",
    spinnerHead: "#0a84ff",
    iconShadow:
      "0 18px 48px rgba(10,132,255,0.16), 0 6px 20px rgba(35,48,72,0.10)",
    errorLogBackground: "rgba(255,255,255,0.60)",
    errorLogBorder: "rgba(29,29,31,0.10)",
  },
} satisfies Record<
  AppTheme,
  {
    pageBackground: string;
    text: string;
    secondaryText: string;
    tertiaryText: string;
    spinnerTrack: string;
    spinnerHead: string;
    iconShadow: string;
    errorLogBackground: string;
    errorLogBorder: string;
  }
>;

const WINDOW_THEME_FILE = "window-theme-light-default-v2.json";
let currentTheme: AppTheme = "light";

function isAppTheme(value: unknown): value is AppTheme {
  return value === "dark" || value === "light";
}

function readPersistedWindowTheme(): AppTheme {
  try {
    const themePath = path.join(app.getPath("userData"), WINDOW_THEME_FILE);
    if (!fs.existsSync(themePath)) return "light";

    const parsed = JSON.parse(fs.readFileSync(themePath, "utf8")) as {
      theme?: unknown;
    };
    return isAppTheme(parsed.theme) ? parsed.theme : "light";
  } catch (error) {
    console.warn("[Electron] 读取窗口主题失败，将使用浅色模式:", error);
    return "light";
  }
}

function persistWindowTheme(theme: AppTheme): void {
  try {
    const themePath = path.join(app.getPath("userData"), WINDOW_THEME_FILE);
    fs.writeFileSync(themePath, JSON.stringify({ theme }), "utf8");
  } catch (error) {
    console.warn("[Electron] 保存窗口主题失败:", error);
  }
}

function applyThemeToWindow(win: BrowserWindow, theme: AppTheme): void {
  win.setBackgroundColor(WINDOW_THEME[theme].backgroundColor);
}

function applyNativeWindowTheme(theme: AppTheme): void {
  currentTheme = theme;
  nativeTheme.themeSource = theme;
  persistWindowTheme(theme);

  if (mainWindow && !mainWindow.isDestroyed()) {
    applyThemeToWindow(mainWindow, theme);
  }
}

/**
 * 注册自定义窗口按钮 IPC。
 *
 * 原生 titleBarOverlay 位于 Chromium 渲染层上方，网页弹窗无法通过 z-index 覆盖。
 * 因此主窗口使用 frame:false，并由 React / 启动页自行绘制最小化、最大化和关闭按钮。
 */
function registerWindowControlIpc(): void {
  const resolveWindow = (sender: WebContents) =>
    BrowserWindow.fromWebContents(sender);

  ipcMain.on("window:minimize", (event) => {
    resolveWindow(event.sender)?.minimize();
  });

  ipcMain.on("window:close", (event) => {
    resolveWindow(event.sender)?.close();
  });

  ipcMain.handle("window:isMaximized", (event) => {
    return resolveWindow(event.sender)?.isMaximized() ?? false;
  });

  ipcMain.handle("window:toggleMaximize", (event) => {
    const targetWindow = resolveWindow(event.sender);
    if (!targetWindow) return false;

    if (targetWindow.isMaximized()) targetWindow.unmaximize();
    else targetWindow.maximize();

    return targetWindow.isMaximized();
  });
}

function buildInlineWindowControlsStyles(theme: AppTheme): string {
  const isDark = theme === "dark";
  const titlebarBackground = isDark
    ? "rgba(15,15,18,0.78)"
    : "rgba(246,247,250,0.76)";
  const controlBackground = isDark
    ? "rgba(38,38,42,0.72)"
    : "rgba(255,255,255,0.72)";
  const borderColor = isDark
    ? "rgba(255,255,255,0.09)"
    : "rgba(15,23,42,0.09)";
  const iconColor = isDark ? "rgba(245,245,247,0.72)" : "rgba(29,29,31,0.68)";

  return `
  .window-titlebar {
    position: fixed;
    z-index: 100;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    height: 44px;
    align-items: center;
    justify-content: flex-end;
    padding: 0 12px;
    border-bottom: 1px solid ${borderColor};
    background: ${titlebarBackground};
    backdrop-filter: blur(30px) saturate(150%);
    -webkit-backdrop-filter: blur(30px) saturate(150%);
    -webkit-app-region: drag;
  }

  .window-controls {
    display: flex;
    height: 32px;
    overflow: hidden;
    border: 1px solid ${borderColor};
    border-radius: 11px;
    background: ${controlBackground};
    color: ${iconColor};
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.25), 0 5px 14px rgba(15,23,42,0.06);
    -webkit-app-region: no-drag;
  }

  .window-control {
    display: flex;
    width: 40px;
    height: 30px;
    align-items: center;
    justify-content: center;
    border: 0;
    border-left: 1px solid ${borderColor};
    background: transparent;
    color: inherit;
    cursor: default;
    transition: background 140ms ease, color 140ms ease;
  }

  .window-control:first-child {
    border-left: 0;
  }

  .window-control:hover {
    background: rgba(127,127,127,0.12);
  }

  .window-control.close:hover {
    background: #ff5f57;
    color: white;
  }

  .window-control svg {
    width: 14px;
    height: 14px;
  }
  `;
}

function buildInlineWindowControlsHtml(): string {
  return `
  <div class="window-titlebar">
    <div class="window-controls" aria-label="窗口控制">
      <button class="window-control" aria-label="最小化窗口" onclick="window.electronAPI?.windowControls?.minimize()">
        <svg viewBox="0 0 16 16" fill="none"><path d="M3.5 8h9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>
      </button>
      <button class="window-control" aria-label="最大化或还原窗口" onclick="window.electronAPI?.windowControls?.toggleMaximize()">
        <svg viewBox="0 0 16 16" fill="none"><rect x="3.25" y="3.25" width="9.5" height="9.5" rx="1.2" stroke="currentColor" stroke-width="1.15"/></svg>
      </button>
      <button class="window-control close" aria-label="关闭窗口" onclick="window.electronAPI?.windowControls?.close()">
        <svg viewBox="0 0 16 16" fill="none"><path d="m4.5 4.5 7 7m0-7-7 7" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>
      </button>
    </div>
  </div>`;
}

function maskSecret(secret?: string): string {
  if (!secret) return "missing";
  if (secret.length <= 8)
    return `${"*".repeat(secret.length)} (len:${secret.length})`;
  return `${secret.slice(0, 4)}...${secret.slice(-4)} (len:${secret.length})`;
}

/*
 * Electron 主进程不会像 Next.js 那样自动帮我们加载 `.env.local`。
 * 这里手动尝试多个候选路径：
 * - 开发态通常是项目根目录；
 * - 打包后如果外部放置了 `.env.local`，则可能在 resources 或启动目录附近。
 *
 * 这样做的目的，是把“主进程能否读到 Key”这件事做成显式行为，避免后面子进程注入时悄悄丢失。
 */
function loadElectronEnv(): void {
  const candidatePaths = [
    path.join(process.cwd(), ".env.local"),
    // 打包后如果构建脚本把 .env.local 一起复制进 standalone 资源目录，
    // 主进程会优先从这里读取，再注入给 Next 子进程。
    path.join(process.resourcesPath, "standalone", ".env.local"),
    path.join(__dirname, "../.env.local"),
    path.join(__dirname, "../../.env.local"),
    path.join(process.resourcesPath, ".env.local"),
  ];

  for (const envPath of candidatePaths) {
    if (!fs.existsSync(envPath)) continue;

    const result = dotenv.config({ path: envPath, override: false });
    if (!result.error) {
      console.log(`[Electron] 已加载环境变量文件: ${envPath}`);
      console.log(
        `[Electron] DASHSCOPE_API_KEY 命中情况: ${maskSecret(process.env.DASHSCOPE_API_KEY)}`,
      );
      console.log(
        `[Electron] SERPAPI_API_KEY 命中情况: ${maskSecret(process.env.SERPAPI_API_KEY)}`,
      );
      console.log(
        `[Electron] TALORDATA_API_TOKEN 命中情况: ${maskSecret(process.env.TALORDATA_API_TOKEN)}`,
      );
      console.log(
        `[Electron] KEEPA_API_KEY 命中情况: ${maskSecret(process.env.KEEPA_API_KEY)}`,
      );
      return;
    }

    console.warn(`[Electron] 读取环境变量文件失败: ${envPath}`, result.error);
  }

  console.warn(
    "[Electron] 未找到可用的 .env.local，后续只能依赖系统环境变量。",
  );
}

loadElectronEnv();
// squirrel startup handler (Windows only)
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (require("electron-squirrel-startup")) {
    app.quit();
  }
} catch {
  // not a squirrel install, continue
}

/**
 * Electron 主进程运行时状态。
 *
 * 这些变量必须定义在模块级作用域中，因为窗口创建、Next.js 子进程启动、错误页展示、
 * 应用退出清理等多个函数都会共享它们。之前替换动态端口代码时误删了这一组声明，
 * 导致 TypeScript 报出 `isDev/serverReady/serverFailed` 等名称不存在，并在编译后的
 * JavaScript 中触发 `ReferenceError: isDev is not defined`。
 */
const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let serverReady = false;
let serverFailed = false;
let lastServerError = "";
let appIsQuitting = false;

/**
 * Next.js 内嵌服务的端口和访问地址在启动时动态确定。
 * 初始值只用于满足严格类型检查；真正加载页面前，`startServer` 一定会完成赋值。
 */
let serverPort = 0;
let serverUrl = "";

const ELECTRON_NEXT_DIST_DIR = ".next-electron";
const SERVER_PID_FILE = "embedded-next-server.json";
const SERVER_START_TIMEOUT_MS = 60_000;
const SERVER_PROBE_INTERVAL_MS = 300;

interface EmbeddedServerPidRecord {
  pid: number;
  projectPath: string;
  startedAt: number;
}

function getServerPidFilePath(): string {
  return path.join(app.getPath("userData"), SERVER_PID_FILE);
}

function removeServerPidFile(): void {
  try {
    fs.rmSync(getServerPidFilePath(), { force: true });
  } catch (error) {
    console.warn("[Electron] 清理 Next.js PID 文件失败:", error);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 结束 Next.js 的完整进程树。
 *
 * Windows 下仅调用 ChildProcess.kill() 可能只关闭外层 cmd，真正的 Node/Next 子进程
 * 仍会继续监听端口。因此这里使用 taskkill /T，确保子孙进程一起退出。
 */
function terminateProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;

  if (process.platform === "win32") {
    const result = spawnSync(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );

    if (!result.error && result.status === 0) return;
  }

  try {
    if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
    else process.kill(pid, "SIGTERM");
  } catch {
    // 进程已结束时无需继续处理。
  }
}

function stopServerProcess(): void {
  const pid = serverProcess?.pid;
  if (pid) terminateProcessTree(pid);

  serverProcess = null;
  serverReady = false;
  removeServerPidFile();
}

/** 清理本应用上一次异常退出时遗留的内嵌 Next.js 进程。 */
function cleanupKnownStaleServerProcess(): void {
  const pidFilePath = getServerPidFilePath();
  if (!fs.existsSync(pidFilePath)) return;

  try {
    const record = JSON.parse(
      fs.readFileSync(pidFilePath, "utf8"),
    ) as Partial<EmbeddedServerPidRecord>;

    const belongsToCurrentProject =
      record.projectPath === app.getAppPath() &&
      typeof record.pid === "number" &&
      Number.isInteger(record.pid);

    // 只处理本项目在最近一天内记录的进程，避免误杀被系统复用 PID 的其他程序。
    const isRecent =
      typeof record.startedAt === "number" &&
      Date.now() - record.startedAt < 24 * 60 * 60 * 1000;

    if (belongsToCurrentProject && isRecent && isProcessAlive(record.pid!)) {
      console.warn(`[Electron] 正在清理遗留的 Next.js 进程 PID=${record.pid}`);
      terminateProcessTree(record.pid!);
    }
  } catch (error) {
    console.warn("[Electron] 读取 Next.js PID 文件失败:", error);
  } finally {
    removeServerPidFile();
  }
}

function persistServerPid(pid: number): void {
  const record: EmbeddedServerPidRecord = {
    pid,
    projectPath: app.getAppPath(),
    startedAt: Date.now(),
  };

  fs.writeFileSync(getServerPidFilePath(), JSON.stringify(record), "utf8");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function probeServer(): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      {
        hostname: SERVER_HOST,
        port: serverPort,
        path: "/",
        timeout: 1_500,
      },
      (response) => {
        response.resume();
        resolve((response.statusCode ?? 500) < 500);
      },
    );

    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

/**
 * 轮询真实 HTTP 响应，而不是依赖 Next.js 日志里的 URL 文本。
 * Next 在打印 Local 地址时尚未一定完成编译，过早 loadURL 会产生 ERR_CONNECTION_RESET。
 */
async function waitForServerAvailability(): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (serverFailed || !serverProcess) {
      throw new Error(lastServerError || "Next.js 服务进程已提前退出");
    }

    if (await probeServer()) return;
    await delay(SERVER_PROBE_INTERVAL_MS);
  }

  throw new Error(`等待 Next.js 服务超时：${serverUrl}`);
}

// 运行时窗口图标统一来自 public/icon.png。
function getRuntimeIconPath(): string | undefined {
  const candidatePaths = isDev
    ? [path.join(app.getAppPath(), "public", "icon.png")]
    : [
        path.join(process.resourcesPath, "standalone", "public", "icon.png"),
        path.join(app.getAppPath(), "public", "icon.png"),
      ];

  return candidatePaths.find((candidatePath) => fs.existsSync(candidatePath));
}

// 启动页本身是 data:text/html 页面，直接引用 file:/// 本地资源容易被拦截。
// 这里把图标文件转成 data URL 内联进 HTML，最稳。
function getRuntimeIconDataUrl(iconPath?: string): string {
  if (!iconPath) return "";

  try {
    const buffer = fs.readFileSync(iconPath);
    const extension = path.extname(iconPath).toLowerCase();
    const mimeType =
      extension === ".jpg" || extension === ".jpeg"
        ? "image/jpeg"
        : extension === ".webp"
          ? "image/webp"
          : "image/png";

    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch (error) {
    console.error("[Electron] 读取启动页图标失败:", error);
    return "";
  }
}

function buildLoadingHtml(
  iconPath?: string,
  theme: AppTheme = currentTheme,
): string {
  const palette = STARTUP_PAGE_THEME[theme];
  const iconUrl = getRuntimeIconDataUrl(iconPath);
  const iconContent = iconUrl
    ? `<img class="icon-image" src="${iconUrl}" alt="App Icon" />`
    : `<div class="icon-fallback">A</div>`;

  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="${theme}">
<style>
  :root {
    color-scheme: ${theme};
    --page-background: ${palette.pageBackground};
    --text-primary: ${palette.text};
    --text-secondary: ${palette.secondaryText};
    --text-tertiary: ${palette.tertiaryText};
    --spinner-track: ${palette.spinnerTrack};
    --spinner-head: ${palette.spinnerHead};
    --icon-shadow: ${palette.iconShadow};
  }

  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  html,
  body {
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  body {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: var(--page-background);
    color: var(--text-primary);
    font-family:
      -apple-system,
      BlinkMacSystemFont,
      "SF Pro Display",
      "SF Pro Text",
      "Segoe UI",
      "Microsoft YaHei",
      sans-serif;
    user-select: none;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;

    /*
     * 当前窗口使用无边框标题栏。把整个加载页声明为可拖动区域后，用户可在服务启动
     * 期间按住页面任意空白位置或卡片移动窗口，不必等待 React 主页面加载完成。
     */
    -webkit-app-region: drag;
  }

  .startup-card {
    display: flex;
    min-width: 280px;
    flex-direction: column;
    align-items: center;
    padding: 34px 40px 30px;
    border: 1px solid ${
      theme === "dark"
        ? "rgba(255,255,255,0.075)"
        : "rgba(29,29,31,0.075)"
    };
    border-radius: 28px;
    background: ${
      theme === "dark"
        ? "linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.025))"
        : "linear-gradient(180deg, rgba(255,255,255,0.70), rgba(255,255,255,0.42))"
    };
    box-shadow:
      ${
        theme === "dark"
          ? "0 28px 80px rgba(0,0,0,0.28)"
          : "0 28px 70px rgba(52,72,108,0.12)"
      },
      inset 0 1px 0 rgba(255,255,255,0.20);
    backdrop-filter: blur(30px) saturate(145%);
    -webkit-backdrop-filter: blur(30px) saturate(145%);
    animation: cardEnter 460ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
    cursor: move;
  }

  .icon {
    width: 72px;
    height: 72px;
    margin-bottom: 24px;
    overflow: hidden;
    border-radius: 19px;
    box-shadow: var(--icon-shadow);
    animation: iconFloat 2.4s ease-in-out infinite;
  }

  .icon-image,
  .icon-fallback {
    width: 100%;
    height: 100%;
    border-radius: inherit;
  }

  .icon-image {
    display: block;
    object-fit: cover;
  }

  .icon-fallback {
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(145deg, #64b5ff 0%, #7f7cff 48%, #bf5af2 100%);
    color: white;
    font-size: 34px;
    font-weight: 650;
  }

  .title {
    margin-bottom: 8px;
    color: var(--text-primary);
    font-size: 21px;
    font-weight: 650;
    letter-spacing: -0.025em;
  }

  .subtitle {
    margin-bottom: 30px;
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 400;
    letter-spacing: -0.006em;
  }

  .spinner {
    width: 30px;
    height: 30px;
    border: 2.5px solid var(--spinner-track);
    border-top-color: var(--spinner-head);
    border-radius: 50%;
    animation: spin 0.78s linear infinite;
  }

  .hint {
    margin-top: 19px;
    color: var(--text-tertiary);
    font-size: 11px;
    font-weight: 400;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes iconFloat {
    0%,
    100% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(-3px);
    }
  }

  @keyframes cardEnter {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.985);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

${buildInlineWindowControlsStyles(theme)}

  @media (prefers-reduced-motion: reduce) {
    .startup-card,
    .icon,
    .spinner {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
    }
  }
</style>
</head>
<body>
  ${buildInlineWindowControlsHtml()}
  <main class="startup-card" aria-live="polite">
    <div class="icon">${iconContent}</div>
    <div class="title">智能助手</div>
    <div class="subtitle">正在启动服务，请稍候…</div>
    <div class="spinner" aria-label="正在加载"></div>
    <div class="hint">首次加载可能需要几秒钟</div>
  </main>
</body>
</html>
`;
}

/**
 * Start the Next.js server as a child process.
 */
async function startServer(): Promise<void> {
  // 先清理上一次异常退出遗留的内嵌服务，再进行端口探测。
  cleanupKnownStaleServerProcess();

  // 每次启动都重新探测端口，确保应用不会依赖上一次运行时的端口状态。
  serverPort = await findAvailableServerPort();
  serverUrl = `http://${SERVER_HOST}:${serverPort}`;
  serverReady = false;
  serverFailed = false;
  lastServerError = "";

  console.log(`[Electron] 已选择可用端口 ${serverPort}，服务地址 ${serverUrl}`);

  const dashscopeApiKey = process.env.DASHSCOPE_API_KEY;
  const serpApiKey = process.env.SERPAPI_API_KEY;
  const talorDataApiToken = process.env.TALORDATA_API_TOKEN;
  const keepaApiKey = process.env.KEEPA_API_KEY;
  const tiktokClientKey = process.env.TIKTOK_CLIENT_KEY;
  const tiktokClientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const tiktokMerchantId = process.env.TIKTOK_MERCHANT_ID;
  const temuAppKey = process.env.TEMU_APP_KEY;
  const temuAppSecret = process.env.TEMU_APP_SECRET;
  const temuAccessToken = process.env.TEMU_ACCESS_TOKEN;
  const alibaba1688AppKey = process.env.ALIBABA_1688_APP_KEY;
  const alibaba1688AppSecret = process.env.ALIBABA_1688_APP_SECRET;
  const alibaba1688AccessToken = process.env.ALIBABA_1688_ACCESS_TOKEN;
  const env = {
    ...process.env, // 继承主进程的环境变量
    NEXT_PUBLIC_IS_ELECTRON: "1",

    // Next.js 服务端使用当前动态探测到的端口和本机 IPv4 地址。
    PORT: String(serverPort),
    HOSTNAME: SERVER_HOST,

    // 开发环境下让 Webpack HMR 与 Electron 实际加载的动态端口保持一致，
    // 避免页面已切换端口，但热更新 WebSocket 仍连接 3000。
    NEXT_HMR_HOST: SERVER_HOST,
    NEXT_HMR_PORT: String(serverPort),

    // Electron 启动 Next.js 子进程时启用轮询监听，提升 Windows 环境下的文件变更稳定性。
    WATCHPACK_POLLING: "true",

    // Electron 开发服务使用独立构建目录，避免与用户单独运行的 `next dev`
    // 或旧版本残留进程共同读写 `.next/dev`，导致连接重置和构建目录损坏。
    NEXT_DIST_DIR: ELECTRON_NEXT_DIST_DIR,

    // 💡 关键：在这里显式注入！
    // 这样子进程启动时，就能拿到从 .env.local 读取到的这个值
    DASHSCOPE_API_KEY: dashscopeApiKey,
    // 与 DASHSCOPE_API_KEY 一样显式注入市场数据 Token。即使用户没有在 UI 再填一次，
    // Next.js Commerce Route 也能直接使用打包进 `.env.local` 的默认值。
    SERPAPI_API_KEY: serpApiKey,
    TALORDATA_API_TOKEN: talorDataApiToken,
    KEEPA_API_KEY: keepaApiKey,
    TIKTOK_CLIENT_KEY: tiktokClientKey,
    TIKTOK_CLIENT_SECRET: tiktokClientSecret,
    TIKTOK_MERCHANT_ID: tiktokMerchantId,
    TEMU_APP_KEY: temuAppKey,
    TEMU_APP_SECRET: temuAppSecret,
    TEMU_ACCESS_TOKEN: temuAccessToken,
    ALIBABA_1688_APP_KEY: alibaba1688AppKey,
    ALIBABA_1688_APP_SECRET: alibaba1688AppSecret,
    ALIBABA_1688_ACCESS_TOKEN: alibaba1688AccessToken,
    // Keep local workspace data out of the application bundle. The Next.js
    // server receives this path and owns the SQLite connection.
    AGENT_DATA_DIR: path.join(app.getPath("userData"), "workspace-data"),
  };

  console.log(
    `[Electron] 准备启动 Next 子进程，DASHSCOPE_API_KEY=${maskSecret(dashscopeApiKey)}, TALORDATA_API_TOKEN=${maskSecret(talorDataApiToken || serpApiKey)}, KEEPA_API_KEY=${maskSecret(keepaApiKey)}, TIKTOK_CLIENT_KEY=${maskSecret(tiktokClientKey)}, TEMU_APP_KEY=${maskSecret(temuAppKey)}, ALIBABA_1688_APP_KEY=${maskSecret(alibaba1688AppKey)}`,
  );

  // 只清理 Electron 专属构建目录中的锁文件，不删除整个 dev 构建目录。
  // 删除整个 `.next/dev` 会让仍在运行的 Next 进程发生连接重置。
  if (isDev) {
    const devLockPath = path.join(
      app.getAppPath(),
      ELECTRON_NEXT_DIST_DIR,
      "dev",
      "lock",
    );
    try {
      fs.rmSync(devLockPath, { force: true });
    } catch (error) {
      console.warn("[Electron] 清理开发锁失败:", error);
    }
  }

  if (isDev) {
    const nextCliPath = path.join(
      app.getAppPath(),
      "node_modules",
      "next",
      "dist",
      "bin",
      "next",
    );

    if (!fs.existsSync(nextCliPath)) {
      throw new Error(`未找到 Next.js CLI：${nextCliPath}`);
    }

    const nextDevArguments = [
      nextCliPath,
      "dev",
      "--webpack",
      "--hostname",
      SERVER_HOST,
      "--port",
      String(serverPort),
    ];
    const nextProcessEnv = {
      ...env,
      // 使用 Electron 可执行文件作为 Node 运行时，避免 Windows shell 产生无法回收的子进程。
      ELECTRON_RUN_AS_NODE: "1",
    };

    console.log(
      `[Electron] 启动 Next.js：${process.execPath} ${nextDevArguments.slice(1).join(" ")}`,
    );

    serverProcess = spawn(process.execPath, nextDevArguments, {
      cwd: app.getAppPath(),
      env: nextProcessEnv,
      stdio: "pipe",
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } else {
    // Production: run standalone server.js.
    // ELECTRON_RUN_AS_NODE=1 makes Electron binary behave as plain Node.js.
    const serverPath = app.isPackaged
      ? path.join(process.resourcesPath, "standalone", "server.js")
      : path.join(__dirname, "../.next-electron/standalone", "server.js"); // 开发环境路径视你实际情况而定
    const serverEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
    serverProcess = spawn(process.execPath, [serverPath], {
      cwd: path.join(process.resourcesPath, "standalone"),
      env: serverEnv,
      stdio: "pipe",
    });
  }

  if (!serverProcess.pid) {
    throw new Error("Next.js 子进程未返回有效 PID");
  }
  persistServerPid(serverProcess.pid);

  serverProcess.stdout?.on("data", (data: Buffer) => {
    const output = data.toString();
    console.log(`[Next.js] ${output}`);

    // Next.js 的一部分构建错误会写入 stdout，一并保留给错误页。
    if (/error|failed|exception/iu.test(output)) {
      lastServerError += output;
    }
  });

  serverProcess.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    console.error(`[Next.js stderr] ${text}`);
    lastServerError += text;
    // 检测到锁冲突时直接判定失败
    if (text.includes("Another next dev server is already running")) {
      serverFailed = true;
    }
  });

  serverProcess.on("error", (err) => {
    console.error("Failed to start Next.js server:", err);
    lastServerError += String(err);
    serverFailed = true;
  });

  serverProcess.on("close", (code, signal) => {
    console.log(`Next.js server exited with code ${code}, signal ${signal}`);
    serverProcess = null;
    serverReady = false;
    removeServerPidFile();

    if (appIsQuitting) return;

    if (code !== 0 && code !== null) {
      serverFailed = true;
      const message =
        lastServerError ||
        `Next.js server exited with code ${code}${signal ? `, signal ${signal}` : ""}`;
      showErrorPage(message);
    }
  });

  // 以真实 HTTP 响应作为就绪标准，避免日志提前出现端口后立即 loadURL。
  await waitForServerAvailability();
  serverReady = true;
  await loadMainWindowWithRetry();
}

/**
 * Create the main BrowserWindow.
 */
function createWindow(): BrowserWindow {
  const iconPath = getRuntimeIconPath();
  const nativeWindowTheme = WINDOW_THEME[currentTheme];
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    // 完全移除原生标题栏和 titleBarOverlay，避免系统窗口按钮压在网页弹窗上方。
    frame: false,
    backgroundColor: nativeWindowTheme.backgroundColor,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  applyThemeToWindow(win, currentTheme);

  // 先显示加载中的 splash 页面
  win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      buildLoadingHtml(iconPath, currentTheme),
    )}`,
  );

  // 显示窗口（splash 会立刻可见）
  win.once("ready-to-show", () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  const notifyMaximizedState = () => {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send("window:maximized-changed", win.isMaximized());
    }
  };

  win.on("maximize", notifyMaximizedState);
  win.on("unmaximize", notifyMaximizedState);
  win.webContents.on("did-finish-load", notifyMaximizedState);
  win.on("closed", () => {
    mainWindow = null;
  });

  if (isDev && process.env.ELECTRON_OPEN_DEVTOOLS === "1") {
    win.webContents.openDevTools({ mode: "detach" });
  }

  return win;
}

/**
 * Show an error page in the main window.
 */
function showErrorPage(message: string): void {
  if (!mainWindow) return;

  const palette = STARTUP_PAGE_THEME[currentTheme];
  const safeMessage = message.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="${currentTheme}">
<style>
  :root {
    color-scheme: ${currentTheme};
    --page-background: ${palette.pageBackground};
    --text-primary: ${palette.text};
    --text-secondary: ${palette.secondaryText};
    --text-tertiary: ${palette.tertiaryText};
    --log-background: ${palette.errorLogBackground};
    --log-border: ${palette.errorLogBorder};
  }

  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  body {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: var(--page-background);
    color: var(--text-primary);
    font-family:
      -apple-system,
      BlinkMacSystemFont,
      "SF Pro Display",
      "SF Pro Text",
      "Segoe UI",
      "Microsoft YaHei",
      sans-serif;
    padding: 40px;
    text-align: center;
    -webkit-font-smoothing: antialiased;

    /* 错误页同样属于无边框窗口，保留背景拖动能力。 */
    -webkit-app-region: drag;
  }

${buildInlineWindowControlsStyles(currentTheme)}

  .icon {
    width: 68px;
    height: 68px;
    border-radius: 19px;
    background: linear-gradient(145deg, #ff6961 0%, #ff9f0a 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 32px;
    font-weight: 650;
    margin-bottom: 24px;
    box-shadow: 0 18px 46px rgba(255,69,58,0.20);
  }

  .title {
    margin-bottom: 10px;
    font-size: 21px;
    font-weight: 650;
    letter-spacing: -0.025em;
  }

  .subtitle {
    max-width: 540px;
    margin-bottom: 24px;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.65;
  }

  .log {
    width: min(680px, 100%);
    max-height: 220px;
    overflow: auto;
    padding: 14px;
    border: 1px solid var(--log-border);
    border-radius: 14px;
    background: var(--log-background);
    color: var(--text-secondary);
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 11px;
    line-height: 1.6;
    text-align: left;
    white-space: pre-wrap;
    word-break: break-all;
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);

    /* 日志需要允许鼠标滚动和选择文字，因此排除出拖动区域。 */
    -webkit-app-region: no-drag;
    user-select: text;
  }

  .btn {
    margin-top: 22px;
    padding: 9px 18px;
    border: 0;
    border-radius: 11px;
    background: linear-gradient(180deg, #168dff 0%, #0879eb 100%);
    box-shadow:
      0 9px 22px rgba(10,132,255,0.22),
      inset 0 1px 0 rgba(255,255,255,0.22);
    color: white;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    transition:
      transform 150ms ease,
      filter 150ms ease;

    /* 可交互控件必须标记为 no-drag，否则点击事件会被窗口拖动行为吞掉。 */
    -webkit-app-region: no-drag;
  }

  .btn:hover {
    filter: brightness(1.04);
    transform: translateY(-1px);
  }

  .btn:active {
    transform: scale(0.98);
  }
</style>
</head>
<body>
  ${buildInlineWindowControlsHtml()}
  <div class="icon">!</div>
  <div class="title">服务启动失败</div>
  <div class="subtitle">
    Next.js 服务未能正常启动。应用已自动选择可用端口，请根据下方日志检查依赖、环境变量或构建资源是否完整。
  </div>
  <div class="log">${safeMessage}</div>
  <button class="btn" onclick="location.reload()">重试</button>
</body>
</html>
`;

  mainWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  );
}

/**
 * Load the Next.js URL with retry logic.
 */
async function loadMainWindowWithRetry(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const maxRetries = 5;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    if (serverFailed || !serverProcess) {
      throw new Error(lastServerError || "Next.js 服务进程已经退出");
    }

    console.log(
      `[Electron] Loading ${serverUrl} (attempt ${attempt}/${maxRetries})`,
    );

    try {
      await mainWindow.loadURL(serverUrl);
      console.log("[Electron] Page loaded successfully");
      if (isDev && process.env.ELECTRON_OPEN_DEVTOOLS === "1") {
        mainWindow.webContents.openDevTools();
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Electron] Failed to load (attempt ${attempt}):`, message);
      if (attempt === maxRetries) throw error;
      await delay(1_000);
    }
  }
}

/**
 * Setup auto-updater (production only)
 */
function setupAutoUpdater(): void {
  if (isDev) return;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require("electron-updater");
    autoUpdater.checkForUpdatesAndNotify();

    setInterval(
      () => {
        autoUpdater.checkForUpdatesAndNotify();
      },
      60 * 60 * 1000,
    );
  } catch {
    console.log("Auto-updater not available");
  }
}

interface CommercePdfExportPayload {
  html: string;
  suggestedFileName: string;
}

function sanitizePdfFileName(value: string): string {
  const base = value
    .replace(/[\\/:*?"<>|]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 90) || "Amazon市场研究.pdf";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

function isCommercePdfPayload(value: unknown): value is CommercePdfExportPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.html === "string" &&
    record.html.length > 0 &&
    record.html.length <= 2_000_000 &&
    typeof record.suggestedFileName === "string" &&
    record.suggestedFileName.length <= 180
  );
}

/**
 * 使用 Electron 自带 Chromium 渲染引擎生成 PDF，不引入额外 PDF npm 依赖。
 * 隐藏窗口关闭 JavaScript/Node 能力，只负责排版和 printToPDF，降低任意 HTML 的风险。
 */
async function exportCommerceReportPdf(
  payload: CommercePdfExportPayload,
): Promise<{ canceled: boolean; filePath?: string }> {
  const suggestedFileName = sanitizePdfFileName(payload.suggestedFileName);
  const dialogOptions = {
    title: "保存 Amazon 市场研究报告",
    defaultPath: path.join(app.getPath("downloads"), suggestedFileName),
    filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
  };
  const saveResult = mainWindow
    ? await dialog.showSaveDialog(mainWindow, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions);

  if (saveResult.canceled || !saveResult.filePath) {
    return { canceled: true };
  }

  const printWindow = new BrowserWindow({
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: false,
    },
  });

  try {
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(payload.html)}`;
    await printWindow.loadURL(dataUrl);
    const pdfBuffer = await printWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      margins: {
        top: 0.4,
        bottom: 0.45,
        left: 0.35,
        right: 0.35,
      },
    });
    fs.writeFileSync(saveResult.filePath, pdfBuffer);
    return { canceled: false, filePath: saveResult.filePath };
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
  }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit(); // 如果已经有一个实例在运行，直接退出当前实例
} else {
  // 只有获取到锁才执行后续启动逻辑。
  void app
    .whenReady()
    .then(() => {
      currentTheme = readPersistedWindowTheme();
      nativeTheme.themeSource = currentTheme;

      Menu.setApplicationMenu(null);
      registerWindowControlIpc();
      mainWindow = createWindow();

      ipcMain.on("window:setTheme", (_event, theme: unknown) => {
        if (!isAppTheme(theme)) {
          console.warn("[Electron] 忽略无效主题值:", theme);
          return;
        }

        applyNativeWindowTheme(theme);
      });

      // 注册选择文件夹的 IPC 事件。
      ipcMain.handle("dialog:openDirectory", async () => {
        if (!mainWindow) return null;

        const { canceled, filePaths } = await dialog.showOpenDialog(
          mainWindow,
          {
            properties: ["openDirectory"],
            title: "选择项目工作目录",
          },
        );

        if (canceled || filePaths.length === 0) {
          return null;
        }

        return filePaths[0];
      });

      ipcMain.handle("commerce:exportPdf", async (_event, payload: unknown) => {
        if (!isCommercePdfPayload(payload)) {
          throw new Error("PDF 导出参数无效");
        }

        return exportCommerceReportPdf(payload);
      });

      // 动态端口探测是异步操作。这里集中捕获服务启动异常，并把错误展示在当前加载窗口中。
      void startServer().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[Electron] 启动内嵌 Next.js 服务失败:", error);
        serverFailed = true;
        lastServerError = message;
        showErrorPage(message);
      });

      setupAutoUpdater();
    })
    .catch((error: unknown) => {
      // 捕获窗口创建、IPC 注册等初始化阶段的异常，避免出现
      // UnhandledPromiseRejectionWarning 后应用停在空白加载页。
      const message =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error("[Electron] 应用初始化失败:", error);
      serverFailed = true;
      lastServerError = message;

      if (mainWindow && !mainWindow.isDestroyed()) {
        showErrorPage(message);
        return;
      }

      dialog.showErrorBox("应用初始化失败", message);
      app.quit();
    });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  appIsQuitting = true;
  stopServerProcess();
});
