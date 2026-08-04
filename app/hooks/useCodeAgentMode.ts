"use client";

import { useCallback, useEffect, useState } from "react";
import type { CodeAgentExecutionMode } from "../constants/page-constants";

const STORAGE_KEY = "agent-workspace:code-agent-mode:v1";
const DEFAULT_MODE: CodeAgentExecutionMode = "auto_edit";

/** 校验来自本地缓存或 Electron 偏好文件的执行模式。 */
function normalizeMode(value: unknown): CodeAgentExecutionMode {
  return value === "suggest" || value === "auto_edit" || value === "full_auto"
    ? value
    : DEFAULT_MODE;
}

/** 跨重启保存 Code Agent 权限模式。 */
export function useCodeAgentMode() {
  const [mode, setModeState] = useState<CodeAgentExecutionMode>(() => {
    if (typeof window === "undefined") return DEFAULT_MODE;
    return normalizeMode(window.localStorage.getItem(STORAGE_KEY));
  });

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const local = normalizeMode(window.localStorage.getItem(STORAGE_KEY));
      const preferences = window.electronAPI?.preferences
        ? await window.electronAPI.preferences.read().catch(() => ({}))
        : {};
      const next = normalizeMode(preferences.codeAgentMode ?? local);
      if (cancelled) return;
      setModeState(next);
      window.localStorage.setItem(STORAGE_KEY, next);
      void window.electronAPI?.preferences.write({ codeAgentMode: next });
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((value: CodeAgentExecutionMode) => {
    const next = normalizeMode(value);
    setModeState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    void window.electronAPI?.preferences.write({ codeAgentMode: next });
  }, []);

  return { codeAgentMode: mode, setCodeAgentMode: setMode };
}
