/**
 * 模块职责：请求节流、代理、缓存、请求头和页面抓取。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import nodeFetch, { type RequestInit as NodeFetchRequestInit } from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { readBoundedInteger, stripTags } from "./product-parsers";
import { type CachedProxyAgent, DEFAULT_CACHE_TTL_MS, DEFAULT_REQUEST_INTERVAL_MS, DEFAULT_REQUEST_TIMEOUT_MS, type HtmlCacheEntry, MAX_HTTP_RETRIES, type PlatformCrawlerDefinition, type PlatformPagePayload, crawlerRequestState, htmlCache, invalidProxyWarnings, proxyAgents } from "./crawler-definitions";
export function abortError(): Error {
  const error = new Error("平台爬虫请求已取消。");
  error.name = "AbortError";
  return error;
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
    "COMMERCE_CRAWLER_REQUEST_INTERVAL_MS",
    DEFAULT_REQUEST_INTERVAL_MS,
    250,
    15_000,
  );
  const scheduled = crawlerRequestState.requestStartQueue.then(async () => {
    const waitTime = Math.max(0, crawlerRequestState.lastRequestStartedAt + interval - Date.now());
    if (waitTime > 0) await sleep(waitTime, signal);
    if (signal?.aborted) throw abortError();
    crawlerRequestState.lastRequestStartedAt = Date.now();
  });
  crawlerRequestState.requestStartQueue = scheduled.catch(() => undefined);
  await scheduled;
}

export function createRequestSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(parentSignal?.reason);
  const timeout = setTimeout(
    () => controller.abort(new Error(`${label} 爬虫请求超时。`)),
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
        (normalizedHost === hostRule ||
          normalizedHost.endsWith(`.${hostRule}`)),
    );
  });
}

export function resolvePlatformCrawlerProxyUrl(
  url: URL,
  definition: PlatformCrawlerDefinition,
): string | undefined {
  if (matchesNoProxy(url.hostname)) return undefined;

  return (
    process.env[definition.proxyEnvironmentName]?.trim() ||
    process.env.COMMERCE_CRAWLER_PROXY_URL?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.https_proxy?.trim() ||
    process.env.HTTP_PROXY?.trim() ||
    process.env.http_proxy?.trim() ||
    undefined
  );
}

export function resolveProxyAgent(
  url: URL,
  definition: PlatformCrawlerDefinition,
): CachedProxyAgent | undefined {
  const proxyUrl = resolvePlatformCrawlerProxyUrl(url, definition);
  if (!proxyUrl) return undefined;

  try {
    const parsed = new URL(proxyUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("代理协议必须是 http 或 https");
    }
  } catch {
    if (!invalidProxyWarnings.has(definition.sourceId)) {
      invalidProxyWarnings.add(definition.sourceId);
      console.warn(
        `[Commerce/${definition.label}Crawler] 代理地址格式无效，本轮改用直连。`,
      );
    }
    return undefined;
  }

  const cacheKey = `${definition.sourceId}:${proxyUrl}`;
  const cached = proxyAgents.get(cacheKey);
  if (cached) return cached;
  const created = {
    proxyUrl,
    agent: new HttpsProxyAgent(proxyUrl, { keepAlive: true }),
  };
  proxyAgents.set(cacheKey, created);
  return created;
}

export function resolvePlatformCrawlerUserAgent(
  definition: PlatformCrawlerDefinition,
): string {
  return (
    process.env[definition.userAgentEnvironmentName]?.trim() ||
    process.env.COMMERCE_CRAWLER_USER_AGENT?.trim() ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  );
}

export function buildHeaders(
  url: URL,
  definition: PlatformCrawlerDefinition,
  locale: string,
): Record<string, string> {
  const normalizedLocale = locale.replace("_", "-");
  return {
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": `${normalizedLocale},en;q=0.8,zh-CN;q=0.6`,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Referer: `https://${url.hostname}/`,
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": resolvePlatformCrawlerUserAgent(definition),
  };
}

export function readCachedPage(cacheKey: string): HtmlCacheEntry | undefined {
  const cached = htmlCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    htmlCache.delete(cacheKey);
    return undefined;
  }
  return cached;
}

export function writeCachedPage(
  cacheKey: string,
  html: string,
  finalUrl: string,
): void {
  const ttl = readBoundedInteger(
    "COMMERCE_CRAWLER_CACHE_TTL_MS",
    DEFAULT_CACHE_TTL_MS,
    30_000,
    60 * 60 * 1_000,
  );
  if (htmlCache.size >= 180) {
    const firstKey = htmlCache.keys().next().value as string | undefined;
    if (firstKey) htmlCache.delete(firstKey);
  }
  htmlCache.set(cacheKey, {
    html,
    finalUrl,
    expiresAt: Date.now() + ttl,
  });
}

export function assertPlatformPageUsable(
  html: string,
  finalUrl: string,
  definition: PlatformCrawlerDefinition,
): void {
  if (!html.trim()) throw new Error(`${definition.label} 返回了空页面。`);
  const normalized = `${finalUrl}\n${stripTags(html).slice(0, 20_000)}`;
  if (definition.robotPatterns.some((pattern) => pattern.test(normalized))) {
    throw new Error(
      `${definition.label} 返回了风控、验证码或访问限制页。爬虫不会绕过验证，请降低频率、使用合规网络出口或配置 API。`,
    );
  }
  if (/\/login|\/signin|passport/iu.test(finalUrl)) {
    throw new Error(
      `${definition.label} 将公开搜索页重定向到登录页，当前网络无法匿名采集。`,
    );
  }
}

export function formatNetworkFailure(
  error: unknown,
  definition: PlatformCrawlerDefinition,
  usedProxy: boolean,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && "cause" in error
      ? (error.cause as { code?: unknown; message?: unknown } | undefined)
      : undefined;
  const details = [
    typeof cause?.code === "string" ? cause.code : undefined,
    typeof cause?.message === "string" ? cause.message : undefined,
    message,
  ]
    .filter(Boolean)
    .join(" / ");
  return `${definition.label} 页面网络请求失败${usedProxy ? "（已使用代理）" : "（直连）"}：${details}`;
}

export async function fetchPlatformPage(
  url: URL,
  definition: PlatformCrawlerDefinition,
  locale: string,
  signal?: AbortSignal,
): Promise<PlatformPagePayload> {
  const cacheKey = `${definition.sourceId}:${url.toString()}`;
  const cached = readCachedPage(cacheKey);
  if (cached) {
    return {
      html: cached.html,
      finalUrl: cached.finalUrl,
      status: 200,
      usedProxy: Boolean(resolveProxyAgent(url, definition)),
    };
  }

  const timeoutMs = readBoundedInteger(
    "COMMERCE_CRAWLER_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
    3_000,
    60_000,
  );
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_HTTP_RETRIES; attempt += 1) {
    await waitForRequestSlot(signal);
    const requestSignal = createRequestSignal(
      signal,
      timeoutMs,
      definition.label,
    );
    const proxy = resolveProxyAgent(url, definition);
    const usedProxy = Boolean(proxy);

    try {
      const headers = buildHeaders(url, definition, locale);
      const response = proxy
        ? await nodeFetch(url.toString(), {
            headers,
            redirect: "follow",
            signal: requestSignal.signal as NodeFetchRequestInit["signal"],
            agent: proxy.agent,
          })
        : await fetch(url, {
            headers,
            redirect: "follow",
            signal: requestSignal.signal,
          });
      const html = await response.text();
      const finalUrl = response.url || url.toString();

      if (!response.ok) {
        throw new Error(
          `${definition.label} 返回 HTTP ${response.status} ${response.statusText}`,
        );
      }
      assertPlatformPageUsable(html, finalUrl, definition);
      writeCachedPage(cacheKey, html, finalUrl);
      return {
        html,
        finalUrl,
        status: response.status,
        usedProxy,
      };
    } catch (error) {
      lastError = new Error(
        formatNetworkFailure(error, definition, usedProxy),
      );
      if (attempt < MAX_HTTP_RETRIES) await sleep(700, signal);
    } finally {
      requestSignal.cleanup();
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${definition.label} 页面请求失败。`);
}
