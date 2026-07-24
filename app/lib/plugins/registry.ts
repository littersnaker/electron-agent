import type {
  BuiltinPluginId,
  BuiltinPluginManifest,
  BuiltinPluginState,
} from "./types";

/**
 * 插件清单只保存轻量元数据，不能在这里 import Agent 实现。
 * 这样核心页面读取插件列表时不会把 Code / Commerce 的实现打进同步依赖链。
 */
export const BUILTIN_PLUGINS: readonly BuiltinPluginManifest[] = [
  {
    id: "code-agent",
    name: "Code Agent",
    shortName: "代码协作",
    description: "本地项目索引、文件修改、终端验证与代码审查。",
    accent: "blue",
    sessionMode: "code",
    defaultEnabled: false,
  },
  {
    id: "commerce-research",
    name: "Cross-border Market Intelligence Agent",
    shortName: "跨境市场情报",
    description: "无需 Amazon 店铺或付费平台 API，基于公开 SERP/Shopping 完成跨境市场情报初筛；付费数据仅作为可选增强。",
    accent: "blue",
    sessionMode: "commerce",
    defaultEnabled: false,
  },
] as const;

export function createDefaultPluginState(): BuiltinPluginState {
  return BUILTIN_PLUGINS.reduce<BuiltinPluginState>(
    (state, plugin) => ({ ...state, [plugin.id]: plugin.defaultEnabled }),
    {
      "code-agent": false,
      "commerce-research": false,
    },
  );
}

export function isBuiltinPluginId(value: string): value is BuiltinPluginId {
  return BUILTIN_PLUGINS.some((plugin) => plugin.id === value);
}
