"use client";
/**
 * 模块职责：模型与电商数据源配置定义、状态和展示辅助函数。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import type { LlmCredentials } from "../../lib/llm/types";
import { type AuxiliaryServiceCredentials } from "../../lib/service-credentials";
export interface Props {
  initialKeys: LlmCredentials;
  initialServiceKeys: AuxiliaryServiceCredentials;
  onSave: (
    keys: LlmCredentials,
    serviceKeys: AuxiliaryServiceCredentials,
  ) => void;
  onClose: () => void;
}

export type MarketProviderId = "talordata" | "keepa" | "tiktok" | "temu" | "1688";

export type ConnectionState =
  | "idle"
  | "checking"
  | "connected"
  | "partial"
  | "unconfigured"
  | "unauthorized"
  | "quota_exceeded"
  | "network_error"
  | "error";

export interface ProviderEnvironmentStatus {
  configured?: unknown;
  fingerprint?: unknown;
}

export interface EnvironmentStatusResponse {
  environmentConfigured?: unknown;
  providers?: Partial<Record<MarketProviderId, ProviderEnvironmentStatus>>;
}

export interface ProviderHealthResponse {
  ok?: unknown;
  state?: unknown;
  message?: unknown;
  detail?: unknown;
  latencyMs?: unknown;
  credentialSource?: unknown;
  credentialFingerprint?: unknown;
  endpoint?: unknown;
}

export interface ProviderViewState {
  state: ConnectionState;
  message: string;
  detail?: string;
  latencyMs?: number;
}

export interface ProviderField {
  key: keyof AuxiliaryServiceCredentials;
  label: string;
  environmentKey: string;
  placeholder: string;
  secret?: boolean;
}

export interface ProviderDefinition {
  id: MarketProviderId;
  title: string;
  subtitle: string;
  fields: ProviderField[];
  note: string;
}

export const COLORS = {
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  textSubtle: "var(--text-tertiary)",
  material: "var(--glass-solid)",
  materialSoft: "var(--glass)",
  border: "var(--border)",
  blue: "#0a84ff",
  red: "#ff453a",
  orange: "#ff9f0a",
  green: "#30d158",
};

export const PROVIDERS: ProviderDefinition[] = [
  {
    id: "talordata",
    title: "TalorData SERP",
    subtitle: "Cross-border Market Intelligence 的核心公开搜索数据源",
    note: "这是核心数据源：只要 TalorData 可用，市场情报流程即可完成；其他平台 API 均为可选增强。应用打包时可直接内置默认 Token。",
    fields: [
      {
        key: "talorDataToken",
        label: "API Token",
        environmentKey: "TALORDATA_API_TOKEN",
        placeholder: "sk_…",
        secret: true,
      },
    ],
  },
  {
    id: "keepa",
    title: "Keepa",
    subtitle: "Amazon 历史价格、Sales Rank 与商品生命周期",
    note: "配置后会直接参与 Amazon 历史数据增强；未配置不会影响其他来源。",
    fields: [
      {
        key: "keepaApiKey",
        label: "API Key",
        environmentKey: "KEEPA_API_KEY",
        placeholder: "Keepa Data Access key",
        secret: true,
      },
    ],
  },
  {
    id: "tiktok",
    title: "TikTok Shop",
    subtitle: "可选官方/合作方授权增强；公开市场仍可由 TalorData 采样",
    note: "只填 Client Key/Secret 时验证开发者凭证；填写 Merchant ID 后会尝试商家 OAuth。",
    fields: [
      {
        key: "tiktokClientKey",
        label: "Client Key",
        environmentKey: "TIKTOK_CLIENT_KEY",
        placeholder: "Client Key",
      },
      {
        key: "tiktokClientSecret",
        label: "Client Secret",
        environmentKey: "TIKTOK_CLIENT_SECRET",
        placeholder: "Client Secret",
        secret: true,
      },
      {
        key: "tiktokMerchantId",
        label: "Merchant ID（可选）",
        environmentKey: "TIKTOK_MERCHANT_ID",
        placeholder: "Merchant ID",
      },
    ],
  },
  {
    id: "temu",
    title: "Temu Open Platform",
    subtitle: "可选授权数据增强；公开市场信号仍可由 TalorData 获取",
    note: "连接测试会签名调用 Access Token 信息接口，实际可用数据取决于应用权限。",
    fields: [
      {
        key: "temuAppKey",
        label: "App Key",
        environmentKey: "TEMU_APP_KEY",
        placeholder: "App Key",
      },
      {
        key: "temuAppSecret",
        label: "App Secret",
        environmentKey: "TEMU_APP_SECRET",
        placeholder: "App Secret",
        secret: true,
      },
      {
        key: "temuAccessToken",
        label: "Access Token",
        environmentKey: "TEMU_ACCESS_TOKEN",
        placeholder: "Access Token",
        secret: true,
      },
    ],
  },
  {
    id: "1688",
    title: "1688 Open Platform",
    subtitle: "供应链授权数据增强；公开供应信号仍可由 TalorData 获取",
    note: "有 Access Token 时验证 1688 授权账号；否则仅验证 App Key / Secret。",
    fields: [
      {
        key: "alibaba1688AppKey",
        label: "App Key",
        environmentKey: "ALIBABA_1688_APP_KEY",
        placeholder: "App Key",
      },
      {
        key: "alibaba1688AppSecret",
        label: "App Secret",
        environmentKey: "ALIBABA_1688_APP_SECRET",
        placeholder: "App Secret",
        secret: true,
      },
      {
        key: "alibaba1688AccessToken",
        label: "Access Token（可选）",
        environmentKey: "ALIBABA_1688_ACCESS_TOKEN",
        placeholder: "Access Token / Session",
        secret: true,
      },
    ],
  },
];

export function initialProviderStates(): Record<MarketProviderId, ProviderViewState> {
  return {
    talordata: { state: "idle", message: "" },
    keepa: { state: "idle", message: "" },
    tiktok: { state: "idle", message: "" },
    temu: { state: "idle", message: "" },
    "1688": { state: "idle", message: "" },
  };
}

export function isConnectionState(value: unknown): value is ConnectionState {
  return [
    "connected",
    "partial",
    "unconfigured",
    "unauthorized",
    "quota_exceeded",
    "network_error",
    "error",
  ].includes(String(value));
}

export function providerStatusLabel(state: ConnectionState): string {
  switch (state) {
    case "checking":
      return "验证中";
    case "connected":
      return "已连接";
    case "partial":
      return "部分可用";
    case "unconfigured":
      return "未配置";
    case "unauthorized":
      return "认证失败";
    case "quota_exceeded":
      return "额度受限";
    case "network_error":
      return "网络异常";
    case "error":
      return "连接失败";
    default:
      return "未验证";
  }
}

export function providerStatusColor(state: ConnectionState): string {
  if (state === "connected") return COLORS.green;
  if (state === "partial") return COLORS.orange;
  if (
    state === "unauthorized" ||
    state === "quota_exceeded" ||
    state === "network_error" ||
    state === "error"
  ) {
    return COLORS.red;
  }
  return COLORS.textSubtle;
}

export function localProviderConfigured(
  provider: ProviderDefinition,
  serviceKeys: AuxiliaryServiceCredentials,
): boolean {
  return provider.fields.some((field) => Boolean(serviceKeys[field.key]?.trim()));
}
