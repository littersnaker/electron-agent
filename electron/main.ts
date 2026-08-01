/**
 * 模块职责：Electron 主进程入口。
 * 启动顺序：读取主题 -> 显示加载页 -> 启动 FastAPI -> 加载 React -> 显示主窗口。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  Tray,
  type NativeImage,
} from "electron";
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

let mainWindow: BrowserWindow | null = null;
let startupWindow: BrowserWindow | null = null;
let ipcRegistered = false;
let activeTheme: AppTheme = "light";
let tray: Tray | null = null;

/** 恢复并聚焦主窗口。 */
function showMainWindow(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;

  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** 获取开发环境和安装环境中可能存在的托盘图标地址。 */
function getTrayIconCandidates(): string[] {
  const platformIcon = process.platform === "win32" ? "icon.ico" : "icon.png";

  if (app.isPackaged) {
    return [
      path.join(process.resourcesPath, platformIcon),
      path.join(process.resourcesPath, "icon.png"),
      path.join(app.getAppPath(), "public", platformIcon),
      path.join(app.getAppPath(), "public", "icon.png"),
    ];
  }

  return [
    path.join(app.getAppPath(), "public", platformIcon),
    path.join(app.getAppPath(), "public", "icon.png"),
    path.join(process.cwd(), "public", platformIcon),
    path.join(process.cwd(), "public", "icon.png"),
  ];
}

/** 找到第一个存在且能被 Electron 正常解析的托盘图标。 */
function resolveTrayIcon(): NativeImage | null {
  const candidates = [...new Set(getTrayIconCandidates())];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;

    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) {
      console.info(`[Electron] 使用托盘图标：${candidate}`);
      return image;
    }

    console.warn(`[Electron] 托盘图标无法解析：${candidate}`);
  }

  console.warn(
    `[Electron] 未找到可用托盘图标，已跳过托盘功能。候选地址：\n${candidates.join(
      "\n",
    )}`,
  );
  return null;
}

/** 创建系统托盘；托盘失败不能阻断应用启动。 */
function createTray(): void {
  if (tray && !tray.isDestroyed()) return;

  const icon = resolveTrayIcon();
  if (!icon) return;

  let nextTray: Tray | null = null;

  try {
    nextTray = new Tray(icon);
    nextTray.setToolTip("Multi-agent");
    nextTray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "打开窗口",
          click: showMainWindow,
        },
        {
          type: "separator",
        },
        {
          label: "退出",
          click() {
            app.quit();
          },
        },
      ]),
    );
    nextTray.on("click", showMainWindow);
    tray = nextTray;
  } catch (error) {
    nextTray?.destroy();
    console.error("[Electron] 创建系统托盘失败，已继续启动应用", error);
  }
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

    // 页面成功加载后再创建托盘，且托盘失败不会影响主界面。
    createTray();

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
  app.on("second-instance", showMainWindow);
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

  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }

  stopBackend();
});
