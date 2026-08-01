"use client";
/** 模块职责：渲染模型供应商凭证、Base URL，并执行真实最小请求验证。 */
import { useState } from "react";
import { apiFetch } from "../../lib/api-client";
import { buildLlmRequestHeaders } from "../../lib/llm/client-request";
import { getDefaultModelForProvider } from "../../lib/llm/registry/models";
import { LLM_PROVIDER_CATALOG } from "../../lib/llm/registry/providers";
import type {
  LlmCredentials,
  LlmEndpointOverrides,
  LlmProviderId,
} from "../../lib/llm/types";
import { AppleButton } from "../ui/AppleModalControls";
import {
  COLORS,
  type ConnectionState,
  providerStatusColor,
  providerStatusLabel,
  type ProviderViewState,
} from "./provider-settings";

interface Props {
  keys: LlmCredentials;
  endpoints: LlmEndpointOverrides;
  visibleFields: ReadonlySet<string>;
  updateKey: (provider: LlmProviderId, value: string) => void;
  updateEndpoint: (provider: LlmProviderId, value: string) => void;
  toggleVisibility: (field: string) => void;
}

interface ProbeResponse {
  ok?: unknown;
  state?: unknown;
  message?: unknown;
  latencyMs?: unknown;
  model?: unknown;
  credentialSource?: unknown;
}

/** 为所有供应商生成独立状态，避免一次验证覆盖其他行。 */
function createInitialStates(): Record<LlmProviderId, ProviderViewState> {
  return Object.fromEntries(
    LLM_PROVIDER_CATALOG.map((provider) => [
      provider.id,
      { state: "idle", message: "" },
    ]),
  ) as Record<LlmProviderId, ProviderViewState>;
}

/** 仅接受设置弹窗支持的连接状态。 */
function normalizeState(value: unknown, ok: boolean): ConnectionState {
  const candidate = String(value);
  if (
    [
      "connected",
      "unconfigured",
      "unauthorized",
      "quota_exceeded",
      "network_error",
      "error",
    ].includes(candidate)
  ) {
    return candidate as ConnectionState;
  }
  return ok ? "connected" : "error";
}

/** 根据供应商提供易理解的 Base URL 示例，不把聊天路径写死到用户输入中。 */
function endpointPlaceholder(providerId: LlmProviderId): string {
  switch (providerId) {
    case "qwen":
      return "https://<业务空间域名>/compatible-mode/v1";
    case "openai":
      return "https://api.openai.com/v1";
    case "deepseek":
      return "https://api.deepseek.com";
    case "glm":
      return "https://open.bigmodel.cn/api/paas/v4";
    case "kimi":
      return "https://api.moonshot.cn/v1";
    default:
      return "https://example.com/v1";
  }
}

/** 模型服务设置区；验证会真实调用供应商候选链，而非只检查 Key 格式。 */
export function LlmProviderSettings({
  keys,
  endpoints,
  visibleFields,
  updateKey,
  updateEndpoint,
  toggleVisibility,
}: Props) {
  const [states, setStates] = useState(createInitialStates);

  const testProvider = async (providerId: LlmProviderId) => {
    const model = getDefaultModelForProvider(providerId);
    if (!model) return;
    setStates((current) => ({
      ...current,
      [providerId]: { state: "checking", message: "正在探测可用模型…" },
    }));

    try {
      const response = await apiFetch("/api/models/probe", {
        method: "POST",
        headers: buildLlmRequestHeaders(keys, model.id, endpoints),
        // 按供应商验证；后端会在模型级失败时继续测试该厂商备用模型。
        body: JSON.stringify({ provider: providerId }),
      });
      const payload = (await response.json()) as ProbeResponse;
      const ok = payload.ok === true;
      setStates((current) => ({
        ...current,
        [providerId]: {
          state: normalizeState(payload.state, ok),
          message:
            typeof payload.message === "string"
              ? payload.message
              : ok
                ? `${model.name} 连接正常。`
                : `${model.name} 连接验证失败。`,
          latencyMs:
            typeof payload.latencyMs === "number"
              ? payload.latencyMs
              : undefined,
        },
      }));
    } catch (error) {
      setStates((current) => ({
        ...current,
        [providerId]: {
          state: "network_error",
          message: error instanceof Error ? error.message : "连接验证失败。",
        },
      }));
    }
  };

  return (
    <section>
      <div className="mb-3">
        <div className="text-[11px] font-semibold text-[var(--text-primary)]">
          模型服务
        </div>
        <div className="mt-0.5 text-[9px] leading-4 text-[var(--text-tertiary)]">
          Auto 会先使用近期验证成功的模型；模型不存在时向下兼容，端点断网或鉴权失败时跳过该供应商。
        </div>
      </div>
      <div className="space-y-3">
        {LLM_PROVIDER_CATALOG.map((provider) => {
          const visible = visibleFields.has(provider.id);
          const status = states[provider.id];
          const model = getDefaultModelForProvider(provider.id);
          const color = providerStatusColor(status.state);
          return (
            <div
              key={provider.id}
              className="rounded-[14px] border p-3"
              style={{
                background: "var(--glass-soft)",
                borderColor: COLORS.border,
              }}
            >
              <div
                className="mb-1.5 flex items-center justify-between text-[11px] font-medium"
                style={{ color: COLORS.textMuted }}
              >
                <span>{provider.name}</span>
                <span style={{ color: COLORS.textSubtle }}>
                  {model?.model || provider.environmentKey}
                </span>
              </div>
              <div
                className="flex h-11 items-center rounded-[12px] border px-3"
                style={{
                  background: "var(--glass-black)",
                  borderColor: COLORS.border,
                }}
              >
                <input
                  aria-label={`${provider.name} API Key`}
                  type={visible ? "text" : "password"}
                  autoComplete="off"
                  className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                  style={{ color: COLORS.text }}
                  placeholder={
                    provider.id === "qwen"
                      ? "留空使用内置百炼兜底，也可填写自己的 Key"
                      : provider.placeholder
                  }
                  value={keys[provider.id] || ""}
                  onChange={(event) =>
                    updateKey(provider.id, event.target.value)
                  }
                />
                <AppleButton
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => toggleVisibility(provider.id)}
                  className="ml-2"
                  style={{ color: COLORS.textSubtle }}
                >
                  {visible ? "隐藏" : "显示"}
                </AppleButton>
                <AppleButton
                  type="button"
                  variant="accent"
                  size="xs"
                  onClick={() => void testProvider(provider.id)}
                  disabled={status.state === "checking"}
                  className="ml-1"
                >
                  {status.state === "checking" ? "验证中…" : "验证"}
                </AppleButton>
              </div>

              {provider.endpointEnvironmentKey ? (
                <label className="mt-2 block">
                  <span className="mb-1 flex items-center justify-between text-[9px] text-[var(--text-secondary)]">
                    <span>API Base URL（可选）</span>
                    <span className="text-[8px] text-[var(--text-tertiary)]">
                      {provider.endpointEnvironmentKey}
                    </span>
                  </span>
                  <input
                    aria-label={`${provider.name} API Base URL`}
                    type="url"
                    autoComplete="off"
                    className="h-9 w-full rounded-[10px] border bg-[var(--glass-black)] px-3 text-[11px] outline-none"
                    style={{ color: COLORS.text, borderColor: COLORS.border }}
                    placeholder={endpointPlaceholder(provider.id)}
                    value={endpoints[provider.id] || ""}
                    onChange={(event) =>
                      updateEndpoint(provider.id, event.target.value)
                    }
                  />
                </label>
              ) : null}

              {provider.id === "qwen" ? (
                <div className="mt-1.5 text-[9px] leading-4 text-[var(--text-tertiary)]">
                  建议粘贴百炼控制台当前业务空间的
                  <span className="font-mono"> /compatible-mode/v1 </span>
                  地址。保存后聊天、图片和视频请求都会使用该业务空间；媒体接口会自动去掉
                  <span className="font-mono"> /compatible-mode/v1 </span>
                  再拼接 DashScope 原生路径。设置页值优先于后端环境变量，单个自定义模型填写的
                  Base URL 又优先于设置页。
                </div>
              ) : null}

              {status.state !== "idle" ? (
                <div className="mt-1.5 flex items-start gap-1.5 text-[9px] leading-4">
                  <span className="shrink-0 font-medium" style={{ color }}>
                    {providerStatusLabel(status.state)}
                  </span>
                  <span className="min-w-0 break-words" style={{ color }}>
                    {status.message}
                    {typeof status.latencyMs === "number"
                      ? `（${status.latencyMs} ms）`
                      : ""}
                  </span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
