/**
 * 模块职责：持久化主题、模型选择和插件开关，并与 FastAPI 主题偏好同步。
 */
import fs from "node:fs";
import path from "node:path";
import { getStableDataPath } from "./data-paths";

export type AppTheme = "dark" | "light";
<<<<<<< HEAD
=======
export type CodeAgentMode = "suggest" | "auto_edit" | "full_auto";
>>>>>>> changePython
export const DEFAULT_APP_THEME: AppTheme = "light";

/** Renderer 可以读写的非敏感界面偏好。 */
export interface AppUiPreferences {
  selectedChatModel?: string;
  selectedMediaModel?: string;
  builtinPlugins?: Record<string, boolean>;
<<<<<<< HEAD
=======
  codeAgentMode?: CodeAgentMode;
>>>>>>> changePython
}

interface PreferenceFile extends AppUiPreferences {
  theme?: AppTheme;
  updatedAt?: string;
}

interface ThemeApiResponse {
  theme?: unknown;
}

const PREFERENCE_FILE_NAME = "app-preferences.json";
const REQUEST_TIMEOUT_MS = 2_500;
const MAX_MODEL_ID_LENGTH = 160;

/** 判断任意值是否是应用支持的主题。 */
export function isAppTheme(value: unknown): value is AppTheme {
  return value === "dark" || value === "light";
}

/** 固定偏好文件地址，避免开发版与安装版因应用名称不同而分叉。 */
function resolvePreferenceFilePath(): string {
  return getStableDataPath(PREFERENCE_FILE_NAME);
}

/** 读取完整偏好；文件缺失或 JSON 损坏时返回空对象。 */
function readPreferenceFile(): PreferenceFile {
  try {
    return JSON.parse(
      fs.readFileSync(resolvePreferenceFilePath(), "utf8"),
    ) as PreferenceFile;
  } catch {
    return {};
  }
}

/** 原子写入完整偏好对象。 */
function writePreferenceFile(preferences: PreferenceFile): void {
  const preferencePath = resolvePreferenceFilePath();
  const temporaryPath = `${preferencePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify(preferences, null, 2)}\n`,
    "utf8",
  );
  try {
    fs.renameSync(temporaryPath, preferencePath);
  } catch (error) {
    fs.rmSync(preferencePath, { force: true });
    fs.renameSync(temporaryPath, preferencePath);
    console.warn("[Electron] 偏好文件使用替换写入", error);
  }
}

/** 清洗来自 Renderer 的偏好补丁，拒绝超长字符串和非布尔插件值。 */
function normalizeUiPreferences(input: unknown): AppUiPreferences {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const result: AppUiPreferences = {};

  if (
    typeof source.selectedChatModel === "string" &&
    source.selectedChatModel.length <= MAX_MODEL_ID_LENGTH
  ) {
    result.selectedChatModel = source.selectedChatModel;
  }
  if (
    typeof source.selectedMediaModel === "string" &&
    source.selectedMediaModel.length <= MAX_MODEL_ID_LENGTH
  ) {
    result.selectedMediaModel = source.selectedMediaModel;
  }
  if (
<<<<<<< HEAD
=======
    source.codeAgentMode === "suggest" ||
    source.codeAgentMode === "auto_edit" ||
    source.codeAgentMode === "full_auto"
  ) {
    result.codeAgentMode = source.codeAgentMode;
  }
  if (
>>>>>>> changePython
    source.builtinPlugins &&
    typeof source.builtinPlugins === "object" &&
    !Array.isArray(source.builtinPlugins)
  ) {
    result.builtinPlugins = Object.fromEntries(
      Object.entries(source.builtinPlugins).filter(
        ([key, value]) => key.length <= 80 && typeof value === "boolean",
      ),
    ) as Record<string, boolean>;
  }
  return result;
}

/** 提供给 Renderer 的非敏感偏好快照。 */
export function readUiPreferences(): AppUiPreferences {
  return normalizeUiPreferences(readPreferenceFile());
}

/** 合并写入非敏感偏好，不覆盖主题或其他字段。 */
export function writeUiPreferences(input: unknown): AppUiPreferences {
  const patch = normalizeUiPreferences(input);
  const current = readPreferenceFile();
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writePreferenceFile(next);
  return normalizeUiPreferences(next);
}

/** 在 FastAPI 尚未启动时同步读取上一次主题，供加载页立即使用。 */
export function readCachedTheme(): AppTheme {
  const theme = readPreferenceFile().theme;
  return isAppTheme(theme) ? theme : DEFAULT_APP_THEME;
}

/** 写主题时保留同一文件里的模型选择与插件开关。 */
export function writeCachedTheme(theme: AppTheme): void {
  writePreferenceFile({
    ...readPreferenceFile(),
    theme,
    updatedAt: new Date().toISOString(),
  });
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

/** FastAPI 就绪后以 SQLite 记录为优先，并同步回启动缓存。 */
export async function synchronizeThemeWithBackend(
  backendBaseUrl: string,
  cachedTheme: AppTheme,
): Promise<AppTheme> {
  try {
    const response = await requestThemeApi(
      `${backendBaseUrl}/api/preferences/theme`,
    );
    if (!response.ok) throw new Error(`主题读取失败：HTTP ${response.status}`);

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
