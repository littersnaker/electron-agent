/**
 * 模块职责：创建桌面窗口并加载 React 页面。
 */
import { BrowserWindow, shell } from "electron";
import path from "node:path";
import { isDevelopmentMode } from "./backend-process";

export interface MainWindowOptions {
  onReadyToShow?: (window: BrowserWindow) => void;
}

/**
 * 创建应用主窗口。
 *
 * 默认在页面准备完成后显示；传入 onReadyToShow 时由调用方负责关闭加载页并显示主窗口。
 */
export function createMainWindow(
  backendBaseUrl: string,
  options: MainWindowOptions = {},
): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    accentColor:false,
    frame: false,
    show: false,
    backgroundColor: "#111827",
    icon: resolveWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--backend-url=${backendBaseUrl}`],
    },
  });

  window.once("ready-to-show", () => {
    if (options.onReadyToShow) options.onReadyToShow(window);
    else window.show();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  bindMaximizeNotifications(window);

  const rendererUrl = isDevelopmentMode()
    ? process.env.VITE_DEV_SERVER_URL?.trim() || "http://127.0.0.1:5173"
    : backendBaseUrl;
  void window.loadURL(rendererUrl);

  if (isDevelopmentMode() && process.env.ELECTRON_OPEN_DEVTOOLS === "1") {
    window.webContents.openDevTools({ mode: "detach" });
  }
  return window;
}

/**
 * 根据开发或打包环境解析窗口图标。
 */
function resolveWindowIcon(): string {
  return isDevelopmentMode()
    ? path.join(process.cwd(), "public", process.platform === "win32" ? "icon.ico" : "icon.png")
    : path.join(process.resourcesPath, process.platform === "win32" ? "icon.ico" : "icon.png");
}

/**
 * 在最大化状态变化时通知 React 自定义标题栏。
 */
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

/**
 * 显示启动失败页面，保证用户不会只看到空白窗口。
 */
export async function showStartupError(
  window: BrowserWindow,
  message: string,
): Promise<void> {
  const escaped = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
  <style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111827;color:#f8fafc;font-family:system-ui}.card{max-width:760px;padding:32px;border:1px solid #334155;border-radius:20px;background:#1e293b}pre{white-space:pre-wrap;color:#fecaca}</style>
  <body><section class="card"><h1>应用启动失败</h1><p>本地 Python FastAPI 服务没有正常启动。</p><pre>${escaped}</pre></section></body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  if (!window.isVisible()) window.show();
}
