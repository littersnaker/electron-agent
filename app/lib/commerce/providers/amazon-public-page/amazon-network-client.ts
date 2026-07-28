/**
 * 模块职责：亚马逊请求节流、缓存、代理与网络容错。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import nodeFetch, { type RequestInit as NodeFetchRequestInit } from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { type AmazonPagePayload, type AmazonPageResponse, type CachedProxyAgent, DEFAULT_CACHE_TTL_MS, DEFAULT_REQUEST_INTERVAL_MS, DEFAULT_REQUEST_TIMEOUT_MS, MAX_HTTP_RETRIES, amazonCrawlerRuntimeState, assertUsableHtml, htmlCache, readBoundedInteger } from "./amazon-page-parser";
export function abortError(): Error {
  return new Error("Amazon 爬虫请求已取消。");
}

export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const handleAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
      reject(abortError());
    };

    timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

export async function waitForRequestSlot(signal?: AbortSignal): Promise<void> {
  const interval = readBoundedInteger(
    "AMAZON_CRAWLER_REQUEST_INTERVAL_MS",
    DEFAULT_REQUEST_INTERVAL_MS,
    250,
    10_000,
  );

  const scheduled = amazonCrawlerRuntimeState.requestStartQueue.then(async () => {
    const waitTime = Math.max(0, amazonCrawlerRuntimeState.lastRequestStartedAt + interval - Date.now());
    if (waitTime > 0) await sleep(waitTime, signal);
    if (signal?.aborted) throw abortError();
    amazonCrawlerRuntimeState.lastRequestStartedAt = Date.now();
  });

  amazonCrawlerRuntimeState.requestStartQueue = scheduled.catch(() => undefined);
  await scheduled;
}

export function createRequestSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parentSignal?.reason);
  const timeout = setTimeout(
    () => controller.abort(new Error("Amazon 爬虫请求超时。")),
    timeoutMs,
  );

  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

export function readCachedHtml(cacheKey: string): string | undefined {
  const cached = htmlCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    htmlCache.delete(cacheKey);
    return undefined;
  }
  return cached.html;
}

export function writeCachedHtml(cacheKey: string, html: string): void {
  const ttl = readBoundedInteger(
    "AMAZON_CRAWLER_CACHE_TTL_MS",
    DEFAULT_CACHE_TTL_MS,
    30_000,
    60 * 60 * 1_000,
  );

  if (htmlCache.size >= 120) {
    const firstKey = htmlCache.keys().next().value as string | undefined;
    if (firstKey) htmlCache.delete(firstKey);
  }
  htmlCache.set(cacheKey, { html, expiresAt: Date.now() + ttl });
}

export function matchesNoProxy(hostname: string): boolean {
  const rules = (process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",")
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean);
  const normalizedHost = hostname.toLowerCase();

  return rules.some((rule) => {
    if (rule === "*") return true;
    const hostRule = rule.split(":")[0]?.replace(/^\./u, "");
    return Boolean(
      hostRule &&
        (normalizedHost === hostRule || normalizedHost.endsWith(`.${hostRule}`)),
    );
  });
}

/**
 * Node.js 原生 fetch 不会自动使用 HTTP_PROXY / HTTPS_PROXY。
 * 桌面端和公司网络通常依赖这些变量出网，因此这里显式接入项目已有的
 * https-proxy-agent；代理地址只在服务端读取，绝不会写入报告或日志。
 */
export function resolveProxyAgent(url: URL): CachedProxyAgent | undefined {
  if (matchesNoProxy(url.hostname)) return undefined;

  const proxyUrl =
    process.env.AMAZON_CRAWLER_PROXY_URL?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim();
  if (!proxyUrl) return undefined;

  try {
    const parsed = new URL(proxyUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("代理协议必须是 http 或 https");
    }
  } catch {
    if (!amazonCrawlerRuntimeState.invalidProxyWarningPrinted) {
      amazonCrawlerRuntimeState.invalidProxyWarningPrinted = true;
      console.warn(
        "[Commerce/AmazonCrawler] 检测到代理变量，但格式无效；本轮改用直连。",
      );
    }
    return undefined;
  }

  if (amazonCrawlerRuntimeState.cachedProxyAgent?.proxyUrl === proxyUrl) return amazonCrawlerRuntimeState.cachedProxyAgent;
  amazonCrawlerRuntimeState.cachedProxyAgent = {
    proxyUrl,
    agent: new HttpsProxyAgent(proxyUrl, { keepAlive: true }),
  };
  return amazonCrawlerRuntimeState.cachedProxyAgent;
}

export function buildAmazonHeaders(url: URL, locale: string, currency: string): Record<string, string> {
  const normalizedLocale = locale.replace("_", "-");
  return {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": `${normalizedLocale},en;q=0.8`,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Referer: `https://${url.hostname}/`,
    "Upgrade-Insecure-Requests": "1",
    // 只写公开站点语言和币种偏好，不写账号 Cookie、登录态或设备指纹。
    Cookie: `lc-main=${locale}; i18n-prefs=${currency};`,
    "User-Agent":
      process.env.AMAZON_CRAWLER_USER_AGENT?.trim() ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  };
}

export async function requestAmazonPage(
  url: URL,
  locale: string,
  currency: string,
  signal: AbortSignal,
): Promise<{ response: AmazonPageResponse; usedProxy: boolean }> {
  const headers = buildAmazonHeaders(url, locale, currency);
  const proxy = resolveProxyAgent(url);

  if (proxy) {
    const requestInit: NodeFetchRequestInit = {
      headers,
      redirect: "follow",
      signal: signal as NodeFetchRequestInit["signal"],
      agent: proxy.agent,
    };
    const response = await nodeFetch(url.toString(), requestInit);
    return { response, usedProxy: true };
  }

  const response = await fetch(url, {
    headers,
    redirect: "follow",
    signal,
  });
  return { response, usedProxy: false };
}

export function formatNetworkFailure(error: unknown, usedProxy: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && "cause" in error
      ? (error.cause as { code?: unknown; message?: unknown } | undefined)
      : undefined;
  const causeCode = typeof cause?.code === "string" ? cause.code : undefined;
  const causeMessage =
    typeof cause?.message === "string" ? cause.message : undefined;
  const networkDetail = [causeCode, causeMessage, message]
    .filter(Boolean)
    .join(" / ");

  return `Amazon 页面网络请求失败${usedProxy ? "（已使用代理）" : "（直连）"}：${networkDetail}`;
}

export async function fetchHtml(
  url: URL,
  locale: string,
  currency: string,
  signal?: AbortSignal,
): Promise<AmazonPagePayload> {
  const cacheKey = url.toString();
  const cached = readCachedHtml(cacheKey);
  if (cached) {
    return {
      html: cached,
      finalUrl: cacheKey,
      status: 200,
      usedProxy: Boolean(resolveProxyAgent(url)),
    };
  }

  const timeoutMs = readBoundedInteger(
    "AMAZON_CRAWLER_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
    3_000,
    60_000,
  );

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt += 1) {
    await waitForRequestSlot(signal);
    const requestSignal = createRequestSignal(signal, timeoutMs);
    let usedProxy = false;

    try {
      const requestResult = await requestAmazonPage(
        url,
        locale,
        currency,
        requestSignal.signal,
      );
      const { response } = requestResult;
      usedProxy = requestResult.usedProxy;

      if (
        (response.status === 429 || response.status === 503) &&
        attempt < MAX_HTTP_RETRIES
      ) {
        lastError = new Error(`Amazon 暂时限流（HTTP ${response.status}）`);
        await sleep(2_000, signal);
        continue;
      }
      if (!response.ok) {
        throw new Error(
          `Amazon 公开页面请求失败（HTTP ${response.status} ${response.statusText}）`,
        );
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType && !/text\/html|application\/xhtml\+xml/iu.test(contentType)) {
        throw new Error(`Amazon 返回了非 HTML 内容（${contentType}）`);
      }

      const html = await response.text();
      assertUsableHtml(html, response.url || url.toString());
      writeCachedHtml(cacheKey, html);
      console.info(
        `[Commerce/AmazonCrawler] 页面获取成功：${url.hostname}${url.pathname}，HTTP ${response.status}，${usedProxy ? "代理" : "直连"}，${html.length} bytes。`,
      );
      return {
        html,
        finalUrl: response.url || url.toString(),
        status: response.status,
        usedProxy,
      };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_HTTP_RETRIES) {
        await sleep(1_500, signal);
        continue;
      }
      throw new Error(formatNetworkFailure(error, usedProxy), {
        cause: error,
      });
    } finally {
      requestSignal.cleanup();
    }
  }

  throw new Error(
    `Amazon 公开页面请求失败，重试后仍未取得页面内容：${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
