// 模块说明：管理内置插件开关，并跨 Electron 重启持久化。
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BUILTIN_PLUGINS,
  createDefaultPluginState,
  isBuiltinPluginId,
} from "../lib/plugins/registry";
import type {
  BuiltinPluginId,
  BuiltinPluginState,
} from "../lib/plugins/types";

const STORAGE_KEY = "agent-workspace:builtin-plugins:v1";

/** 从 JSON 字符串解析插件状态，损坏时回退到安全默认值。 */
function parseStoredState(raw: string | null): BuiltinPluginState {
  if (!raw) return createDefaultPluginState();
  try {
    return mergePluginState(JSON.parse(raw));
  } catch {
    return createDefaultPluginState();
  }
}

/** 仅合并注册表中存在且值为布尔型的插件开关。 */
function mergePluginState(input: unknown): BuiltinPluginState {
  const result = createDefaultPluginState();
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const [key, value] of Object.entries(input)) {
    if (isBuiltinPluginId(key) && typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

/** 同时写入 Electron 固定偏好文件和浏览器后备。 */
function persistPluginState(next: BuiltinPluginState): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  void window.electronAPI?.preferences.write({ builtinPlugins: next });
}

/**
 * 管理内置插件的启用状态。
 *
 * Electron 偏好优先于网页 Origin 的 localStorage，避免开发地址或启动模式改变后开关丢失。
 */
export function usePluginManager() {
  const [enabled, setEnabled] = useState<BuiltinPluginState>(() =>
    createDefaultPluginState(),
  );
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const localState = parseStoredState(
        window.localStorage.getItem(STORAGE_KEY),
      );
      const preferences = window.electronAPI?.preferences
        ? await window.electronAPI.preferences.read().catch(() => ({}))
        : {};
      const next = preferences.builtinPlugins
        ? mergePluginState(preferences.builtinPlugins)
        : localState;
      if (cancelled) return;
      setEnabled(next);
      persistPluginState(next);
      setHydrated(true);
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  const setPluginEnabled = useCallback(
    (pluginId: BuiltinPluginId, nextEnabled: boolean) => {
      setEnabled((current) => {
        const next = { ...current, [pluginId]: nextEnabled };
        persistPluginState(next);
        return next;
      });
    },
    [],
  );

  const enabledPlugins = useMemo(
    () => BUILTIN_PLUGINS.filter((plugin) => enabled[plugin.id]),
    [enabled],
  );

  return {
    manifests: BUILTIN_PLUGINS,
    enabled,
    enabledPlugins,
    hydrated,
    isEnabled: (pluginId: BuiltinPluginId) => enabled[pluginId],
    setPluginEnabled,
  };
}

export type PluginManager = ReturnType<typeof usePluginManager>;
