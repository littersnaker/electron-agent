/**
 * 模块职责：为 Electron 主窗口选择可访问的 React 页面，并在开发服务器缺失时回退。
 */
import type { BrowserWindow } from "electron";
import { isDevelopmentMode } from "./backend-process";

interface RendererCandidate {
  label: string;
  url: string;
  waitForServer: boolean;
}

const PREFLIGHT_REQUEST_TIMEOUT_MS = 1_200;
const DEVELOPMENT_SERVER_WAIT_MS = 12_000;
const RETRY_INTERVAL_MS = 250;

/** 删除末尾斜杠，便于候选地址去重。 */
function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

/** 返回开发环境和生产环境应尝试的页面地址。 */
function createRendererCandidates(backendBaseUrl: string): RendererCandidate[] {
  const backendUrl = normalizeUrl(backendBaseUrl);
  if (!isDevelopmentMode()) {
    return [{ label: "FastAPI 静态前端", url: backendUrl, waitForServer: false }];
  }

  const viteUrl = normalizeUrl(
    process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173",
  );
  const candidates: RendererCandidate[] = [
    { label: "Vite 开发服务器", url: viteUrl, waitForServer: true },
    { label: "FastAPI dist 回退页面", url: backendUrl, waitForServer: false },
  ];

  return candidates.filter(
    (candidate, index) =>
      candidates.findIndex((item) => item.url === candidate.url) === index,
  );
}

/** 暂停指定毫秒数，供 Vite 启动轮询使用。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 对一个页面执行短超时 HTTP 探测。 */
async function isReachable(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    PREFLIGHT_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/** 开发启动时等待 Vite 真正监听，避免过早回退到旧 dist。 */
async function waitUntilReachable(url: string): Promise<boolean> {
  const configured = Number(process.env.VITE_STARTUP_WAIT_MS);
  const waitMilliseconds = Number.isFinite(configured) && configured >= 0
    ? configured
    : DEVELOPMENT_SERVER_WAIT_MS;
  const deadline = Date.now() + waitMilliseconds;

  do {
    if (await isReachable(url)) return true;
    await delay(RETRY_INTERVAL_MS);
  } while (Date.now() < deadline);
  return false;
}

interface RendererDocumentState {
  hasRoot: boolean;
  childCount: number;
  title: string;
}

/** 确认 URL 返回的是已经完成 React 首次渲染的页面，而不是 404 或空文档。 */
async function verifyRendererDocument(
  window: BrowserWindow,
): Promise<RendererDocumentState> {
  return window.webContents.executeJavaScript(
    `new Promise((resolve) => setTimeout(() => {
      const root = document.getElementById("root");
      resolve({
        hasRoot: Boolean(root),
        childCount: root?.childElementCount || 0,
        title: document.title || "",
      });
    }, 400))`,
    true,
  ) as Promise<RendererDocumentState>;
}

/** 依次加载候选页面；全部失败时返回包含每次失败原因的异常。 */
export async function loadRendererPage(
  window: BrowserWindow,
  backendBaseUrl: string,
): Promise<string> {
  const failures: string[] = [];

  for (const candidate of createRendererCandidates(backendBaseUrl)) {
    if (candidate.waitForServer && !(await waitUntilReachable(candidate.url))) {
      failures.push(`${candidate.label} ${candidate.url} 在等待期内未监听`);
      console.warn(
        `[Electron] ${candidate.label} 未启动，将使用 FastAPI dist。源码修改需先执行 pnpm build。`,
      );
      continue;
    }

    try {
      await window.loadURL(candidate.url);
      const documentState = await verifyRendererDocument(window);
      if (!documentState.hasRoot || documentState.childCount === 0) {
        throw new Error(
          `页面未完成 React 渲染（title=${documentState.title || "无"}）`,
        );
      }
      console.info(`[Electron] 已加载 ${candidate.label}：${candidate.url}`);
      return candidate.url;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${candidate.label} ${candidate.url}：${message}`);
      console.warn(`[Electron] ${candidate.label} 加载失败`, error);
    }
  }

  throw new Error(
    ["React 页面加载失败。", ...failures.map((item) => `- ${item}`)].join(
      "\n",
    ),
  );
}
