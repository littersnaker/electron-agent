/**
 * 模块职责：仅回环的浏览器自动化控制服务，供 Python 后端 browser.* 工具驱动隐藏浏览器窗口。
 *
 * 安全边界：只绑定 127.0.0.1；每个请求校验 Bearer token（每次应用启动随机生成）；
 * 自动化窗口为沙箱 + 独立非持久会话（与主窗口登录态/凭证完全隔离），且没有 preload。
 * 地址与 token 通过两条通道交给 Python：buildBackendEnvironment 的 env 注入（打包 spawn
 * 模式）与 automation-endpoint.json 端点文件（dev 模式 concurrently 直启后端的场景）。
 */
import { app, BrowserWindow } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { getStableDataPath } from "./data-paths";
import { SERVER_HOST } from "./server-port";

const ENDPOINT_FILE_NAME = "automation-endpoint.json";
const MAX_BODY_BYTES = 512 * 1024;
/** navigate 最长等待；页面死循环加载时兜底返回超时错误。 */
const NAVIGATE_TIMEOUT_MS = 60_000;
const ACTION_TIMEOUT_MS = 30_000;
const LOAD_SETTLE_MS = 800;
const SCREENSHOT_MAX_WIDTH = 1280;
const EXTRACT_MAX_CHARS = 20_000;

interface AutomationEndpoint {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

let server: http.Server | null = null;
let automationToken = "";
let automationWindow: BrowserWindow | null = null;

/** 带超时的 Promise 竞速；超时抛出可读错误。 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 懒创建并复用常驻自动化窗口；渲染进程崩溃后下次调用自动重建。 */
function ensureAutomationWindow(): BrowserWindow {
  if (automationWindow && !automationWindow.isDestroyed()) return automationWindow;
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 独立非持久会话：自动化窗口不共享主窗口的 Cookie 与登录态。
      partition: "automation",
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("render-process-gone", () => {
    console.warn("[Electron] 自动化窗口渲染进程退出，窗口已重置");
    if (automationWindow && !automationWindow.isDestroyed()) automationWindow.destroy();
    automationWindow = null;
  });
  automationWindow = window;
  return window;
}

/** 等页面渲染完成并留出懒加载稳定时间（与视觉截图链路同一经验值）。 */
async function settleAfterLoad(webContents: Electron.WebContents): Promise<void> {
  await webContents.executeJavaScript("document.readyState === 'complete' || true");
  await new Promise((resolve) => setTimeout(resolve, LOAD_SETTLE_MS));
}

/** 读取页面正文文本（截断），navigate 与 extract 共用。 */
async function extractPageText(
  webContents: Electron.WebContents,
  selector: string,
): Promise<{ count: number; text: string }> {
  const script = `
    (() => {
      const selector = ${JSON.stringify(selector)};
      if (selector) {
        const elements = Array.from(document.querySelectorAll(selector)).slice(0, 50);
        return { count: elements.length, text: elements.map((el) => el.innerText || "").join("\\n") };
      }
      return { count: 1, text: document.body ? document.body.innerText : "" };
    })()
  `;
  const result = (await webContents.executeJavaScript(script)) as { count?: number; text?: string };
  return {
    count: Number(result?.count) || 0,
    text: String(result?.text ?? "").slice(0, EXTRACT_MAX_CHARS),
  };
}

/** 打开 URL：校验协议、加载、稳定，返回标题与正文预览。 */
async function actionNavigate(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = String(payload.url ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "URL 无法解析" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "只允许 http/https 地址" };
  }
  const window = ensureAutomationWindow();
  try {
    await withTimeout(window.loadURL(url), NAVIGATE_TIMEOUT_MS, "页面加载");
    await settleAfterLoad(window.webContents);
    const { text } = await extractPageText(window.webContents, "");
    return {
      ok: true,
      url: window.webContents.getURL(),
      title: window.webContents.getTitle(),
      textLength: text.length,
      text,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 抽取页面或指定元素的可见文本。 */
async function actionExtract(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const selector = String(payload.selector ?? "").trim();
  const window = ensureAutomationWindow();
  if (!window.webContents.getURL()) return { ok: false, error: "尚未打开任何页面，请先 navigate" };
  try {
    const { count, text } = await withTimeout(
      extractPageText(window.webContents, selector),
      ACTION_TIMEOUT_MS,
      "文本抽取",
    );
    return { ok: true, count, textLength: text.length, text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 点击目标：CSS 选择器优先，其次按可见文本在可交互元素中匹配。 */
async function actionClick(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const selector = String(payload.selector ?? "").trim();
  const text = String(payload.text ?? "").trim();
  if (!selector && !text) return { ok: false, error: "必须提供 selector 或 text 之一" };
  const window = ensureAutomationWindow();
  const script = `
    (() => {
      const selector = ${JSON.stringify(selector)};
      const text = ${JSON.stringify(text)};
      let element = null;
      if (selector) {
        try { element = document.querySelector(selector); } catch { return { ok: false, error: "选择器语法无效" }; }
      }
      if (!element && text) {
        const candidates = Array.from(
          document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"],summary,li,span,div'),
        );
        element =
          candidates.find((el) => ((el.innerText || el.value || "") + "").trim().includes(text)) ?? null;
      }
      if (!element) return { ok: false, error: "未找到目标元素" };
      element.scrollIntoView({ block: "center" });
      const label = ((element.innerText || element.value || "") + "").trim().slice(0, 80);
      element.click();
      return { ok: true, clicked: element.tagName.toLowerCase() + (label ? ' "' + label + '"' : "") };
    })()
  `;
  try {
    const result = (await withTimeout(
      window.webContents.executeJavaScript(script),
      ACTION_TIMEOUT_MS,
      "点击",
    )) as Record<string, unknown>;
    return result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 填充输入框：React 受控组件需要走原生 value setter 再派发 input/change。 */
async function actionFill(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const selector = String(payload.selector ?? "").trim();
  const value = String(payload.value ?? "");
  if (!selector) return { ok: false, error: "必须提供 selector" };
  const window = ensureAutomationWindow();
  const script = `
    (() => {
      const selector = ${JSON.stringify(selector)};
      const value = ${JSON.stringify(value)};
      let element = null;
      try { element = document.querySelector(selector); } catch { return { ok: false, error: "选择器语法无效" }; }
      if (!element) return { ok: false, error: "未找到目标输入框" };
      element.scrollIntoView({ block: "center" });
      element.focus();
      const prototype =
        element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor && descriptor.set) descriptor.set.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, filled: element.tagName.toLowerCase() };
    })()
  `;
  try {
    const result = (await withTimeout(
      window.webContents.executeJavaScript(script),
      ACTION_TIMEOUT_MS,
      "填充",
    )) as Record<string, unknown>;
    return result;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 截图：capturePage 后按宽度上限降采样，返回 JPEG base64 控制体积。 */
async function actionScreenshot(
  _payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const window = ensureAutomationWindow();
  if (!window.webContents.getURL()) return { ok: false, error: "尚未打开任何页面，请先 navigate" };
  try {
    const image = await withTimeout(window.webContents.capturePage(), ACTION_TIMEOUT_MS, "截图");
    const width = image.getSize().width;
    const scaled =
      width > SCREENSHOT_MAX_WIDTH ? image.resize({ width: SCREENSHOT_MAX_WIDTH }) : image;
    const jpeg = scaled.toJPEG(80);
    return {
      ok: true,
      url: window.webContents.getURL(),
      width: scaled.getSize().width,
      height: scaled.getSize().height,
      imageBase64: jpeg.toString("base64"),
      mimeType: "image/jpeg",
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** timing-safe 比较 Bearer token，避免逐字符短路泄露。 */
function tokenMatches(candidate: string): boolean {
  const expected = Buffer.from(automationToken, "utf8");
  const provided = Buffer.from(candidate, "utf8");
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

/** 读取请求体（限制大小）并解析 JSON。 */
function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("请求体超过大小上限"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

/** 写端点文件（0600）：固定数据目录必写；开发模式再写项目根，覆盖 concurrently 直启后端。 */
function writeEndpointFiles(endpoint: AutomationEndpoint): void {
  const payload = JSON.stringify(endpoint, null, 2);
  const targets = [getStableDataPath(ENDPOINT_FILE_NAME)];
  if (!app.isPackaged) targets.push(path.join(process.cwd(), ENDPOINT_FILE_NAME));
  for (const target of targets) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, payload, { mode: 0o600 });
      fs.chmodSync(target, 0o600);
    } catch (error) {
      console.warn(`[Electron] 自动化端点文件写入失败：${target}`, error);
    }
  }
}

/** 移除端点文件，避免残留失效地址被误读。 */
function removeEndpointFiles(): void {
  const targets = [getStableDataPath(ENDPOINT_FILE_NAME)];
  if (!app.isPackaged) targets.push(path.join(process.cwd(), ENDPOINT_FILE_NAME));
  for (const target of targets) {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      // 清理失败不影响退出。
    }
  }
}

/** 启动自动化控制服务（幂等）；解析端口后写入端点文件。 */
export function startAutomationServer(): void {
  if (server) return;
  automationToken = crypto.randomBytes(32).toString("base64url");

  const requestHandler = async (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> => {
    const send = (status: number, body: Record<string, unknown>): void => {
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify(body));
    };
    try {
      const authorization = String(request.headers.authorization ?? "");
      const candidate = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!automationToken || !tokenMatches(candidate)) {
        send(401, { ok: false, error: "未授权" });
        return;
      }
      const route = (request.url ?? "").split("?")[0];
      const handlers: Record<
        string,
        (payload: Record<string, unknown>) => Promise<Record<string, unknown>>
      > = {
        "/navigate": actionNavigate,
        "/extract": actionExtract,
        "/click": actionClick,
        "/fill": actionFill,
        "/screenshot": actionScreenshot,
      };
      const handler = handlers[route];
      if (request.method !== "POST" || !handler) {
        send(404, { ok: false, error: "未知动作" });
        return;
      }
      const payload = await readJsonBody(request);
      const result = await handler(payload);
      send(200, result);
    } catch (error) {
      send(200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  server = http.createServer((request, response) => {
    void requestHandler(request, response);
  });
  server.on("error", (error) => {
    console.error("[Electron] 自动化控制服务异常", error);
  });
  server.listen(0, SERVER_HOST, () => {
    const address = server?.address();
    const port = typeof address === "object" && address ? address.port : 0;
    if (!port) {
      console.error("[Electron] 自动化控制服务未能解析端口");
      return;
    }
    const endpoint: AutomationEndpoint = {
      port,
      token: automationToken,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    writeEndpointFiles(endpoint);
    console.info(`[Electron] 自动化控制服务已启动：http://${SERVER_HOST}:${port}`);
  });
}

/** 停止服务、销毁自动化窗口并清理端点文件。 */
export function stopAutomationServer(): void {
  if (server) {
    server.close();
    server = null;
  }
  if (automationWindow && !automationWindow.isDestroyed()) automationWindow.destroy();
  automationWindow = null;
  removeEndpointFiles();
}

/** 供 buildBackendEnvironment 注入 env；服务未启动时返回 undefined。 */
export function getAutomationEnvironment(): Record<string, string> | undefined {
  const address = server?.address();
  if (!server || typeof address !== "object" || !address?.port) return undefined;
  return {
    AUTOMATION_HTTP_PORT: String(address.port),
    AUTOMATION_HTTP_TOKEN: automationToken,
  };
}
