// 模块说明：负责深浅色主题状态、持久化和圆弧过渡动画。
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { persistTheme, resolveInitialTheme } from "../constants/theme";
import type { ThemeMode } from "../constants/theme";

interface ViewTransitionHandle {
  finished: Promise<void>;
}

interface ViewTransitionDocument extends Document {
  startViewTransition?: (
    updateCallback: () => void | Promise<void>,
  ) => ViewTransitionHandle;
}

/**
 * 清理一次主题动画写入到 html 节点的临时标记。
 *
 * 这些标记只用于控制动画方向和暂停页面内部的零散过渡，
 * 动画结束后必须删除，避免影响后续按钮、菜单和输入框动画。
 */
function clearThemeTransitionMarkers(): void {
  const root = document.documentElement;
  root.classList.remove("theme-transition-running");
  delete root.dataset.themeTransition;
}

/**
 * 返回当前设备是否要求减少动态效果。
 *
 * 用户开启系统“减少动画”后，主题仍会正常切换，
 * 但会跳过圆弧扩散动画，避免引起视觉不适。
 */
function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 管理应用主题，并在支持 View Transition API 时执行圆弧揭示动画。
 *
 * 深色模式：圆弧从左上角扩散到右下角。
 * 浅色模式：圆弧从右下角扩散到左上角。
 */
export function useThemeMode() {
  const [theme, setTheme] = useState<ThemeMode>(() => resolveInitialTheme());
  const transitionRunningRef = useRef(false);

  useEffect(() => {
    persistTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    if (transitionRunningRef.current) return;

    const nextTheme: ThemeMode = theme === "dark" ? "light" : "dark";
    const root = document.documentElement;
    const transitionDocument = document as ViewTransitionDocument;

    root.dataset.themeTransition =
      nextTheme === "dark" ? "to-dark" : "to-light";
    root.classList.add("theme-transition-running");

    const commitThemeChange = (): void => {
      // flushSync 保证新主题在 View Transition 截取新画面前完成渲染。
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
      // 文档不可见或浏览器拒绝启动快照时，立即退回普通主题切换。
      console.warn("主题圆弧动画启动失败，已使用无动画切换", error);
      commitOnce();
      transitionRunningRef.current = false;
      clearThemeTransitionMarkers();
    }
  }, [theme]);

  return { theme, toggleTheme };
}
