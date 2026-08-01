/**
 * 模块职责：为 Electron 主窗口选择 React 页面，并确认 Vite 已真正提供 HTTP 页面。
 *
 * 说明：开发模式不再依赖 Electron 主进程里的全局 fetch 探测 Vite。部分 Windows / Electron
 * 组合中，全局 fetch 可能因为运行时代理、实现差异或启动时序而持续返回失败，即使 5173
 * 端口已经正常监听。这里改用 Node 原生 http/https 请求，并保留 React 首屏渲染校验。
 */
import http from "node:http";
import https from "node:https";
import type { BrowserWindow } from "electron";
import { isDevelopmentMode } from "./backend-process";

interface RendererCandidate {
  label: string;
  url: string;
  waitForServer: boolean;
}

interface ServerProbeResult {
  reachable: boolean;
  detail: string;
}

interface RendererDocumentState {
  hasRoot: boolean;
  childCount: number;
  title: string;
}

const PREFLIGHT_REQUEST_TIMEOUT_MS = 1_500;
const DEVELOPMENT_SERVER_WAIT_MS = 30_000;
const RETRY_INTERVAL_MS = 300;
const REACT_RENDER_WAIT_MS = 10_000;

/** 删除末尾斜杠，便于候选地址去重。 */
function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

/** 为开发 URL 增加本次进程时间戳，防止 Chromium 复用旧导航响应。 */
function addDevelopmentCacheBuster(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}dev=${Date.now()}`;
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
    {
      label: "Vite 热更新页面",
      url: addDevelopmentCacheBuster(viteUrl),
      waitForServer: true,
    },
  ];

  // 只有开发者显式开启时才允许旧 dist 回退，默认绝不使用。
  if (process.env.ALLOW_DEV_DIST_FALLBACK === "1") {
    candidates.push({
      label: "FastAPI dist 手动回退页面",
      url: backendUrl,
      waitForServer: false,
    });
  }
  return candidates;
}

/** 暂停指定毫秒数，供 Vite 启动轮询和 React 首屏等待使用。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * 使用 Node 原生 HTTP 客户端探测页面。
 *
 * 只要目标返回任意正常 HTTP 状态码，就说明端口背后的 HTTP 服务已经准备好。最终是否为
 * 正确的 React 页面，会在 BrowserWindow 完成导航后再次检查，因此这里不把 404 当成断网。
 */
function probeHttpServer(url: string): Promise<ServerProbeResult> {
  return new Promise((resolve) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({ reachable: false, detail: `URL 格式错误：${message}` });
      return;
    }

    // 预检不需要携带缓存参数，直接请求同一路径即可。
    parsedUrl.search = "";
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const request = transport.request(
      parsedUrl,
      {
        method: "GET",
        headers: {
          Accept: "text/html,*/*",
          "Cache-Control": "no-cache, no-store",
          Pragma: "no-cache",
        },
      },
      (response) => {
        response.resume();
        resolve({
          reachable: true,
          detail: `HTTP ${response.statusCode ?? "未知"}`,
        });
      },
    );

    request.setTimeout(PREFLIGHT_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("HTTP 探测超时"));
    });
    request.once("error", (error) => {
      resolve({ reachable: false, detail: error.message });
    });
    request.end();
  });
}

/** 开发启动时等待 Vite 真正响应 HTTP，而不是只判断端口是否打开。 */
async function waitUntilReachable(url: string): Promise<ServerProbeResult> {
  const configured = Number(process.env.VITE_STARTUP_WAIT_MS);
  const waitMilliseconds =
    Number.isFinite(configured) && configured >= 0
      ? configured
      : DEVELOPMENT_SERVER_WAIT_MS;
  const deadline = Date.now() + waitMilliseconds;
  let latestResult: ServerProbeResult = {
    reachable: false,
    detail: "尚未开始探测",
  };

  do {
    latestResult = await probeHttpServer(url);
    if (latestResult.reachable) return latestResult;
    await delay(RETRY_INTERVAL_MS);
  } while (Date.now() < deadline);
  return latestResult;
}

/** 读取 React 根节点当前状态。 */
async function readRendererDocumentState(
  window: BrowserWindow,
): Promise<RendererDocumentState> {
  return window.webContents.executeJavaScript(
    `(() => {
      const root = document.getElementById("root");
      return {
        hasRoot: Boolean(root),
        childCount: root?.childElementCount || 0,
        title: document.title || "",
      };
    })()`,
    true,
  ) as Promise<RendererDocumentState>;
}

/** 等待 React 完成首次渲染，避免较慢电脑在固定 400ms 后被误判失败。 */
async function waitForRendererDocument(
  window: BrowserWindow,
): Promise<RendererDocumentState> {
  const deadline = Date.now() + REACT_RENDER_WAIT_MS;
  let state: RendererDocumentState = {
    hasRoot: false,
    childCount: 0,
    title: "",
  };

  do {
    state = await readRendererDocumentState(window);
    if (state.hasRoot && state.childCount > 0) return state;
    await delay(200);
  } while (Date.now() < deadline);
  return state;
}

/** 依次加载候选页面；全部失败时返回包含每次失败原因的异常。 */
export async function loadRendererPage(
  window: BrowserWindow,
  backendBaseUrl: string,
): Promise<string> {
  const failures: string[] = [];

  for (const candidate of createRendererCandidates(backendBaseUrl)) {
    if (candidate.waitForServer) {
      const probe = await waitUntilReachable(candidate.url);
      if (!probe.reachable) {
        // HTTP 预检只用于诊断，不能再次成为阻断页面加载的单点故障。Chromium 自己仍会
        // 尝试导航；这样即使 Node HTTP 在特殊代理环境中探测失败，也不会误报 Vite 未启动。
        failures.push(
          `${candidate.label} HTTP 预检未通过：${probe.detail}`,
        );
        console.warn(
          `[Electron] ${candidate.label} HTTP 预检未通过，将继续尝试 Chromium 导航：${probe.detail}`,
        );
      } else {
        console.info(
          `[Electron] ${candidate.label} HTTP 预检通过：${probe.detail}`,
        );
      }
    }

    try {
      await window.loadURL(candidate.url);
      const documentState = await waitForRendererDocument(window);
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

  const developmentHint = isDevelopmentMode()
    ? "开发模式禁止自动回退旧 dist。请确认 pnpm dev 中的 VITE 进程仍在运行。"
    : "请检查打包后的 frontend 资源。";
  throw new Error(
    [
      "React 页面加载失败。",
      developmentHint,
      ...failures.map((item) => `- ${item}`),
    ].join("\n"),
  );
}
