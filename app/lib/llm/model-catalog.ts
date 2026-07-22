/**
 * V6 兼容导出。
 *
 * 新代码应优先从 `registry/models` 导入；保留本文件是为了避免旧业务节点
 * 在 V7 升级时产生大范围无意义修改。
 */
export {
  AUTO_MODEL_ID,
  DEFAULT_MODEL_ID,
  LLM_MODEL_CATALOG,
  getModelDefinition,
  getModelsForProvider,
  isKnownModelId,
} from "./registry/models";
