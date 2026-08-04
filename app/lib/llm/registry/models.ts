// 模块说明：前端聊天模型注册表直接读取 config/chat-models.json，
// 改 JSON 后重新构建前端即可生效，不再经过生成脚本。
import type {
  LlmModelDefinition,
  LlmProviderId,
} from "../types";
import chatModelConfig from "../../../../config/chat-models.json";

export const AUTO_MODEL_ID = "auto";
export const DEFAULT_MODEL_ID = chatModelConfig.defaultModelId as string;

export const LLM_MODEL_CATALOG =
  chatModelConfig.models as unknown as readonly LlmModelDefinition[];

/** 旧版保存值到新版稳定逻辑 ID 的迁移表。 */
const MODEL_ID_ALIASES: Readonly<Record<string, string>> =
  chatModelConfig.aliases as Readonly<Record<string, string>>;

/** 按逻辑 ID、旧版别名或厂商真实模型名查找模型。 */
export function getModelDefinition(
  modelIdOrVendorModel: string | undefined,
): LlmModelDefinition | undefined {
  const value = modelIdOrVendorModel?.trim();
  if (!value || value === AUTO_MODEL_ID) return undefined;
  const normalized = MODEL_ID_ALIASES[value] ?? value;
  return LLM_MODEL_CATALOG.find(
    (item) => item.id === normalized || item.model === normalized,
  );
}

/** 返回某供应商的所有聊天模型。 */
export function getModelsForProvider(
  provider: LlmProviderId,
): readonly LlmModelDefinition[] {
  return LLM_MODEL_CATALOG.filter(
    (item) => item.provider === provider && item.chatCompatible === true,
  );
}

/** 返回供应商用于连接验证的默认模型。 */
export function getDefaultModelForProvider(
  provider: LlmProviderId,
): LlmModelDefinition | undefined {
  const models = getModelsForProvider(provider).filter(
    (model) => model.autoSelect !== false || model.fallbackSelect === true,
  );
  return [...models].sort(
    (left, right) => (left.autoPriority ?? 100) - (right.autoPriority ?? 100),
  )[0];
}

/** 判断保存的模型选择是否仍可被当前版本识别。 */
export function isKnownModelId(value: string): boolean {
  return value === AUTO_MODEL_ID || Boolean(getModelDefinition(value));
}

/** 把旧版模型 ID 规范化为当前注册表中的稳定 ID。 */
export function normalizeModelId(value: string): string {
  if (value === AUTO_MODEL_ID) return value;
  return getModelDefinition(value)?.id ?? value;
}
