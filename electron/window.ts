/**
 * 模块职责：创建桌面窗口、记录渲染进程诊断信息并加载 React 页面。
 */
import { BrowserWindow, shell } from "electron";
import path from "node:path";
import type { AppTheme } from "./app-preferences";
import { isDevelopmentMode } from "./backend-process";
import { DEVELOPMENT_SESSION_PARTITION } from "./development-runtime";
import { loadRendererPage } from "./renderer-loader";

/** 根据主题返回窗口创建阶段使用的底色。 */
function resolveWindowBackground(theme: AppTheme): string {
  return theme === "dark" ? "#111827" : "#eef1f6";
}

/** 创建隐藏的应用主窗口，页面加载成功后再由主进程显示。 */
export function createMainWindow(
  backendBaseUrl: string,
  initialTheme: AppTheme,
): BrowserWindow {
  const window = new BrowserWindow({
    width: 1765,
    height: 1115,
    minWidth: 800,
    minHeight: 600,
    accentColor: false,
    frame: false,
    show: false,
    backgroundColor: resolveWindowBackground(initialTheme),
    icon: resolveWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      ...(isDevelopmentMode()
        ? { partition: DEVELOPMENT_SESSION_PARTITION }
        : {}),
      additionalArguments: [
        `--backend-url=${backendBaseUrl}`,
        `--app-theme=${initialTheme}`,
      ],
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  bindMaximizeNotifications(window);
  bindRendererDiagnostics(window);

  if (isDevelopmentMode() && process.env.ELECTRON_OPEN_DEVTOOLS === "1") {
    window.webContents.openDevTools({ mode: "detach" });
  }
  return window;
}

/** 加载 React 页面；严格开发模式只允许 Vite，禁止静默回退旧 dist。 */
export function loadMainWindow(
  window: BrowserWindow,
  backendBaseUrl: string,
): Promise<string> {
  return loadRendererPage(window, backendBaseUrl);
}

/** 根据开发或打包环境解析窗口图标。 */
function resolveWindowIcon(): string {
  return isDevelopmentMode()
    ? path.join(
        process.cwd(),
        "public",
        process.platform === "win32" ? "icon.ico" : "icon.png",
      )
    : path.join(
        process.resourcesPath,
        process.platform === "win32" ? "icon.ico" : "icon.png",
      );
}

/** 在最大化状态变化时通知 React 自定义标题栏。 */
function bindMaximizeNotifications(window: BrowserWindow): void {
  const notify = (): void => {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send("window:maximized-changed", window.isMaximized());
    }
  };
  window.on("maximize", notify);
  window.on("unmaximize", notify);
  window.webContents.on("did-finish-load", notify);
}

/** 把页面加载失败和渲染进程退出原因打印到启动终端。 */
function bindRendererDiagnostics(window: BrowserWindow): void {
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      console.warn(
        `[Electron] 页面加载失败 ${errorCode} ${errorDescription}：${validatedUrl}`,
      );
    },
  );
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("[Electron] React 渲染进程异常退出", details);
  });
  window.webContents.on("unresponsive", () => {
    console.warn("[Electron] React 页面暂时无响应");
  });
}

/** 显示可读错误页面，保证用户不会只看到纯色空白窗口。 */
export async function showStartupError(
  window: BrowserWindow,
  message: string,
  theme: AppTheme = "dark",
): Promise<void> {
  const escaped = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const dark = theme === "dark";
  const background = dark ? "#111827" : "#eef1f6";
  const panel = dark ? "#1e293b" : "#ffffff";
  const text = dark ? "#f8fafc" : "#151519";
  const border = dark ? "#334155" : "#d8dee9";
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
  <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:${background};color:${text};font-family:system-ui}.card{box-sizing:border-box;width:min(760px,calc(100vw - 48px));padding:32px;border:1px solid ${border};border-radius:20px;background:${panel}}pre{max-height:52vh;overflow:auto;white-space:pre-wrap;color:#ef4444}</style>
  <body><section class="card"><h1>应用界面加载失败</h1><p>FastAPI 已启动，但 React 页面没有成功载入。请检查下面的地址和错误信息。</p><pre>${escaped}</pre></section></body></html>`;
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  );
  if (!window.isVisible()) window.show();
}
