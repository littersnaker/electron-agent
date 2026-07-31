/**
 * 模块职责：Electron 主进程入口。
 * 启动顺序：获取单实例锁 -> 显示加载页 -> 启动 FastAPI -> 创建 React 窗口 -> 关闭加载页。
 */
import { app, BrowserWindow, dialog, Menu } from "electron";
import { startBackend, stopBackend } from "./backend-process";
import { registerApplicationIpc } from "./ipc";
import {
  closeStartupWindow,
  createStartupWindow,
  updateStartupWindow,
} from "./splash-window";
import { createMainWindow, showStartupError } from "./window";

let mainWindow: BrowserWindow | null = null;
let startupWindow: BrowserWindow | null = null;
let ipcRegistered = false;

/**
 * 启动桌面应用的全部运行时组件。
 */
async function bootstrap(): Promise<void> {
  Menu.setApplicationMenu(null);
  // macOS 关闭最后一个窗口后应用进程仍然存在；重新打开窗口时不能重复注册 IPC。
  if (!ipcRegistered) {
    registerApplicationIpc();
    ipcRegistered = true;
  }

  startupWindow = await createStartupWindow();
  try {
    const backend = await startBackend((progress) => {
      updateStartupWindow(startupWindow, progress);
    });

    updateStartupWindow(startupWindow, {
      title: "工作台准备完成",
      detail: "正在载入会话、插件和界面资源…",
      progress: 0.98,
    });

    mainWindow = createMainWindow(backend.baseUrl, {
      onReadyToShow: (window) => {
        updateStartupWindow(startupWindow, {
          title: "Multi-agent 已就绪",
          detail: "正在进入工作台…",
          progress: 1,
        });
        setTimeout(() => {
          closeStartupWindow(startupWindow);
          startupWindow = null;
          if (!window.isDestroyed()) window.show();
        }, 160);
      },
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  } catch (error) {
    closeStartupWindow(startupWindow);
    startupWindow = null;
    throw error;
  }
}

/**
 * 把启动异常显示给用户，并在没有窗口时弹出系统错误框。
 */
async function handleBootstrapError(error: unknown): Promise<void> {
  closeStartupWindow(startupWindow);
  startupWindow = null;
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error("[Electron] 应用启动失败", error);
  if (mainWindow && !mainWindow.isDestroyed()) {
    await showStartupError(mainWindow, message);
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
