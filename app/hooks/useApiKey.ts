"use client";

import { useCallback, useState } from "react";
import {
  LLM_PROVIDER_CATALOG,
  LLM_PROVIDER_IDS,
} from "../lib/llm/registry/providers";
import type { LlmCredentials } from "../lib/llm/types";

function readStoredKeys(): LlmCredentials {
  if (typeof window === "undefined") return {};
  const result: LlmCredentials = {};

  for (const provider of LLM_PROVIDER_CATALOG) {
    const value = window.localStorage.getItem(provider.environmentKey);
    if (value) result[provider.id] = value;
  }
  return result;
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

/**
 * 多 Provider Key 管理。
 *
 * Provider 列表来自公共注册表，后续新增 DeepSeek、GLM、Kimi 等服务时，
 * 不需要重复修改本 Hook 的字段定义。
 */
export function useApiKey() {
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [apiKeys, setApiKeys] = useState<LlmCredentials>(readStoredKeys);

  const handleSaveKeys = useCallback((nextKeys: LlmCredentials) => {
    persistKeys(nextKeys);
    setApiKeys(nextKeys);
    setShowKeyModal(false);
  }, []);

  return {
    apiKeys,
    showKeyModal,
    openKeyModal: () => setShowKeyModal(true),
    closeKeyModal: () => setShowKeyModal(false),
    handleSaveKeys,
  };
}
