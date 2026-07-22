import {
  app,
  BrowserWindow,
  Menu,
  shell,
  ipcMain,
  dialog,
  nativeTheme,
} from "electron";
import path from "path";
import fs from "fs";
import { spawn, ChildProcess, execSync } from "child_process";
import * as dotenv from "dotenv";
type AppTheme = "dark" | "light";

const TITLE_BAR_HEIGHT = 44;
const WINDOW_THEME = {
  dark: {
    backgroundColor: "#09090b",
    overlayColor: "#0f0f12",
    symbolColor: "#f5f5f7",
  },
  light: {
    backgroundColor: "#eef1f6",
    overlayColor: "#f1f4f9",
    symbolColor: "#1d1d1f",
  },
} satisfies Record<
  AppTheme,
  {
    backgroundColor: string;
    overlayColor: string;
    symbolColor: string;
  }
>;

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

const WINDOW_THEME_FILE = "window-theme.json";
let currentTheme: AppTheme = "dark";

function isAppTheme(value: unknown): value is AppTheme {
  return value === "dark" || value === "light";
}

function readPersistedWindowTheme(): AppTheme {
  try {
    const themePath = path.join(app.getPath("userData"), WINDOW_THEME_FILE);
    if (!fs.existsSync(themePath)) return "dark";

    const parsed = JSON.parse(fs.readFileSync(themePath, "utf8")) as {
      theme?: unknown;
    };
    return isAppTheme(parsed.theme) ? parsed.theme : "dark";
  } catch (error) {
    console.warn("[Electron] 读取窗口主题失败，将使用深色模式:", error);
    return "dark";
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
  const palette = WINDOW_THEME[theme];

  win.setBackgroundColor(palette.backgroundColor);

  // Windows / Linux 的右上角最小化、最大化和关闭按钮属于原生标题栏覆盖层，
  // 网页中的 CSS 和 backdrop-filter 无法绘制这块区域，必须由主进程更新。
  if (
    (process.platform === "win32" || process.platform === "linux") &&
    typeof win.setTitleBarOverlay === "function"
  ) {
    win.setTitleBarOverlay({
      color: palette.overlayColor,
      symbolColor: palette.symbolColor,
      height: TITLE_BAR_HEIGHT,
    });
  }
}

function applyNativeWindowTheme(theme: AppTheme): void {
  currentTheme = theme;
  nativeTheme.themeSource = theme;
  persistWindowTheme(theme);

  if (mainWindow && !mainWindow.isDestroyed()) {
    applyThemeToWindow(mainWindow, theme);
  }
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

const PORT = 3000;
const DEV_URL = `http://localhost:${PORT}`;

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let serverReady = false;
let serverFailed = false;
let lastServerError = "";

const isDev = !app.isPackaged;

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
 * Kill any stale "next dev" processes that may hold the lock.
 * Uses PowerShell for reliable process matching on Windows.
 */
function killStaleDevServer(): void {
  if (process.platform === "win32") {
    try {
      // 用 PowerShell 杀掉命令行包含 "next" 和 "dev" 的 node 进程
      execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -match 'next' -and $_.CommandLine -match 'dev' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        {
          stdio: "ignore",
          shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
          timeout: 8000,
        },
      );
      console.log("[Electron] Killed stale next dev processes");
    } catch {
      // 没有残留进程，忽略
    }
    // 也杀掉占用目标端口的进程
    try {
      execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        {
          stdio: "ignore",
          shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
          timeout: 8000,
        },
      );
    } catch {
      // 端口未占用，忽略
    }
  } else {
    try {
      execSync(`pkill -f "next dev"`, { stdio: "ignore", timeout: 5000 });
    } catch {
      // ignore
    }
  }
  // 等待 500ms 让进程退出并释放文件句柄
  const start = Date.now();
  while (Date.now() - start < 500) {
    /* busy wait */
  }
}

/**
 * Start the Next.js server as a child process.
 */
function startServer(): void {
  const dashscopeApiKey = process.env.DASHSCOPE_API_KEY;
  const env = {
    ...process.env, // 继承主进程的环境变量
    NEXT_PUBLIC_IS_ELECTRON: "1",
    PORT: String(PORT),
    HOSTNAME: "localhost",

    // 💡 关键：在这里显式注入！
    // 这样子进程启动时，就能拿到从 .env.local 读取到的这个值
    DASHSCOPE_API_KEY: dashscopeApiKey,
    // Keep local workspace data out of the application bundle. The Next.js
    // server receives this path and owns the SQLite connection.
    AGENT_DATA_DIR: path.join(app.getPath("userData"), "workspace-data"),
  };

  console.log(
    `[Electron] 准备启动 Next 子进程，DASHSCOPE_API_KEY=${maskSecret(dashscopeApiKey)}`,
  );

  // 清理残留的 dev server 进程和锁文件
  if (isDev) {
    killStaleDevServer();
    const devLockPath = path.join(app.getAppPath(), ".next", "dev");
    try {
      if (fs.existsSync(devLockPath)) {
        fs.rmSync(devLockPath, { recursive: true, force: true });
        console.log("[Electron] Removed stale Next.js dev lock");
      }
    } catch (e) {
      console.warn("[Electron] Could not remove dev lock:", e);
    }
  }

  if (isDev) {
    serverProcess = spawn(
      "next",
      ["dev", "--webpack", "--port", String(PORT)],
      {
        cwd: app.getAppPath(),
        env,
        stdio: "pipe",
        shell: true,
        windowsHide: true,
      },
    );
  } else {
    // Production: run standalone server.js.
    // ELECTRON_RUN_AS_NODE=1 makes Electron binary behave as plain Node.js.
    const serverPath = app.isPackaged
      ? path.join(process.resourcesPath, "standalone", "server.js")
      : path.join(__dirname, "../.next/standalone", "server.js"); // 开发环境路径视你实际情况而定
    const serverEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
    serverProcess = spawn(process.execPath, [serverPath], {
      cwd: path.join(process.resourcesPath, "standalone"),
      env: serverEnv,
      stdio: "pipe",
    });
  }

  serverProcess.stdout?.on("data", (data: Buffer) => {
    const output = data.toString();
    console.log(`[Next.js] ${output}`);
    if (
      !serverReady &&
      (output.includes("Ready") || output.includes(`localhost:${PORT}`))
    ) {
      serverReady = true;
      // 多等 1 秒确保页面可访问
      setTimeout(() => loadMainWindowWithRetry(), 1000);
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

  serverProcess.on("close", (code) => {
    console.log(`Next.js server exited with code ${code}`);
    serverProcess = null;
    if (code !== 0 && code !== null) {
      serverFailed = true;
      // 2 秒后若仍无成功加载，显示错误页
      setTimeout(() => {
        if (!serverReady) {
          showErrorPage(
            lastServerError || `Next.js server exited with code ${code}`,
          );
        }
      }, 2000);
    }
  });

  // Fallback: if server doesn't emit "Ready" within 40s, still try to load
  setTimeout(() => {
    if (!serverReady && !serverFailed) {
      serverReady = true;
      loadMainWindowWithRetry();
    }
  }, 40000);
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
    frame: false,
    backgroundColor: nativeWindowTheme.backgroundColor,
    titleBarStyle: "hidden", // 强制开启隐藏标题栏模式
    titleBarOverlay: {
      color: nativeWindowTheme.overlayColor,
      symbolColor: nativeWindowTheme.symbolColor,
      height: TITLE_BAR_HEIGHT,
    },
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

  win.on("closed", () => {
    mainWindow = null;
  });
  win.webContents.openDevTools({
    mode: "detach", // 单独窗口
  });

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
  }

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
  <div class="icon">!</div>
  <div class="title">服务启动失败</div>
  <div class="subtitle">
    Next.js 服务未能正常启动，可能是端口占用或进程残留。请尝试关闭所有 Node.js 进程后重试。
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
function loadMainWindowWithRetry(): void {
  if (!mainWindow) return;

  const maxRetries = 8;
  let attempt = 0;

  function tryLoad() {
    attempt++;
    console.log(
      `[Electron] Loading ${DEV_URL} (attempt ${attempt}/${maxRetries})`,
    );

    mainWindow!
      .loadURL(DEV_URL)
      .then(() => {
        console.log("[Electron] Page loaded successfully");
        if (isDev) {
          mainWindow!.webContents.openDevTools();
        }
      })
      .catch((err) => {
        console.error(
          `[Electron] Failed to load (attempt ${attempt}):`,
          err.message,
        );
        if (attempt < maxRetries) {
          setTimeout(tryLoad, 2000);
        } else {
          console.error(
            "[Electron] Max retries reached, page may not be available",
          );
          showErrorPage(lastServerError || err.message);
        }
      });
  }
  tryLoad();
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
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit(); // 如果已经有一个实例在运行，直接退出当前实例
} else {
  // 只有获取到锁才执行后续启动逻辑
  app.whenReady().then(() => {
    currentTheme = readPersistedWindowTheme();
    nativeTheme.themeSource = currentTheme;

    Menu.setApplicationMenu(null);
    mainWindow = createWindow();

    ipcMain.on("window:setTheme", (_event, theme: unknown) => {
      if (!isAppTheme(theme)) {
        console.warn("[Electron] 忽略无效主题值:", theme);
        return;
      }

      applyNativeWindowTheme(theme);
    });

    // ⚡ 新增：注册选择文件夹的 IPC 事件
    ipcMain.handle("dialog:openDirectory", async () => {
      if (!mainWindow) return null;
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory"], // 只允许选择文件夹
        title: "选择项目工作目录",
      });
      if (canceled || filePaths.length === 0) {
        return null;
      }
      return filePaths[0]; // 返回选中的文件夹绝对路径
    });

    startServer();
    setupAutoUpdater();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
