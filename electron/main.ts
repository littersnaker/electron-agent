/**
 * 模块职责：Electron 主进程入口。
 * 启动顺序：读取主题 -> 显示加载页 -> 启动 FastAPI -> 加载 React -> 显示主窗口。
 */
import { app, BrowserWindow, dialog, Menu, nativeTheme, Tray } from "electron";
import {
  readCachedTheme,
  synchronizeThemeWithBackend,
  type AppTheme,
} from "./app-preferences";
import { startBackend, stopBackend } from "./backend-process";
import { registerApplicationIpc, setApplicationBackendBaseUrl } from "./ipc";
import {
  closeStartupWindow,
  createStartupWindow,
  updateStartupWindow,
  updateStartupWindowTheme,
} from "./splash-window";
import { createMainWindow, loadMainWindow, showStartupError } from "./window";
import path from "node:path";

let mainWindow: BrowserWindow | null = null;
let startupWindow: BrowserWindow | null = null;
let ipcRegistered = false;
let activeTheme: AppTheme = "light";
let tray: Tray | null = null;

function createTray() {
  tray = new Tray(path.join(__dirname, "../public/icon.png"));

  const menu = Menu.buildFromTemplate([
    {
      label: "打开窗口",
      click() {
        mainWindow?.show();
      },
    },
    {
      label: "退出",
      click() {
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);

  tray.on("click", () => {
    mainWindow?.show();
  });
}
/** 启动桌面应用的全部运行时组件。 */
async function bootstrap(): Promise<void> {
  Menu.setApplicationMenu(null);
  if (!ipcRegistered) {
    registerApplicationIpc();
    ipcRegistered = true;
  }

  activeTheme = readCachedTheme();
  nativeTheme.themeSource = activeTheme;
  startupWindow = await createStartupWindow(activeTheme);

  try {
    const backend = await startBackend((progress) => {
      updateStartupWindow(startupWindow, progress);
    });
    setApplicationBackendBaseUrl(backend.baseUrl);

    activeTheme = await synchronizeThemeWithBackend(
      backend.baseUrl,
      activeTheme,
    );
    nativeTheme.themeSource = activeTheme;
    updateStartupWindowTheme(startupWindow, activeTheme);
    updateStartupWindow(startupWindow, {
      title: "本地服务已就绪",
      detail: "正在定位 Vite 页面或 FastAPI 静态前端…",
      progress: 0.97,
    });

    const window = createMainWindow(backend.baseUrl, activeTheme);
    mainWindow = window;
    createTray();
    window.on("closed", () => {
      mainWindow = null;
    });

    try {
      await loadMainWindow(window, backend.baseUrl);
    } catch (error) {
      const message =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      closeStartupWindow(startupWindow);
      startupWindow = null;
      await showStartupError(window, message, activeTheme);
      return;
    }

    updateStartupWindow(startupWindow, {
      title: "Multi-agent 已就绪",
      detail: "正在进入工作台…",
      progress: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    closeStartupWindow(startupWindow);
    startupWindow = null;
    if (!window.isDestroyed()) window.show();
  } catch (error) {
    closeStartupWindow(startupWindow);
    startupWindow = null;
    throw error;
  }
}

/** 把启动异常显示给用户，并在没有窗口时弹出系统错误框。 */
async function handleBootstrapError(error: unknown): Promise<void> {
  closeStartupWindow(startupWindow);
  startupWindow = null;
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error("[Electron] 应用启动失败", error);
  if (mainWindow && !mainWindow.isDestroyed()) {
    await showStartupError(mainWindow, message, activeTheme);
    return;
  }
  dialog.showErrorBox("应用启动失败", message);
  app.quit();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(bootstrap).catch(handleBootstrapError);
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void bootstrap().catch(handleBootstrapError);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  closeStartupWindow(startupWindow);
  startupWindow = null;
  stopBackend();
});
