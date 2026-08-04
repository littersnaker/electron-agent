/**
 * 模块职责：隔离本地开发窗口、关闭 HTTP 磁盘缓存并清理旧 Renderer 缓存。
 *
 * 开发版与安装版使用不同的 Electron userData/单实例名称，因此托盘中仍在运行的
 * 安装版不会拦截 `pnpm dev`，也不会把安装版 Chromium 缓存带入本地调试。
 */
import { app, session } from "electron";
import path from "node:path";

const DEVELOPMENT_APP_NAME = "Multi-agent Dev";
const DEVELOPMENT_USER_DATA_DIRECTORY = "Multi-agent-dev-runtime";
export const DEVELOPMENT_SESSION_PARTITION = "multi-agent-dev-session";

/** 必须在 app.whenReady() 和 requestSingleInstanceLock() 之前调用。 */
export function configureDevelopmentProcess(): void {
  if (app.isPackaged) return;

  app.setName(DEVELOPMENT_APP_NAME);
  app.setPath(
    "userData",
    path.join(app.getPath("appData"), DEVELOPMENT_USER_DATA_DIRECTORY),
  );
  app.commandLine.appendSwitch("disable-http-cache");
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
}

/** 在每次开发窗口启动前清理 Chromium 内存/磁盘缓存。 */
export async function clearDevelopmentRendererCache(): Promise<void> {
  if (app.isPackaged) return;

  const developmentSession = session.fromPartition(
    DEVELOPMENT_SESSION_PARTITION,
    { cache: false },
  );
  await Promise.all([
    session.defaultSession.clearCache(),
    developmentSession.clearCache(),
    developmentSession.clearCodeCaches({}),
  ]);
  console.info("[Electron] 已清理开发 Renderer 缓存，并使用非持久化 Session");
}
