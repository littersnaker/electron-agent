/**
 * 模块职责：在 Electron 启动早期读取主题缓存，并与 FastAPI SQLite 偏好表同步。
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export type AppTheme = "dark" | "light";

export const DEFAULT_APP_THEME: AppTheme = "light";

interface PreferenceFile {
  theme?: AppTheme;
  updatedAt?: string;
}

interface ThemeApiResponse {
  theme?: unknown;
}

const PREFERENCE_FILE_NAME = "app-preferences.json";
const REQUEST_TIMEOUT_MS = 2_500;

/** 判断任意值是否是应用支持的主题。 */
export function isAppTheme(value: unknown): value is AppTheme {
  return value === "dark" || value === "light";
}

/** 返回 Electron 用户数据目录中的主题缓存文件。 */
function resolvePreferenceFilePath(): string {
  return path.join(app.getPath("userData"), PREFERENCE_FILE_NAME);
}

/** 在 FastAPI 尚未启动时同步读取上一次主题，供加载页立即使用。 */
export function readCachedTheme(): AppTheme {
  try {
    const content = fs.readFileSync(resolvePreferenceFilePath(), "utf8");
    const parsed = JSON.parse(content) as PreferenceFile;
    return isAppTheme(parsed.theme) ? parsed.theme : DEFAULT_APP_THEME;
  } catch {
    return DEFAULT_APP_THEME;
  }
}

/** 原子写入轻量主题缓存，避免应用被强制退出时留下半个 JSON 文件。 */
export function writeCachedTheme(theme: AppTheme): void {
  const preferencePath = resolvePreferenceFilePath();
  const temporaryPath = `${preferencePath}.${process.pid}.tmp`;
  const payload: PreferenceFile = {
    theme,
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temporaryPath, preferencePath);
  } catch (error) {
    fs.rmSync(preferencePath, { force: true });
    fs.renameSync(temporaryPath, preferencePath);
    console.warn("[Electron] 主题缓存文件使用替换写入", error);
  }
}

/** 带超时访问本地偏好接口。 */
async function requestThemeApi(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** 把主题写入 FastAPI 管理的 SQLite 表。 */
export async function writeThemeToBackend(
  backendBaseUrl: string,
  theme: AppTheme,
): Promise<void> {
  const response = await requestThemeApi(
    `${backendBaseUrl}/api/preferences/theme`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme }),
    },
  );
  if (!response.ok) {
    throw new Error(`主题写入 SQLite 失败：HTTP ${response.status}`);
  }
}

/**
 * FastAPI 就绪后以 SQLite 记录为优先；首次升级没有记录时，把启动缓存迁移进去。
 */
export async function synchronizeThemeWithBackend(
  backendBaseUrl: string,
  cachedTheme: AppTheme,
): Promise<AppTheme> {
  try {
    const response = await requestThemeApi(
      `${backendBaseUrl}/api/preferences/theme`,
    );
    if (!response.ok) {
      throw new Error(`主题读取失败：HTTP ${response.status}`);
    }

    const payload = (await response.json()) as ThemeApiResponse;
    if (isAppTheme(payload.theme)) {
      writeCachedTheme(payload.theme);
      return payload.theme;
    }

    await writeThemeToBackend(backendBaseUrl, cachedTheme);
  } catch (error) {
    console.warn("[Electron] SQLite 主题同步失败，继续使用本地启动缓存", error);
  }
  return cachedTheme;
}
