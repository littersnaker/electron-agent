/**
 * 模块职责：注册窗口控制、主题持久化、目录选择和电商报告 PDF 导出 IPC。
 */
import {
  BrowserWindow,
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
import {
  readSecureCredentials,
  writeSecureCredentials,
} from "./secure-credentials";

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
function senderWindow(
  event: IpcMainEvent | IpcMainInvokeEvent,
): BrowserWindow | null {
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

  const temporaryFile = path.join(
    os.tmpdir(),
    `multi-agent-commerce-${Date.now()}.html`,
  );
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

/** 注册网页层允许调用的全部 IPC 通道。 */
export function registerApplicationIpc(): void {
  ipcMain.on("window:minimize", (event) => senderWindow(event)?.minimize());
  ipcMain.on("window:close", (event) => senderWindow(event)?.close());
  ipcMain.handle("window:setTheme", (_event, theme: unknown) =>
    persistApplicationTheme(theme),
  );

  // 凭证只在主进程读写固定白名单文件，Renderer 无法传入任意路径。
  ipcMain.handle("credentials:read", () => readSecureCredentials());
  ipcMain.handle("credentials:write", (_event, input: unknown) =>
    writeSecureCredentials(input),
  );
  ipcMain.handle("preferences:read", () => readUiPreferences());
  ipcMain.handle("preferences:write", (_event, input: unknown) =>
    writeUiPreferences(input),
  );

  ipcMain.handle(
    "window:isMaximized",
    (event) => senderWindow(event)?.isMaximized() ?? false,
  );
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
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle("commerce:exportPdf", async (event, payload: unknown) => {
    if (!isCommercePdfPayload(payload)) throw new Error("PDF 导出参数无效");
    return exportCommercePdf(senderWindow(event), payload);
  });
}
