// 模块说明：负责 useThemeMode 状态管理与业务编排。
"use client";

import { useCallback, useEffect, useState } from "react";
import { persistTheme, resolveInitialTheme } from "../constants/theme";
import type { ThemeMode } from "../constants/theme";

export function useThemeMode() {
  const [theme, setTheme] = useState<ThemeMode>("light");

  useEffect(() => {
    const setSystemTheme = () => {
      setTheme(resolveInitialTheme());
    };
    setSystemTheme();
  }, []);

  useEffect(() => {
    persistTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  return { theme, toggleTheme };
}
