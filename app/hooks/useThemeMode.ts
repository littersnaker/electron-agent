"use client";

import { useCallback, useEffect, useState } from "react";
import { persistTheme, resolveInitialTheme } from "../const/theme";
import type { ThemeMode } from "../const/theme";

export function useThemeMode() {
  const [theme, setTheme] = useState<ThemeMode>("dark");

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
