/**
 * 模块职责：注册窗口控制、主题持久化、目录选择和电商报告 PDF 导出 IPC。
 */
import {
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isAppTheme,
  readUiPreferences,
  writeCachedTheme,
  writeThemeToBackend,
  writeUiPreferences,
} from "./app-preferences";
import { readSecureCredentials, writeSecureCredentials } from "./secure-credentials";

interface CommercePdfPayload {
  html: string;
  suggestedFileName: string;
}

let activeBackendBaseUrl = "";

/** 保存当前 FastAPI 地址，供主题 IPC 同步写入 SQLite。 */
export function setApplicationBackendBaseUrl(baseUrl: string): void {
  activeBackendBaseUrl = baseUrl.trim().replace(/\/+$/u, "");
}

/** 根据 IPC 事件找到发送消息的 BrowserWindow。 */
function senderWindow(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

/** 判断前端传来的 PDF 参数是否完整且大小合理。 */
function isCommercePdfPayload(value: unknown): value is CommercePdfPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<CommercePdfPayload>;
  return (
    typeof payload.html === "string" &&
    payload.html.length > 0 &&
    payload.html.length <= 5_000_000 &&
    typeof payload.suggestedFileName === "string" &&
    payload.suggestedFileName.length > 0
  );
}

/** 使用隐藏窗口把打印 HTML 转换成 PDF 文件。 */
async function exportCommercePdf(
  parent: BrowserWindow | null,
  payload: CommercePdfPayload,
): Promise<{ canceled: boolean; filePath?: string }> {
  const options: SaveDialogOptions = {
    title: "导出市场研究报告 PDF",
    defaultPath: payload.suggestedFileName.endsWith(".pdf")
      ? payload.suggestedFileName
      : `${payload.suggestedFileName}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  };
  const saveResult = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options);
  if (saveResult.canceled || !saveResult.filePath) return { canceled: true };

  const temporaryFile = path.join(os.tmpdir(), `multi-agent-commerce-${Date.now()}.html`);
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true },
  });
  try {
    await fs.writeFile(temporaryFile, payload.html, "utf8");
    await printWindow.loadFile(temporaryFile);
    const pdfBuffer = await printWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    });
    await fs.writeFile(saveResult.filePath, pdfBuffer);
    return { canceled: false, filePath: saveResult.filePath };
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
    await fs.rm(temporaryFile, { force: true });
  }
}

/** 同步 Electron 原生主题、启动缓存和 SQLite 偏好表。 */
async function persistApplicationTheme(theme: unknown): Promise<string> {
  if (!isAppTheme(theme)) throw new Error("不支持的主题值");

  nativeTheme.themeSource = theme;
  writeCachedTheme(theme);
  if (activeBackendBaseUrl) {
    try {
      await writeThemeToBackend(activeBackendBaseUrl, theme);
    } catch (error) {
      console.warn("[Electron] 主题已缓存，但写入 SQLite 失败", error);
    }
  }
  return theme;
}

/** 判断前端传来的截图 URL 是否只指向本机 localhost。 */
function isLocalPreviewUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

/** 单次滚动截图的默认帧数上限（与视觉模型单请求图片上限保持余量）。 */
const MAX_SCROLL_FRAMES = 6;
/** 每帧滚动后等待双 rAF 之外的固定余量，让懒加载图片和字体完成渲染。 */
const SCROLL_SETTLE_MS = 250;
/** 首屏加载后的稳定等待，沿用原单帧截图的经验值。 */
const LOAD_SETTLE_MS = 800;

/** 一帧滚动截图：PNG Base64 与该帧顶部的页面纵偏移。 */
interface ScrollFrame {
  base64: string;
  offsetTop: number;
}

/** 在页面内滚动到指定纵偏移，并等浏览器完成两帧绘制（懒加载触发后再稳定）。 */
async function scrollToOffset(webContents: Electron.WebContents, offsetTop: number): Promise<void> {
  await webContents.executeJavaScript(`window.scrollTo(0, ${Math.max(0, Math.floor(offsetTop))})`);
  await webContents.executeJavaScript(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  await new Promise((resolve) => setTimeout(resolve, SCROLL_SETTLE_MS));
}

/**
 * 用隐藏窗口加载本地 URL，按视口高度自动滚动逐帧截图，返回全部 PNG Base64（不落盘）。
 * 仅允许 localhost 地址，避免渲染任意外部页面；页面不足一屏时只返回一帧。
 */
async function captureLocalPageScroll(
  url: string,
  maxFrames: number,
): Promise<{ frames: ScrollFrame[]; pageHeight: number; viewportHeight: number }> {
  const captureWindow = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { sandbox: true },
  });
  try {
    const webContents = captureWindow.webContents;
    await captureWindow.loadURL(url);
    // 等首屏渲染完成后再等稳定帧，避免截到加载中状态。
    await webContents.executeJavaScript("document.readyState === 'complete' || true");
    await new Promise((resolve) => setTimeout(resolve, LOAD_SETTLE_MS));

    const pageHeight = Number(
      await webContents.executeJavaScript(
        "Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)",
      ),
    );
    const viewportHeight = Number(await webContents.executeJavaScript("window.innerHeight"));
    const frameHeight = Math.max(1, Math.min(viewportHeight || 900, pageHeight || 900));
    const totalFrames = Math.max(1, Math.min(maxFrames, Math.ceil(pageHeight / frameHeight)));

    const frames: ScrollFrame[] = [];
    for (let index = 0; index < totalFrames; index += 1) {
      const offsetTop = Math.min(index * frameHeight, Math.max(0, pageHeight - frameHeight));
      // 相邻帧偏移不足半屏说明已无法继续下滚，避免重复截同一屏。
      if (index > 0 && offsetTop - frames[index - 1].offsetTop < frameHeight / 2) break;
      await scrollToOffset(webContents, offsetTop);
      const image = await webContents.capturePage();
      frames.push({ base64: image.toPNG().toString("base64"), offsetTop });
    }
    await scrollToOffset(webContents, 0);
    return { frames, pageHeight, viewportHeight: frameHeight };
  } finally {
    if (!captureWindow.isDestroyed()) captureWindow.destroy();
  }
}

/** 注册网页层允许调用的全部 IPC 通道。 */
export function registerApplicationIpc(): void {
  ipcMain.on("window:minimize", (event) => senderWindow(event)?.minimize());
  ipcMain.on("window:close", (event) => senderWindow(event)?.close());
  ipcMain.handle("window:setTheme", (_event, theme: unknown) => persistApplicationTheme(theme));

  // 凭证只在主进程读写固定白名单文件，Renderer 无法传入任意路径。
  ipcMain.handle("credentials:read", () => readSecureCredentials());
  ipcMain.handle("credentials:write", (_event, input: unknown) => writeSecureCredentials(input));
  ipcMain.handle("preferences:read", () => readUiPreferences());
  ipcMain.handle("preferences:write", (_event, input: unknown) => writeUiPreferences(input));
  ipcMain.handle("clipboard:readText", () => clipboard.readText());
  ipcMain.handle("clipboard:writeText", (_event, text: unknown) => {
    clipboard.writeText(String(text ?? ""));
  });

  ipcMain.handle("window:isMaximized", (event) => senderWindow(event)?.isMaximized() ?? false);
  ipcMain.handle("window:toggleMaximize", (event) => {
    const window = senderWindow(event);
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });

  ipcMain.handle("dialog:openDirectory", async (event) => {
    const parent = senderWindow(event);
    const options: OpenDialogOptions = {
      title: "选择项目工作目录",
      properties: ["openDirectory"],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("commerce:exportPdf", async (event, payload: unknown) => {
    if (!isCommercePdfPayload(payload)) throw new Error("PDF 导出参数无效");
    return exportCommercePdf(senderWindow(event), payload);
  });

  ipcMain.handle("visual:capturePageScroll", async (_event, url: unknown, maxFrames: unknown) => {
    if (!isLocalPreviewUrl(url)) throw new Error("只允许截取 localhost 页面");
    const limit =
      typeof maxFrames === "number" && Number.isFinite(maxFrames)
        ? Math.max(1, Math.min(Math.floor(maxFrames), 12))
        : MAX_SCROLL_FRAMES;
    return captureLocalPageScroll(url, limit);
  });
}
