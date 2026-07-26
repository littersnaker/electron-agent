// 模块说明：负责 usePluginManager 状态管理与业务编排。
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

function parseStoredState(raw: string | null): BuiltinPluginState {
  const fallback = createDefaultPluginState();
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (isBuiltinPluginId(key) && typeof value === "boolean") {
        fallback[key] = value;
      }
    }
  } catch {
    // localStorage 被手工修改或旧版本格式损坏时，回退到安全默认值。
  }
  return fallback;
}

/**
 * 管理内置插件的启用状态。
 *
 * 首次安装默认只启用核心 QA；用户开启插件后才显示入口。状态保存在本机，
 * 不会上传到服务端。服务端 API Route 本身也只会在真正请求时加载。
 */
export function usePluginManager() {
  const [enabled, setEnabled] = useState<BuiltinPluginState>(() =>
    createDefaultPluginState(),
  );
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setEnabled(parseStoredState(window.localStorage.getItem(STORAGE_KEY)));
    setHydrated(true);
  }, []);

  const setPluginEnabled = useCallback(
    (pluginId: BuiltinPluginId, nextEnabled: boolean) => {
      setEnabled((current) => {
        const next = { ...current, [pluginId]: nextEnabled };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
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
