// 模块说明：统一管理模型与数据源凭证，并在 Electron 中跨重启持久化。
"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api-client";
import {
  credentialStoreToSnapshot,
  readLegacyLocalCredentialStore,
  snapshotToCredentialStore,
  writeLegacyLocalCredentialStore,
} from "../lib/local-credentials";
import type { LlmCredentials, LlmEndpointOverrides } from "../lib/llm/types";
import type { AuxiliaryServiceCredentials } from "../lib/service-credentials";

export type CommerceDataSourceState = "environment" | "local" | "none";

interface DataSourceStatusResponse {
  environmentConfigured?: unknown;
}

/** 让首次 React 渲染立即继承当前 Origin 中的旧数据，避免设置弹窗闪空。 */
function readInitialSnapshot() {
  return credentialStoreToSnapshot(readLegacyLocalCredentialStore());
}

/**
 * Local credential manager shared by QA / Code / Commerce.
 *
 * Electron 中的 API Key 写入主进程固定目录，并在系统支持时通过 safeStorage 加密；
 * localStorage 仅用于纯浏览器开发模式和旧版本迁移。任何凭证都不会写入日志。
 */
export function useApiKey() {
  const initial = readInitialSnapshot();
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [apiKeys, setApiKeys] = useState<LlmCredentials>(initial.llm);
  const [endpointOverrides, setEndpointOverrides] =
    useState<LlmEndpointOverrides>(initial.endpoints);
  const [serviceKeys, setServiceKeys] =
    useState<AuxiliaryServiceCredentials>(initial.services);
  const [credentialsReady, setCredentialsReady] = useState(false);
  const [environmentMarketDataConfigured, setEnvironmentMarketDataConfigured] =
    useState(false);

  useEffect(() => {
    let cancelled = false;

    const hydrateCredentials = async () => {
      const legacyStore = readLegacyLocalCredentialStore();
      const electronStore = window.electronAPI?.credentials
        ? await window.electronAPI.credentials.read().catch(() => ({}))
        : {};
      // 已稳定保存的主进程记录优先；旧 Origin 中独有的字段用于一次性迁移。
      const mergedStore = { ...legacyStore, ...electronStore };
      const snapshot = credentialStoreToSnapshot(mergedStore);
      if (cancelled) return;

      setApiKeys(snapshot.llm);
      setEndpointOverrides(snapshot.endpoints);
      setServiceKeys(snapshot.services);
      setCredentialsReady(true);
      writeLegacyLocalCredentialStore(mergedStore);

      if (window.electronAPI?.credentials) {
        // 覆盖写回可将旧 localStorage 中的 Key 迁移到稳定凭证文件。
        void window.electronAPI.credentials.write(mergedStore).catch((error) => {
          console.warn("[Renderer] API Key 持久化迁移失败", error);
        });
      }
    };

    void hydrateCredentials();
    return () => {
      cancelled = true;
    };
  }, []);

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
        // 状态元数据仅用于提示，真实请求仍会在服务端重新解析环境变量。
      }
    };
    void loadStatus();
    return () => {
      cancelled = true;
    };
  }, [showKeyModal]);

  const handleSaveKeys = useCallback(
    (
      nextKeys: LlmCredentials,
      nextEndpoints: LlmEndpointOverrides,
      nextServiceKeys: AuxiliaryServiceCredentials,
    ) => {
      const store = snapshotToCredentialStore(
        nextKeys,
        nextEndpoints,
        nextServiceKeys,
      );
      writeLegacyLocalCredentialStore(store);
      if (window.electronAPI?.credentials) {
        void window.electronAPI.credentials.write(store).catch((error) => {
          console.warn("[Renderer] API Key 写入主进程失败", error);
        });
      }
      setApiKeys(nextKeys);
      setEndpointOverrides(nextEndpoints);
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
    endpointOverrides,
    serviceKeys,
    credentialsReady,
    commerceDataSourceState,
    showKeyModal,
    openKeyModal: () => setShowKeyModal(true),
    closeKeyModal: () => setShowKeyModal(false),
    handleSaveKeys,
  };
}
