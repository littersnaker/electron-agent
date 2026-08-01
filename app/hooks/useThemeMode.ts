// 模块说明：负责深浅色主题状态、SQLite 持久化和圆弧过渡动画。
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { persistTheme, resolveInitialTheme } from "../constants/theme";
import type { ThemeMode } from "../constants/theme";
import {
  loadThemePreference,
  saveThemePreference,
} from "../lib/theme-preferences";

interface ViewTransitionHandle {
  finished: Promise<void>;
}

interface ViewTransitionDocument extends Document {
  startViewTransition?: (
    updateCallback: () => void | Promise<void>,
  ) => ViewTransitionHandle;
}

/** 清理一次主题动画写入到 html 节点的临时标记。 */
function clearThemeTransitionMarkers(): void {
  const root = document.documentElement;
  root.classList.remove("theme-transition-running");
  delete root.dataset.themeTransition;
}

/** 返回当前设备是否要求减少动态效果。 */
function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 判断 Electron 是否已经在加载页面前完成 SQLite 与启动缓存同步。 */
function hasElectronInitialTheme(): boolean {
  const value = window.electronAPI?.initialTheme;
  return value === "dark" || value === "light";
}

/** 管理应用主题，并在支持 View Transition API 时执行圆弧揭示动画。 */
export function useThemeMode() {
  const [theme, setTheme] = useState<ThemeMode>(() => resolveInitialTheme());
  const [preferencesReady, setPreferencesReady] = useState(() =>
    hasElectronInitialTheme(),
  );
  const transitionRunningRef = useRef(false);

  useEffect(() => {
    if (hasElectronInitialTheme()) {
      setPreferencesReady(true);
      return undefined;
    }

    let cancelled = false;
    void loadThemePreference().then((storedTheme) => {
      if (cancelled) return;
      if (storedTheme) setTheme(storedTheme);
      setPreferencesReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;

    persistTheme(theme);
    if (!window.electronAPI) {
      void saveThemePreference(theme).catch((error: unknown) => {
        console.warn("浏览器模式主题写入 SQLite 失败", error);
      });
    }
  }, [preferencesReady, theme]);

  const toggleTheme = useCallback(() => {
    if (transitionRunningRef.current) return;

    const nextTheme: ThemeMode = theme === "dark" ? "light" : "dark";
    const root = document.documentElement;
    const transitionDocument = document as ViewTransitionDocument;

    root.dataset.themeTransition =
      nextTheme === "dark" ? "to-dark" : "to-light";
    root.classList.add("theme-transition-running");

    const commitThemeChange = (): void => {
      flushSync(() => setTheme(nextTheme));
    };

    if (
      prefersReducedMotion() ||
      typeof transitionDocument.startViewTransition !== "function"
    ) {
      commitThemeChange();
      clearThemeTransitionMarkers();
      return;
    }

    transitionRunningRef.current = true;
    let themeCommitted = false;
    const commitOnce = (): void => {
      if (themeCommitted) return;
      themeCommitted = true;
      commitThemeChange();
    };

    try {
      const transition = transitionDocument.startViewTransition(commitOnce);
      void transition.finished.finally(() => {
        transitionRunningRef.current = false;
        clearThemeTransitionMarkers();
      });
    } catch (error) {
      console.warn("主题圆弧动画启动失败，已使用无动画切换", error);
      commitOnce();
      transitionRunningRef.current = false;
      clearThemeTransitionMarkers();
    }
  }, [theme]);

  return { theme, toggleTheme };
}
