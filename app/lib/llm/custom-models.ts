// 模块说明：定义用户自定义模型（聊天 + 媒体）及其 SQLite API 数据结构。
import type { LlmProviderId } from "./types";

export type MediaMode = "text-to-image" | "text-to-video" | "image-edit";
export type MediaProtocol =
  | ""
  | "qwen-image-sync"
  | "volcengine-image"
  | "volcengine-video-async";
export type MediaOutputKind = "" | "image" | "video";

export interface CustomModelInput {
  name: string;
  provider: LlmProviderId;
  /** 原样发送给供应商 API 的 model 值。 */
  model: string;
  /** 可填写 Base URL 或完整接口地址。 */
  baseUrl?: string;
  includeInAuto: boolean;
  autoPriority: number;
  supportsVision: boolean;
  /** 声明为媒体模型时填写；空数组表示纯聊天模型。 */
  mediaModes: MediaMode[];
  mediaProtocol: MediaProtocol;
  mediaOutputKind: MediaOutputKind;
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
