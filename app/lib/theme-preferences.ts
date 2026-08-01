// 模块说明：读取和写入 FastAPI SQLite 中的界面主题偏好。
import type { ThemeMode } from "../constants/theme";
import { apiFetch } from "./api-client";

interface ThemePreferenceResponse {
  theme?: unknown;
}

/** 判断后端返回值是否是受支持的主题。 */
function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light";
}

/** 从 SQLite 读取主题；后端不可访问或尚无记录时返回 null。 */
export async function loadThemePreference(): Promise<ThemeMode | null> {
  try {
    const response = await apiFetch("/api/preferences/theme");
    if (!response.ok) return null;
    const payload = (await response.json()) as ThemePreferenceResponse;
    return isThemeMode(payload.theme) ? payload.theme : null;
  } catch {
    return null;
  }
}

/** 在普通浏览器模式下把主题写入 FastAPI SQLite。 */
export async function saveThemePreference(theme: ThemeMode): Promise<void> {
  const response = await apiFetch("/api/preferences/theme", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme }),
  });
  if (!response.ok) {
    throw new Error(`主题偏好保存失败：HTTP ${response.status}`);
  }
}
