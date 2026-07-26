// 模块说明：负责 types 核心服务与领域逻辑。
import type { SessionMode } from "../../constants/page-constants";

/**
 * 内置功能插件标识。
 *
 * QA 属于核心能力，不进入插件系统；Code Agent 与跨境市场情报属于按需能力，
 * 关闭后不会在启动页主动初始化对应入口与重型 UI。
 */
export type BuiltinPluginId = "code-agent" | "commerce-research";

export interface BuiltinPluginManifest {
  id: BuiltinPluginId;
  name: string;
  shortName: string;
  description: string;
  /** 插件入口统一使用工作台主蓝色，状态色仍由具体组件单独表达。 */
  accent: "blue";
  sessionMode: Exclude<SessionMode, "qa">;
  /** 新安装默认关闭，保证核心 QA 首屏尽量轻。 */
  defaultEnabled: boolean;
}

export type BuiltinPluginState = Record<BuiltinPluginId, boolean>;
