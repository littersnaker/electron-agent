/**
 * 模块职责：监听 Electron 主进程源码，重新编译后自动重启开发窗口。
 *
 * React 由 Vite HMR 负责；Python 由 Uvicorn reload 负责。本脚本只处理
 * electron/*.ts，因此修改三层代码都无需手动反复关闭和重新启动整个项目。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { context, type BuildResult, type Plugin } from "esbuild";

const rootDirectory = path.resolve(__dirname, "..");
const requireFromProject = createRequire(path.join(rootDirectory, "package.json"));
const electronExecutable = requireFromProject("electron") as string;
const outputDirectory = path.join(rootDirectory, ".electron");
let electronProcess: ChildProcess | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;

/** 关闭当前 Electron 进程树，避免热重启后残留旧窗口或旧 preload。 */
function stopElectronProcess(): void {
  const child = electronProcess;
  electronProcess = null;
  if (!child || child.exitCode !== null) return;

  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGTERM");
}

/** 使用最新 .electron 输出启动一个全新的开发窗口。 */
function launchElectron(): void {
  if (shuttingDown) return;
  stopElectronProcess();
  console.log("[Electron 热更新] 正在启动最新主进程代码...");
  electronProcess = spawn(electronExecutable, [rootDirectory], {
    cwd: rootDirectory,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL:
        process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173",
      BACKEND_DEV_URL:
        process.env.BACKEND_DEV_URL || "http://127.0.0.1:3100",
      ELECTRON_DEV_STRICT: "1",
    },
    stdio: "inherit",
    windowsHide: false,
  });
  electronProcess.once("exit", (code) => {
    if (!shuttingDown && code && code !== 0) {
      console.warn(`[Electron 热更新] 窗口退出，退出码：${code}`);
    }
  });
}

/** 合并短时间内的多次编译通知，避免保存多个文件时反复重启窗口。 */
function scheduleRestart(result: BuildResult): void {
  if (result.errors.length > 0 || shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(launchElectron, 180);
}

/** 创建 esbuild 插件，在每次成功编译后重新启动 Electron。 */
function createRestartPlugin(): Plugin {
  return {
    name: "restart-electron-after-build",
    setup(build) {
      build.onEnd(scheduleRestart);
    },
  };
}

/** 释放 watcher 和子进程，然后结束开发脚本。 */
async function shutdown(dispose: () => Promise<void>): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  stopElectronProcess();
  await dispose();
  process.exit(0);
}

/** 创建 Electron 主进程 watcher。 */
async function main(): Promise<void> {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const buildContext = await context({
    entryPoints: [
      path.join(rootDirectory, "electron", "main.ts"),
      path.join(rootDirectory, "electron", "preload.ts"),
    ],
    bundle: true,
    outdir: outputDirectory,
    platform: "node",
    target: "node20",
    format: "cjs",
    external: ["electron"],
    sourcemap: "inline",
    logLevel: "info",
    plugins: [createRestartPlugin()],
  });
  await buildContext.watch();
  console.log("[Electron 热更新] 正在监听 electron/*.ts");

  const dispose = async (): Promise<void> => buildContext.dispose();
  process.once("SIGINT", () => void shutdown(dispose));
  process.once("SIGTERM", () => void shutdown(dispose));
}

main().catch((error: unknown) => {
  console.error("Electron 热更新启动失败：", error);
  stopElectronProcess();
  process.exit(1);
});
