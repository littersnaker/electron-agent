import { app, BrowserWindow, Menu, shell, ipcMain, dialog } from "electron";
import path from "path";
import fs from "fs";
import { spawn, ChildProcess, execSync } from "child_process";
import { nativeTheme } from "electron";
import * as dotenv from "dotenv";
nativeTheme.themeSource = "dark";
dotenv.config({ path: path.join(__dirname, "../.env.local") });
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

// 加载中页面 HTML（紫蓝渐变暗黑风）
const LOADING_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
    color: #ededf2;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    user-select: none;
  }
  .icon {
    width: 72px; height: 72px;
    border-radius: 18px;
    background: linear-gradient(135deg, #a855f7 0%, #6366f1 100%);
    display: flex; align-items: center; justify-content: center;
    font-size: 36px; font-weight: bold; color: white;
    box-shadow: 0 8px 32px -8px rgba(139, 92, 246, 0.5);
    margin-bottom: 24px;
    animation: pulse 2s ease-in-out infinite;
  }
  .title { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
  .subtitle { font-size: 13px; color: #9a9ab0; margin-bottom: 32px; }
  .spinner {
    width: 32px; height: 32px;
    border: 3px solid rgba(139, 92, 246, 0.2);
    border-top-color: #8b5cf6;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .hint { font-size: 12px; color: #6b6b85; margin-top: 20px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 0%,100% { opacity: 0.8; } 50% { opacity: 1; } }
</style>
</head>
<body>
  <div class="icon">A</div>
  <div class="title">智能助手</div>
  <div class="subtitle">正在启动服务，请稍候...</div>
  <div class="spinner"></div>
  <div class="hint">首次加载可能需要几秒钟</div>
</body>
</html>
`;

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
  const env = {
    ...process.env, // 继承主进程的环境变量
    NEXT_PUBLIC_IS_ELECTRON: "1",
    PORT: String(PORT),
    HOSTNAME: "localhost",

    // 💡 关键：在这里显式注入！
    // 这样子进程启动时，就能拿到从 .env.local 读取到的这个值
    DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
  };

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
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    backgroundColor: "#0a0a0f",
    titleBarStyle: "hidden", // 强制开启隐藏标题栏模式
    titleBarOverlay: {
      color: "#131321", // 工具栏背景色
      symbolColor: "#ededf2", // 按钮颜色
      height: 42, // 工具栏高度
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  // 先显示加载中的 splash 页面
  win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`,
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

  return win;
}

/**
 * Show an error page in the main window.
 */
function showErrorPage(message: string): void {
  if (!mainWindow) return;
  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
    color: #ededf2;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    padding: 40px;
    text-align: center;
  }
  .icon { width: 72px; height: 72px; border-radius: 18px; background: linear-gradient(135deg, #ef4444 0%, #f59e0b 100%); display: flex; align-items: center; justify-content: center; font-size: 36px; font-weight: bold; color: white; margin-bottom: 24px; }
  .title { font-size: 20px; font-weight: 600; margin-bottom: 12px; }
  .subtitle { font-size: 13px; color: #9a9ab0; margin-bottom: 24px; max-width: 520px; line-height: 1.6; }
  .log { background: rgba(0,0,0,0.3); border: 1px solid #26263a; border-radius: 8px; padding: 12px; font-family: monospace; font-size: 12px; color: #a1a1aa; text-align: left; max-width: 640px; width: 100%; max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
  .btn { margin-top: 24px; padding: 8px 20px; border-radius: 8px; background: linear-gradient(135deg, #a855f7 0%, #6366f1 100%); color: white; border: none; cursor: pointer; font-size: 13px; }
</style>
</head>
<body>
  <div class="icon">!</div>
  <div class="title">服务启动失败</div>
  <div class="subtitle">Next.js 服务未能正常启动，可能是端口占用或进程残留。请尝试关闭所有 Node.js 进程后重试。</div>
  <div class="log">${message.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
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
    Menu.setApplicationMenu(null);
    mainWindow = createWindow();

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
