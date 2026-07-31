// 模块说明：负责 useApiKey 状态管理与业务编排。
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  LLM_PROVIDER_CATALOG,
  LLM_PROVIDER_IDS,
} from "../lib/llm/registry/providers";
import { apiFetch } from "../lib/api-client";
import type { LlmCredentials } from "../lib/llm/types";
import {
  COMMERCE_STORAGE_KEYS,
  type AuxiliaryServiceCredentials,
} from "../lib/service-credentials";

export type CommerceDataSourceState = "environment" | "local" | "none";

interface DataSourceStatusResponse {
  environmentConfigured?: unknown;
}

function readStoredKeys(): LlmCredentials {
  if (typeof window === "undefined") return {};
  const result: LlmCredentials = {};

  for (const provider of LLM_PROVIDER_CATALOG) {
    const value = window.localStorage.getItem(provider.environmentKey);
    if (value) result[provider.id] = value;
  }
  return result;
}

function readStorageValue(key: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value = window.localStorage.getItem(key)?.trim();
  return value || undefined;
}

function readStoredServiceKeys(): AuxiliaryServiceCredentials {
  if (typeof window === "undefined") return {};

  // v5-v7 stored the TalorData token under SERPAPI_API_KEY. Prefer the new provider-specific key,
  // but transparently migrate the old value so an upgrade never silently loses the user's token.
  const talorDataToken =
    readStorageValue(COMMERCE_STORAGE_KEYS.talorDataToken) ||
    readStorageValue(COMMERCE_STORAGE_KEYS.legacySerpApi);

  return {
    talorDataToken,
    keepaApiKey: readStorageValue(COMMERCE_STORAGE_KEYS.keepaApiKey),
    tiktokClientKey: readStorageValue(COMMERCE_STORAGE_KEYS.tiktokClientKey),
    tiktokClientSecret: readStorageValue(COMMERCE_STORAGE_KEYS.tiktokClientSecret),
    tiktokMerchantId: readStorageValue(COMMERCE_STORAGE_KEYS.tiktokMerchantId),
    temuAppKey: readStorageValue(COMMERCE_STORAGE_KEYS.temuAppKey),
    temuAppSecret: readStorageValue(COMMERCE_STORAGE_KEYS.temuAppSecret),
    temuAccessToken: readStorageValue(COMMERCE_STORAGE_KEYS.temuAccessToken),
    alibaba1688AppKey: readStorageValue(COMMERCE_STORAGE_KEYS.alibaba1688AppKey),
    alibaba1688AppSecret: readStorageValue(COMMERCE_STORAGE_KEYS.alibaba1688AppSecret),
    alibaba1688AccessToken: readStorageValue(COMMERCE_STORAGE_KEYS.alibaba1688AccessToken),
  };
}

function persistKeys(keys: LlmCredentials): void {
  for (const providerId of LLM_PROVIDER_IDS) {
    const provider = LLM_PROVIDER_CATALOG.find(
      (item) => item.id === providerId,
    );
    if (!provider) continue;

    const value = keys[providerId]?.trim();
    if (value) {
      window.localStorage.setItem(provider.environmentKey, value);
    } else {
      window.localStorage.removeItem(provider.environmentKey);
    }
  }
}

function writeStorageValue(key: string, value?: string): void {
  const normalized = value?.trim();
  if (normalized) window.localStorage.setItem(key, normalized);
  else window.localStorage.removeItem(key);
}

function persistServiceKeys(keys: AuxiliaryServiceCredentials): void {
  writeStorageValue(COMMERCE_STORAGE_KEYS.talorDataToken, keys.talorDataToken);
  writeStorageValue(COMMERCE_STORAGE_KEYS.keepaApiKey, keys.keepaApiKey);
  writeStorageValue(COMMERCE_STORAGE_KEYS.tiktokClientKey, keys.tiktokClientKey);
  writeStorageValue(COMMERCE_STORAGE_KEYS.tiktokClientSecret, keys.tiktokClientSecret);
  writeStorageValue(COMMERCE_STORAGE_KEYS.tiktokMerchantId, keys.tiktokMerchantId);
  writeStorageValue(COMMERCE_STORAGE_KEYS.temuAppKey, keys.temuAppKey);
  writeStorageValue(COMMERCE_STORAGE_KEYS.temuAppSecret, keys.temuAppSecret);
  writeStorageValue(COMMERCE_STORAGE_KEYS.temuAccessToken, keys.temuAccessToken);
  writeStorageValue(COMMERCE_STORAGE_KEYS.alibaba1688AppKey, keys.alibaba1688AppKey);
  writeStorageValue(COMMERCE_STORAGE_KEYS.alibaba1688AppSecret, keys.alibaba1688AppSecret);
  writeStorageValue(COMMERCE_STORAGE_KEYS.alibaba1688AccessToken, keys.alibaba1688AccessToken);

  // Once the new key has been persisted, remove the misleading legacy key. Reading it remains
  // supported above for users who upgrade without ever opening the settings modal.
  if (keys.talorDataToken?.trim()) {
    window.localStorage.removeItem(COMMERCE_STORAGE_KEYS.legacySerpApi);
  }
}

/**
 * Local credential manager shared by QA / Code / Commerce.
 *
 * The browser never receives packaged environment secrets. It only receives boolean/fingerprint
 * metadata from the status API, while actual provider requests are executed server-side.
 */
export function useApiKey() {
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [apiKeys, setApiKeys] = useState<LlmCredentials>(readStoredKeys);
  const [serviceKeys, setServiceKeys] =
    useState<AuxiliaryServiceCredentials>(readStoredServiceKeys);
  const [environmentMarketDataConfigured, setEnvironmentMarketDataConfigured] =
    useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadStatus = async () => {
      try {
        const response = await apiFetch("/api/commerce/data-source/status", {
          method: "GET",
          cache: "no-store",
        });
        if (!response.ok) return;
        const payload = (await response.json()) as DataSourceStatusResponse;
        if (!cancelled) {
          setEnvironmentMarketDataConfigured(
            payload.environmentConfigured === true,
          );
        }
      } catch {
        // Status metadata is optional; a research request will still resolve environment keys again.
      }
    };

    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [showKeyModal]);

  const handleSaveKeys = useCallback(
    (nextKeys: LlmCredentials, nextServiceKeys: AuxiliaryServiceCredentials) => {
      persistKeys(nextKeys);
      persistServiceKeys(nextServiceKeys);
      setApiKeys(nextKeys);
      setServiceKeys(nextServiceKeys);
      setShowKeyModal(false);
    },
    [],
  );

  const commerceDataSourceState: CommerceDataSourceState =
    serviceKeys.talorDataToken?.trim()
      ? "local"
      : environmentMarketDataConfigured
        ? "environment"
        : "none";

  return {
    apiKeys,
    serviceKeys,
    commerceDataSourceState,
    showKeyModal,
    openKeyModal: () => setShowKeyModal(true),
    closeKeyModal: () => setShowKeyModal(false),
    handleSaveKeys,
  };
}
