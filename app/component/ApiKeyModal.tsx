"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { LLM_PROVIDER_CATALOG } from "../lib/llm/registry/providers";
import type { LlmCredentials, LlmProviderId } from "../lib/llm/types";
import {
  buildCommerceCredentialHeaders,
  type AuxiliaryServiceCredentials,
} from "../lib/service-credentials";

interface Props {
  initialKeys: LlmCredentials;
  initialServiceKeys: AuxiliaryServiceCredentials;
  onSave: (
    keys: LlmCredentials,
    serviceKeys: AuxiliaryServiceCredentials,
  ) => void;
  onClose: () => void;
}

type MarketProviderId = "talordata" | "keepa" | "tiktok" | "temu" | "1688";
type ConnectionState =
  | "idle"
  | "checking"
  | "connected"
  | "partial"
  | "unconfigured"
  | "unauthorized"
  | "quota_exceeded"
  | "network_error"
  | "error";

interface ProviderEnvironmentStatus {
  configured?: unknown;
  fingerprint?: unknown;
}

interface EnvironmentStatusResponse {
  environmentConfigured?: unknown;
  providers?: Partial<Record<MarketProviderId, ProviderEnvironmentStatus>>;
}

interface ProviderHealthResponse {
  ok?: unknown;
  state?: unknown;
  message?: unknown;
  detail?: unknown;
  latencyMs?: unknown;
  credentialSource?: unknown;
  credentialFingerprint?: unknown;
  endpoint?: unknown;
}

interface ProviderViewState {
  state: ConnectionState;
  message: string;
  detail?: string;
  latencyMs?: number;
}

interface ProviderField {
  key: keyof AuxiliaryServiceCredentials;
  label: string;
  environmentKey: string;
  placeholder: string;
  secret?: boolean;
}

interface ProviderDefinition {
  id: MarketProviderId;
  title: string;
  subtitle: string;
  fields: ProviderField[];
  note: string;
}

const COLORS = {
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

const PROVIDERS: ProviderDefinition[] = [
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

function initialProviderStates(): Record<MarketProviderId, ProviderViewState> {
  return {
    talordata: { state: "idle", message: "" },
    keepa: { state: "idle", message: "" },
    tiktok: { state: "idle", message: "" },
    temu: { state: "idle", message: "" },
    "1688": { state: "idle", message: "" },
  };
}

function isConnectionState(value: unknown): value is ConnectionState {
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

function providerStatusLabel(state: ConnectionState): string {
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

function providerStatusColor(state: ConnectionState): string {
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

function localProviderConfigured(
  provider: ProviderDefinition,
  serviceKeys: AuxiliaryServiceCredentials,
): boolean {
  return provider.fields.some((field) => Boolean(serviceKeys[field.key]?.trim()));
}

export default function ApiKeyModal({
  initialKeys,
  initialServiceKeys,
  onSave,
  onClose,
}: Props) {
  const [keys, setKeys] = useState<LlmCredentials>(initialKeys);
  const [serviceKeys, setServiceKeys] =
    useState<AuxiliaryServiceCredentials>(initialServiceKeys);
  const [visibleFields, setVisibleFields] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [environmentProviders, setEnvironmentProviders] = useState<
    Partial<Record<MarketProviderId, ProviderEnvironmentStatus>>
  >({});
  const [providerStates, setProviderStates] = useState(initialProviderStates);
  const [testingAll, setTestingAll] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadEnvironmentStatus = async () => {
      try {
        const response = await fetch("/api/commerce/data-source/status", {
          method: "GET",
          cache: "no-store",
        });
        if (!response.ok) return;
        const payload = (await response.json()) as EnvironmentStatusResponse;
        if (!cancelled) setEnvironmentProviders(payload.providers || {});
      } catch {
        // Environment metadata is convenience UI only. Each real health test resolves env again.
      }
    };

    void loadEnvironmentStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateKey = (provider: LlmProviderId, value: string) => {
    setKeys((current) => ({ ...current, [provider]: value }));
  };

  const updateServiceKey = (
    field: keyof AuxiliaryServiceCredentials,
    value: string,
  ) => {
    setServiceKeys((current) => ({ ...current, [field]: value }));
    setProviderStates((current) => {
      const next = { ...current };
      const owner = PROVIDERS.find((provider) =>
        provider.fields.some((item) => item.key === field),
      );
      if (owner) next[owner.id] = { state: "idle", message: "" };
      return next;
    });
  };

  const toggleVisibility = (field: string) => {
    setVisibleFields((current) => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  const testProvider = async (provider: MarketProviderId) => {
    setProviderStates((current) => ({
      ...current,
      [provider]: { state: "checking", message: "正在验证连接…" },
    }));

    try {
      const response = await fetch("/api/commerce/data-source/status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildCommerceCredentialHeaders(serviceKeys),
        },
        body: JSON.stringify({ provider }),
      });
      const payload = (await response.json()) as ProviderHealthResponse;
      const state = isConnectionState(payload.state)
        ? payload.state
        : payload.ok === true
          ? "connected"
          : "error";
      setProviderStates((current) => ({
        ...current,
        [provider]: {
          state,
          message:
            typeof payload.message === "string"
              ? payload.message
              : response.ok
                ? "连接正常。"
                : "连接验证失败。",
          detail:
            typeof payload.detail === "string" ? payload.detail : undefined,
          latencyMs:
            typeof payload.latencyMs === "number" ? payload.latencyMs : undefined,
        },
      }));
    } catch (error) {
      setProviderStates((current) => ({
        ...current,
        [provider]: {
          state: "network_error",
          message: error instanceof Error ? error.message : "连接验证失败。",
        },
      }));
    }
  };

  const testAllProviders = async () => {
    setTestingAll(true);
    try {
      // Sequential tests avoid firing multiple quota-consuming provider checks at exactly the same
      // moment and make the UI status changes easier to read.
      for (const provider of PROVIDERS) {
        const hasLocal = localProviderConfigured(provider, serviceKeys);
        const hasEnvironment = environmentProviders[provider.id]?.configured === true;
        if (hasLocal || hasEnvironment) await testProvider(provider.id);
      }
    } finally {
      setTestingAll(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized: LlmCredentials = {};
    for (const provider of LLM_PROVIDER_CATALOG) {
      const value = keys[provider.id]?.trim();
      if (value) normalized[provider.id] = value;
    }

    const normalizedServices: AuxiliaryServiceCredentials = {};
    for (const provider of PROVIDERS) {
      for (const field of provider.fields) {
        const value = serviceKeys[field.key]?.trim();
        if (value) Object.assign(normalizedServices, { [field.key]: value });
      }
    }
    onSave(normalized, normalizedServices);
  };

  const configuredCount = useMemo(
    () =>
      PROVIDERS.filter(
        (provider) =>
          localProviderConfigured(provider, serviceKeys) ||
          environmentProviders[provider.id]?.configured === true,
      ).length,
    [environmentProviders, serviceKeys],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{
        background: "rgba(0, 0, 0, 0.30)",
        backdropFilter: "blur(20px) saturate(120%)",
        WebkitBackdropFilter: "blur(20px) saturate(120%)",
      }}
    >
      <form
        onSubmit={submit}
        className="max-h-[90vh] w-[590px] max-w-full overflow-hidden rounded-[24px] border"
        style={{
          background: COLORS.material,
          borderColor: COLORS.border,
          boxShadow:
            "var(--shadow-float), inset 0 1px 0 rgba(255,255,255,0.09)",
        }}
      >
        <div className="px-6 pb-3 pt-6">
          <h2
            className="text-[19px] font-semibold tracking-[-0.02em]"
            style={{ color: COLORS.text }}
          >
            服务与数据源
          </h2>
          <p
            className="mt-2 text-[12px] leading-5"
            style={{ color: COLORS.textMuted }}
          >
            本机填写的凭证只保存在当前设备；打包环境中的默认凭证会在服务端自动回退使用。
          </p>
        </div>

        <div className="max-h-[65vh] space-y-5 overflow-y-auto px-6 pb-5">
          <section>
            <div className="mb-3 text-[11px] font-semibold text-[var(--text-primary)]">
              模型服务
            </div>
            <div className="space-y-3">
              {LLM_PROVIDER_CATALOG.map((provider) => {
                const visible = visibleFields.has(provider.id);
                return (
                  <label key={provider.id} className="block">
                    <span
                      className="mb-1.5 flex items-center justify-between text-[11px] font-medium"
                      style={{ color: COLORS.textMuted }}
                    >
                      <span>{provider.name}</span>
                      <span style={{ color: COLORS.textSubtle }}>
                        {provider.environmentKey}
                      </span>
                    </span>
                    <div
                      className="flex h-11 items-center rounded-[12px] border px-3"
                      style={{
                        background: "var(--glass-black)",
                        borderColor: COLORS.border,
                      }}
                    >
                      <input
                        type={visible ? "text" : "password"}
                        autoComplete="off"
                        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                        style={{ color: COLORS.text }}
                        placeholder={provider.placeholder}
                        value={keys[provider.id] || ""}
                        onChange={(event) =>
                          updateKey(provider.id, event.target.value)
                        }
                      />
                      <button
                        type="button"
                        onClick={() => toggleVisibility(provider.id)}
                        className="ml-2 rounded-full px-2 py-1 text-[10px]"
                        style={{ color: COLORS.textSubtle }}
                      >
                        {visible ? "隐藏" : "显示"}
                      </button>
                    </div>
                  </label>
                );
              })}
            </div>
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold text-[var(--text-primary)]">
                  跨境市场数据
                </div>
                <div className="mt-0.5 text-[9px] leading-4 text-[var(--text-tertiary)]">
                  已检测 {configuredCount}/{PROVIDERS.length} 个可配置来源。单个数据源失败不会阻断其他来源。
                </div>
              </div>
              <button
                type="button"
                onClick={() => void testAllProviders()}
                disabled={testingAll || configuredCount === 0}
                className="h-6 shrink-0 rounded-full border px-2.5 text-[9px] font-medium transition-opacity disabled:opacity-40"
                style={{
                  color: COLORS.blue,
                  borderColor: "rgba(10,132,255,0.20)",
                  background: "rgba(10,132,255,0.06)",
                }}
              >
                {testingAll ? "验证中…" : "全部验证"}
              </button>
            </div>

            <div className="space-y-3">
              {PROVIDERS.map((provider) => {
                const status = providerStates[provider.id];
                const environment = environmentProviders[provider.id];
                const hasLocal = localProviderConfigured(provider, serviceKeys);
                const isConfigured = hasLocal || environment?.configured === true;
                const statusColor = providerStatusColor(status.state);

                return (
                  <div
                    key={provider.id}
                    className="rounded-[16px] border p-3.5"
                    style={{
                      background: "var(--glass-soft)",
                      borderColor: COLORS.border,
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{
                              background:
                                status.state === "idle"
                                  ? isConfigured
                                    ? COLORS.blue
                                    : "var(--text-tertiary)"
                                  : statusColor,
                            }}
                          />
                          <span className="text-[11px] font-semibold text-[var(--text-primary)]">
                            {provider.title}
                          </span>
                          <span
                            className="text-[8px]"
                            style={{ color: statusColor }}
                          >
                            {status.state === "idle"
                              ? isConfigured
                                ? "已配置 · 未验证"
                                : "未配置"
                              : providerStatusLabel(status.state)}
                          </span>
                        </div>
                        <div className="mt-1 text-[9px] leading-4 text-[var(--text-tertiary)]">
                          {provider.subtitle}
                        </div>
                      </div>

                      {/*
                       * Compact capsule button: deliberately small and low-emphasis so it behaves
                       * like an Apple settings accessory, not a large enterprise-console CTA.
                       */}
                      <button
                        type="button"
                        disabled={status.state === "checking" || !isConfigured}
                        onClick={() => void testProvider(provider.id)}
                        className="h-6 shrink-0 rounded-full border px-2 text-[9px] font-medium transition-opacity disabled:opacity-35"
                        style={{
                          color: COLORS.blue,
                          borderColor: "rgba(10,132,255,0.18)",
                          background: "rgba(10,132,255,0.055)",
                        }}
                      >
                        {status.state === "checking" ? "验证中" : "验证"}
                      </button>
                    </div>

                    <div className="mt-3 space-y-2.5">
                      {provider.fields.map((field) => {
                        const fieldId = `${provider.id}:${String(field.key)}`;
                        const visible = visibleFields.has(fieldId);
                        return (
                          <label key={fieldId} className="block">
                            <span className="mb-1 flex items-center justify-between text-[9px] text-[var(--text-secondary)]">
                              <span>{field.label}</span>
                              <span className="text-[8px] text-[var(--text-tertiary)]">
                                {field.environmentKey}
                              </span>
                            </span>
                            <div
                              className="flex h-9 items-center rounded-[10px] border px-2.5"
                              style={{
                                background: "var(--glass-black)",
                                borderColor: COLORS.border,
                              }}
                            >
                              <input
                                type={field.secret && !visible ? "password" : "text"}
                                autoComplete="off"
                                className="min-w-0 flex-1 bg-transparent text-[11px] outline-none"
                                style={{ color: COLORS.text }}
                                placeholder={
                                  environment?.configured === true
                                    ? "已有默认环境配置；可留空"
                                    : field.placeholder
                                }
                                value={serviceKeys[field.key] || ""}
                                onChange={(event) =>
                                  updateServiceKey(field.key, event.target.value)
                                }
                              />
                              {field.secret ? (
                                <button
                                  type="button"
                                  onClick={() => toggleVisibility(fieldId)}
                                  className="ml-2 rounded-full px-1.5 py-0.5 text-[9px] text-[var(--text-tertiary)]"
                                >
                                  {visible ? "隐藏" : "显示"}
                                </button>
                              ) : null}
                            </div>
                          </label>
                        );
                      })}
                    </div>

                    <div className="mt-2.5 text-[8px] leading-4 text-[var(--text-tertiary)]">
                      {status.message || provider.note}
                      {status.detail ? ` ${status.detail}` : ""}
                      {status.latencyMs !== undefined
                        ? ` · ${status.latencyMs} ms`
                        : ""}
                      {environment?.fingerprint
                        ? ` · 默认凭证 ${String(environment.fingerprint)}`
                        : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <div
          className="flex gap-2 border-t px-6 py-4"
          style={{ borderColor: COLORS.border }}
        >
          <button
            type="button"
            onClick={onClose}
            className="h-10 flex-1 rounded-[12px] border text-[12px] font-medium"
            style={{
              background: COLORS.materialSoft,
              borderColor: COLORS.border,
              color: COLORS.textMuted,
            }}
          >
            取消
          </button>
          <button
            type="submit"
            className="h-10 flex-1 rounded-[12px] text-[12px] font-semibold text-white"
            style={{
              background: "linear-gradient(180deg, #168dff 0%, #0879eb 100%)",
            }}
          >
            保存配置
          </button>
        </div>
      </form>
    </div>
  );
}
