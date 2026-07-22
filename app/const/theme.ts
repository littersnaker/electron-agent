import type { CSSProperties } from "react";

export type ThemeMode = "dark" | "light";

type ThemeVariables = CSSProperties & Record<`--${string}`, string>;

export const THEME_STORAGE_KEY = "AGENT_WORKSPACE_THEME";

const sharedVariables: ThemeVariables = {
  "--accent-blue": "#0a84ff",
  "--accent-blue-hover": "#409cff",
  "--accent-purple": "#bf5af2",
  "--accent-green": "#30d158",
  "--accent-red": "#ff453a",
  "--accent-amber": "#ffd60a",
  "--ease-apple": "cubic-bezier(0.2, 0.8, 0.2, 1)",
};

const darkVariables: ThemeVariables = {
  ...sharedVariables,
  "--app-bg": "#09090b",
  "--app-bg-secondary": "#111114",
  "--app-glow-blue": "rgba(10, 132, 255, 0.11)",
  "--app-glow-purple": "rgba(191, 90, 242, 0.07)",
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
  "--glass-black": "rgba(0, 0, 0, 0.26)",
  "--border": "rgba(255, 255, 255, 0.085)",
  "--border-strong": "rgba(255, 255, 255, 0.14)",
  "--sidebar-bg": "rgba(20, 20, 23, 0.74)",
  "--titlebar-bg": "rgba(15, 15, 18, 0.78)",
  "--composer-bg": "rgba(28, 28, 31, 0.8)",
  "--message-user-start": "#168dff",
  "--message-user-end": "#0879eb",
  "--shadow-soft": "0 18px 50px rgba(0, 0, 0, 0.22)",
  "--shadow-card": "0 24px 70px rgba(0, 0, 0, 0.34)",
  "--shadow-float": "0 34px 100px rgba(0, 0, 0, 0.48)",
  "--scrollbar-thumb": "rgba(255, 255, 255, 0.14)",
  colorScheme: "dark",
};

const lightVariables: ThemeVariables = {
  ...sharedVariables,
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
  "--glass-black": "rgba(43, 43, 48, 0.055)",
  "--border": "rgba(15, 23, 42, 0.09)",
  "--border-strong": "rgba(15, 23, 42, 0.15)",
  "--sidebar-bg": "rgba(246, 247, 250, 0.72)",
  "--titlebar-bg": "rgba(246, 247, 250, 0.72)",
  "--composer-bg": "rgba(255, 255, 255, 0.66)",
  "--message-user-start": "#168dff",
  "--message-user-end": "#0071e3",
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
  if (typeof window === "undefined") return "dark";

  const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === "dark" || saved === "light") return saved;

  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function persistTheme(theme: ThemeMode): void {
  if (typeof window === "undefined") return;

  window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;

  const electronWindow = window as typeof window & {
    electronAPI?: {
      setTheme?: (nextTheme: ThemeMode) => void;
    };
  };

  // 同步 Electron 原生标题栏覆盖层。普通浏览器环境中这段会自动跳过。
  electronWindow.electronAPI?.setTheme?.(theme);
}
