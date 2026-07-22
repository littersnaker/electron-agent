"use client";

import { useCallback, useState } from "react";
import type { LlmCredentials, LlmProviderId } from "../lib/llm/types";

const STORAGE_KEYS: Record<LlmProviderId, string> = {
  qwen: "DASHSCOPE_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

function readStoredKeys(): LlmCredentials {
  if (typeof window === "undefined") return {};
  return {
    qwen: window.localStorage.getItem(STORAGE_KEYS.qwen) || undefined,
    openai: window.localStorage.getItem(STORAGE_KEYS.openai) || undefined,
    gemini: window.localStorage.getItem(STORAGE_KEYS.gemini) || undefined,
  };
}

function persistKeys(keys: LlmCredentials): void {
  for (const provider of Object.keys(STORAGE_KEYS) as LlmProviderId[]) {
    const value = keys[provider]?.trim();
    if (value) {
      window.localStorage.setItem(STORAGE_KEYS[provider], value);
    } else {
      window.localStorage.removeItem(STORAGE_KEYS[provider]);
    }
  }
}

/**
 * 多 Provider Key 管理。
 *
 * 使用 lazy initializer 读取 localStorage，不通过 useEffect 同步状态，
 * 避免 React Hooks ESLint 的 set-state-in-effect 问题。
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
