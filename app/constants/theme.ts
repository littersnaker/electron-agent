// 模块说明：集中维护 theme 相关常量。
import type { CSSProperties } from "react";

export type ThemeMode = "dark" | "light";

type ThemeVariables = CSSProperties & Record<`--${string}`, string>;

export const THEME_STORAGE_KEY = "AGENT_WORKSPACE_THEME_LIGHT_DEFAULT_V2";

const sharedVariables: ThemeVariables = {
  "--accent-purple": "#bf5af2",
  "--accent-green": "#30d158",
  "--accent-red": "#ff453a",
  "--accent-amber": "#ffd60a",
  "--ease-apple": "cubic-bezier(0.2, 0.8, 0.2, 1)",
};

const darkVariables: ThemeVariables = {
  ...sharedVariables,
  "--accent-blue": "#a1a1aa",
  "--accent-blue-hover": "#d4d4d8",
  "--accent-blue-soft": "rgba(255, 255, 255, 0.075)",
  "--accent-blue-soft-strong": "rgba(255, 255, 255, 0.12)",
  "--accent-blue-border": "rgba(255, 255, 255, 0.14)",
  "--accent-blue-border-strong": "rgba(255, 255, 255, 0.2)",
  "--accent-blue-glow": "rgba(0, 0, 0, 0.3)",
  "--accent-blue-gradient-start": "#5c5c63",
  "--accent-blue-gradient-end": "#3f3f46",
  "--app-bg": "#09090b",
  "--app-bg-secondary": "#111114",
  "--app-glow-blue": "rgba(255, 255, 255, 0.028)",
  "--app-glow-purple": "rgba(255, 255, 255, 0.012)",
  "--text-primary": "#f5f5f7",
  "--text-secondary": "rgba(235, 235, 245, 0.67)",
  "--text-tertiary": "rgba(235, 235, 245, 0.4)",
  "--text-quaternary": "rgba(235, 235, 245, 0.24)",
  "--glass": "rgba(255, 255, 255, 0.055)",
  "--glass-soft": "rgba(255, 255, 255, 0.035)",
  "--glass-strong": "rgba(38, 38, 42, 0.82)",
  "--glass-solid": "rgba(29, 29, 32, 0.96)",
  "--glass-hover": "rgba(255, 255, 255, 0.085)",
  "--glass-active": "rgba(255, 255, 255, 0.11)",
  "--selection-bg": "rgba(255, 255, 255, 0.085)",
  "--selection-bg-strong": "rgba(255, 255, 255, 0.13)",
  "--selection-border": "rgba(255, 255, 255, 0.15)",
  "--selection-text": "#f5f5f7",
  "--selection-indicator": "#a1a1aa",
  "--selection-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.075)",
  "--glass-black": "rgba(0, 0, 0, 0.26)",
  "--border": "rgba(255, 255, 255, 0.085)",
  "--border-strong": "rgba(255, 255, 255, 0.14)",
  "--sidebar-bg": "rgba(20, 20, 23, 0.74)",
  "--titlebar-bg": "rgba(15, 15, 18, 0.78)",
  "--composer-bg": "rgba(28, 28, 31, 0.8)",
  "--message-user-start": "#52525b",
  "--message-user-end": "#3f3f46",
  "--message-user-shadow":
    "0 10px 28px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.12)",
  "--primary-button-shadow":
    "0 8px 20px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.14)",
  "--shadow-soft": "0 18px 50px rgba(0, 0, 0, 0.22)",
  "--shadow-card": "0 24px 70px rgba(0, 0, 0, 0.34)",
  "--shadow-float": "0 34px 100px rgba(0, 0, 0, 0.48)",
  "--scrollbar-thumb": "rgba(255, 255, 255, 0.14)",
  colorScheme: "dark",
};

const lightVariables: ThemeVariables = {
  ...sharedVariables,
  "--accent-blue": "#0a84ff",
  "--accent-blue-hover": "#409cff",
  "--accent-blue-soft": "rgba(10, 132, 255, 0.08)",
  "--accent-blue-soft-strong": "rgba(10, 132, 255, 0.13)",
  "--accent-blue-border": "rgba(10, 132, 255, 0.2)",
  "--accent-blue-border-strong": "rgba(10, 132, 255, 0.28)",
  "--accent-blue-glow": "rgba(10, 132, 255, 0.22)",
  "--accent-blue-gradient-start": "#168dff",
  "--accent-blue-gradient-end": "#0071e3",
  "--app-bg": "#eef1f6",
  "--app-bg-secondary": "#f8f9fb",
  "--app-glow-blue": "rgba(10, 132, 255, 0.15)",
  "--app-glow-purple": "rgba(175, 82, 222, 0.1)",
  "--text-primary": "#151519",
  "--text-secondary": "rgba(30, 30, 35, 0.68)",
  "--text-tertiary": "rgba(30, 30, 35, 0.43)",
  "--text-quaternary": "rgba(30, 30, 35, 0.26)",
  "--glass": "rgba(255, 255, 255, 0.56)",
  "--glass-soft": "rgba(255, 255, 255, 0.38)",
  "--glass-strong": "rgba(255, 255, 255, 0.74)",
  "--glass-solid": "rgba(250, 250, 252, 0.96)",
  "--glass-hover": "rgba(255, 255, 255, 0.82)",
  "--glass-active": "rgba(255, 255, 255, 0.94)",
  "--selection-bg": "rgba(10, 132, 255, 0.09)",
  "--selection-bg-strong": "rgba(10, 132, 255, 0.13)",
  "--selection-border": "rgba(10, 132, 255, 0.28)",
  "--selection-text": "#0071e3",
  "--selection-indicator": "#0a84ff",
  "--selection-shadow": "inset 0 1px 0 rgba(255, 255, 255, 0.5)",
  "--glass-black": "rgba(43, 43, 48, 0.055)",
  "--border": "rgba(15, 23, 42, 0.09)",
  "--border-strong": "rgba(15, 23, 42, 0.15)",
  "--sidebar-bg": "rgba(246, 247, 250, 0.72)",
  "--titlebar-bg": "rgba(246, 247, 250, 0.72)",
  "--composer-bg": "rgba(255, 255, 255, 0.66)",
  "--message-user-start": "#168dff",
  "--message-user-end": "#0071e3",
  "--message-user-shadow":
    "0 10px 28px rgba(10, 132, 255, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.18)",
  "--primary-button-shadow":
    "0 8px 20px rgba(10, 132, 255, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.2)",
  "--shadow-soft": "0 18px 50px rgba(65, 72, 92, 0.1)",
  "--shadow-card": "0 24px 70px rgba(65, 72, 92, 0.15)",
  "--shadow-float": "0 34px 100px rgba(65, 72, 92, 0.2)",
  "--scrollbar-thumb": "rgba(15, 23, 42, 0.16)",
  colorScheme: "light",
};

export function getThemeVariables(theme: ThemeMode): ThemeVariables {
  return theme === "light" ? lightVariables : darkVariables;
}

export function resolveInitialTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";

  const electronTheme = window.electronAPI?.initialTheme;
  if (electronTheme === "dark" || electronTheme === "light") {
    return electronTheme;
  }

  const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === "dark" || saved === "light") return saved;

  return "light";
}

export function persistTheme(theme: ThemeMode): void {
  if (typeof window === "undefined") return;

  window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;

  // 同步 Electron 原生主题、启动缓存和 SQLite。普通浏览器会自动跳过。
  const electronRequest = window.electronAPI?.setTheme(theme);
  void electronRequest?.catch((error: unknown) => {
    console.warn("Electron 主题持久化失败", error);
  });
}
