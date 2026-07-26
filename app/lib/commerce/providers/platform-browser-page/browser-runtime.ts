/**
 * 模块职责：浏览器并发控制、代理解析和 Playwright 启动。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page, type Response } from "playwright-core";
import type { CommerceProductSignal } from "../../types";
import { parsePlatformJsonPayload, resolvePlatformCrawlerUserAgent, type PlatformCrawlerDefinition } from "../platform-public-page";
export interface BrowserPageResult {
  products: CommerceProductSignal[];
  warning: string;
}

export interface BrowserLaunchResult {
  browser: Browser;
  method: string;
}

export interface PlaywrightProxySettings {
  server: string;
  username?: string;
  password?: string;
}

export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

export const DEFAULT_SETTLE_TIME_MS = 2_500;

export const DEFAULT_SCROLL_STEPS = 3;

export const DEFAULT_MAX_JSON_RESPONSES = 100;

export const DEFAULT_MAX_JSON_BYTES = 5 * 1024 * 1024;

export const DEFAULT_BROWSER_CONCURRENCY = 1;

/**
 * Playwright 浏览器任务信号量。
 *
 * Commerce Orchestrator 会并行执行 TikTok Shop、Temu 和 1688。如果不限制浏览器并发，
 * 开发机或 Electron 进程可能会同时启动多个 Chromium，造成内存瞬时升高和页面互相抢占网络。
 */
export class BrowserSemaphore {
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];

  async acquire(maximum: number): Promise<() => void> {
    if (this.activeCount >= maximum) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.activeCount += 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.waiters.shift()?.();
    };
  }
}

export const browserSemaphore = new BrowserSemaphore();

export function readBoundedInteger(
  environmentName: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[environmentName]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

export function readBoolean(environmentName: string, fallback: boolean): boolean {
  const raw = process.env[environmentName]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["false", "0", "off", "no"].includes(raw)) return false;
  if (["true", "1", "on", "yes"].includes(raw)) return true;
  return fallback;
}

export function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim().slice(0, 700);
}

export function safeProxyLabel(proxyUrl: string | undefined): string {
  if (!proxyUrl) return "直连";
  try {
    const parsed = new URL(proxyUrl);
    return `代理 ${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    return "代理（地址格式无效）";
  }
}

export function parsePlaywrightProxy(
  proxyUrl: string | undefined,
): PlaywrightProxySettings | undefined {
  if (!proxyUrl) return undefined;
  const parsed = new URL(proxyUrl);
  if (!["http:", "https:", "socks5:"].includes(parsed.protocol)) {
    throw new Error("Playwright 代理仅支持 http、https 或 socks5 协议。");
  }

  return {
    server: `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  };
}

export function parseJsonSafely(value: string): unknown | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;

  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    // 部分接口返回 JSONP 或在 JSON 前后附加安全前缀。这里只截取首尾明确的对象/数组，
    // 不执行任何返回脚本，避免把网络响应变成任意代码执行入口。
    const objectStart = normalized.indexOf("{");
    const arrayStart = normalized.indexOf("[");
    const start =
      objectStart < 0
        ? arrayStart
        : arrayStart < 0
          ? objectStart
          : Math.min(objectStart, arrayStart);
    const end = Math.max(
      normalized.lastIndexOf("}"),
      normalized.lastIndexOf("]"),
    );
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(normalized.slice(start, end + 1)) as unknown;
    } catch {
      return undefined;
    }
  }
}

export function isInterestingJsonResponse(response: Response): boolean {
  const resourceType = response.request().resourceType();
  if (resourceType !== "xhr" && resourceType !== "fetch") return false;
  if (!response.ok()) return false;

  const headers = response.headers();
  const contentType = headers["content-type"] || "";
  if (/json|javascript/iu.test(contentType)) return true;
  return /(?:api|search|goods|product|offer|item|recommend)/iu.test(
    response.url(),
  );
}

export async function collectProductsFromResponse(
  response: Response,
  definition: PlatformCrawlerDefinition,
  currency: string,
  maximumBytes: number,
): Promise<CommerceProductSignal[]> {
  const headers = response.headers();
  const length = Number(headers["content-length"] || Number.NaN);
  if (Number.isFinite(length) && length > maximumBytes) return [];

  const body = await response.text();
  if (body.length > maximumBytes) return [];
  const payload = parseJsonSafely(body);
  if (payload === undefined) return [];

  return parsePlatformJsonPayload(
    payload,
    definition,
    new URL(response.url()),
    currency,
  );
}

export async function scrollForLazyContent(page: Page, steps: number): Promise<void> {
  for (let index = 0; index < steps; index += 1) {
    await page.evaluate(() => {
      const target = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
      );
      window.scrollTo({ top: target, behavior: "auto" });
    });
    await page.waitForTimeout(650);
  }
}

export function launchAttempts(
  baseOptions: LaunchOptions,
): Array<{ label: string; options: LaunchOptions }> {
  const attempts: Array<{ label: string; options: LaunchOptions }> = [];
  const executablePath = process.env.COMMERCE_BROWSER_EXECUTABLE_PATH?.trim();
  const configuredChannel = process.env.COMMERCE_BROWSER_CHANNEL?.trim();

  if (executablePath) {
    attempts.push({
      label: `指定浏览器 ${executablePath}`,
      options: { ...baseOptions, executablePath },
    });
  }
  if (configuredChannel) {
    attempts.push({
      label: `浏览器通道 ${configuredChannel}`,
      options: { ...baseOptions, channel: configuredChannel },
    });
  }

  // 优先使用 Playwright 自带 Chromium；未安装浏览器二进制时再尝试常见系统浏览器。
  attempts.push({ label: "Playwright Chromium", options: baseOptions });
  for (const channel of ["chrome", "msedge"] as const) {
    if (channel === configuredChannel) continue;
    attempts.push({
      label: `系统 ${channel}`,
      options: { ...baseOptions, channel },
    });
  }

  return attempts;
}

export async function launchBrowser(
  proxy: PlaywrightProxySettings | undefined,
): Promise<BrowserLaunchResult> {
  const headless = readBoolean("COMMERCE_BROWSER_HEADLESS", true);
  const launchTimeout = readBoundedInteger(
    "COMMERCE_BROWSER_LAUNCH_TIMEOUT_MS",
    30_000,
    5_000,
    120_000,
  );
  const baseOptions: LaunchOptions = {
    headless,
    proxy,
    timeout: launchTimeout,
    args: ["--disable-dev-shm-usage"],
  };
  const failures: string[] = [];

  for (const attempt of launchAttempts(baseOptions)) {
    try {
      const browser = await chromium.launch(attempt.options);
      return { browser, method: attempt.label };
    } catch (error) {
      failures.push(`${attempt.label}：${compactError(error)}`);
    }
  }

  throw new Error(
    `无法启动 Playwright 浏览器。请执行“pnpm crawler:install-browser”，或设置 COMMERCE_BROWSER_EXECUTABLE_PATH / COMMERCE_BROWSER_CHANNEL。诊断：${failures.join("；")}`,
  );
}

export async function createBrowserContext(
  browser: Browser,
  definition: PlatformCrawlerDefinition,
  locale: string,
): Promise<BrowserContext> {
  const normalizedLocale = locale.replace("_", "-");
  return browser.newContext({
    locale: normalizedLocale,
    userAgent: resolvePlatformCrawlerUserAgent(definition),
    viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders: {
      "Accept-Language": `${normalizedLocale},en;q=0.8,zh-CN;q=0.6`,
    },
    javaScriptEnabled: true,
  });
}
