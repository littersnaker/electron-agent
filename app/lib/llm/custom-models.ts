// 模块说明：定义用户自定义聊天模型及其 SQLite API 数据结构。
import type { LlmProviderId } from "./types";

export interface CustomModelInput {
  name: string;
  provider: LlmProviderId;
  /** 原样发送给供应商 API 的 model 值。 */
  model: string;
  /** 可填写 Base URL 或完整 chat/completions 地址。 */
  baseUrl?: string;
  includeInAuto: boolean;
  autoPriority: number;
  supportsVision: boolean;
}

export interface CustomModelRecord
  extends Omit<CustomModelInput, "baseUrl"> {
  id: string;
  /** SQLite 中允许为空，服务端 JSON 会返回 null。 */
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomModelListResponse {
  models: CustomModelRecord[];
}

export interface CustomModelMutationResponse {
  model: CustomModelRecord;
}
