"use client";
/**
 * 模块职责：API 密钥与数据源连接配置弹窗。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { LLM_PROVIDER_CATALOG } from "../../lib/llm/registry/providers";
import type {
  LlmCredentials,
  LlmEndpointOverrides,
  LlmProviderId,
} from "../../lib/llm/types";
import {
  buildCommerceCredentialHeaders,
  type AuxiliaryServiceCredentials,
} from "../../lib/service-credentials";
import { apiFetch } from "../../lib/api-client";
import {
  AppleButton,
  AppleModalCloseButton,
} from "../ui/AppleModalControls";
import { LlmProviderSettings } from "./llm-provider-settings";
import {
  COLORS,
  type EnvironmentStatusResponse,
  type MarketProviderId,
  PROVIDERS,
  type Props,
  type ProviderEnvironmentStatus,
  type ProviderHealthResponse,
  initialProviderStates,
  isConnectionState,
  localProviderConfigured,
  providerStatusColor,
  providerStatusLabel,
} from "./provider-settings";
export function ApiKeyModal({
  initialKeys,
  initialEndpoints,
  initialServiceKeys,
  onSave,
  onClose,
}: Props) {
  const [keys, setKeys] = useState<LlmCredentials>(initialKeys);
  const [endpoints, setEndpoints] =
    useState<LlmEndpointOverrides>(initialEndpoints);
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
        const response = await apiFetch("/api/commerce/data-source/status", {
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

  const updateEndpoint = (provider: LlmProviderId, value: string) => {
    setEndpoints((current) => ({ ...current, [provider]: value }));
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
      const response = await apiFetch("/api/commerce/data-source/status", {
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

    const normalizedEndpoints: LlmEndpointOverrides = {};
    for (const provider of LLM_PROVIDER_CATALOG) {
      const value = endpoints[provider.id]?.trim();
      if (value) normalizedEndpoints[provider.id] = value;
    }

    const normalizedServices: AuxiliaryServiceCredentials = {};
    for (const provider of PROVIDERS) {
      for (const field of provider.fields) {
        const value = serviceKeys[field.key]?.trim();
        if (value) Object.assign(normalizedServices, { [field.key]: value });
      }
    }
    onSave(normalized, normalizedEndpoints, normalizedServices);
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
    <div className="fixed inset-0 z-[200] flex items-center justify-center px-4 py-8">
      <button
        type="button"
        aria-label="关闭服务与数据源弹窗"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
        style={{
          background: "rgba(7, 8, 12, 0.34)",
          backdropFilter: "blur(20px) saturate(125%)",
          WebkitBackdropFilter: "blur(20px) saturate(125%)",
        }}
      />

      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="service-settings-title"
        onSubmit={submit}
        className="relative max-h-[90vh] w-[610px] max-w-full overflow-hidden rounded-[28px] border"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--glass-solid) 98%, transparent), color-mix(in srgb, var(--glass-strong) 96%, transparent))",
          borderColor: COLORS.border,
          boxShadow:
            "0 34px 100px rgba(15,23,42,0.24), inset 0 1px 0 rgba(255,255,255,0.32)",
          backdropFilter: "blur(36px) saturate(155%)",
          WebkitBackdropFilter: "blur(36px) saturate(155%)",
        }}
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-6">
          <div>
            <h2
              id="service-settings-title"
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
          <AppleModalCloseButton onClick={onClose} />
        </header>

        <div className="max-h-[65vh] space-y-5 overflow-y-auto px-6 pb-5">
          <LlmProviderSettings
            keys={keys}
            endpoints={endpoints}
            visibleFields={visibleFields}
            updateKey={updateKey}
            updateEndpoint={updateEndpoint}
            toggleVisibility={toggleVisibility}
          />

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
              <AppleButton
                type="button"
                variant="accent"
                size="xs"
                onClick={() => void testAllProviders()}
                disabled={testingAll || configuredCount === 0}
                className="shrink-0"
              >
                {testingAll ? "验证中…" : "全部验证"}
              </AppleButton>
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
                      <AppleButton
                        type="button"
                        variant="accent"
                        size="xs"
                        disabled={status.state === "checking" || !isConfigured}
                        onClick={() => void testProvider(provider.id)}
                        className="shrink-0"
                      >
                        {status.state === "checking" ? "验证中" : "验证"}
                      </AppleButton>
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
                                <AppleButton
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => toggleVisibility(fieldId)}
                                  className="ml-2"
                                  style={{ color: "var(--text-tertiary)" }}
                                >
                                  {visible ? "隐藏" : "显示"}
                                </AppleButton>
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

        <footer
          className="flex gap-2 border-t px-6 py-4"
          style={{ borderColor: COLORS.border }}
        >
          <AppleButton
            type="button"
            variant="secondary"
            fullWidth
            onClick={onClose}
          >
            取消
          </AppleButton>
          <AppleButton type="submit" variant="primary" fullWidth>
            保存配置
          </AppleButton>
        </footer>
      </form>
    </div>
  );
}
