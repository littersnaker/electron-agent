// 模块说明：加载、创建、修改和删除 SQLite 自定义模型。
"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../lib/api-client";
import type {
  CustomModelInput,
  CustomModelListResponse,
  CustomModelMutationResponse,
  CustomModelRecord,
} from "../lib/llm/custom-models";

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string") return payload.error;
  } catch {
    // 非 JSON 错误使用状态码兜底。
  }
  return `自定义模型请求失败（HTTP ${response.status}）`;
}

export function useCustomModels() {
  const [models, setModels] = useState<CustomModelRecord[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const response = await apiFetch("/api/models/custom", { cache: "no-store" });
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json()) as CustomModelListResponse;
    setModels(Array.isArray(payload.models) ? payload.models : []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void reload().catch((error) => {
      console.warn("[Renderer] 自定义模型加载失败", error);
      setLoaded(true);
    });
  }, [reload]);

  const createModel = useCallback(async (input: CustomModelInput) => {
    const response = await apiFetch("/api/models/custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json()) as CustomModelMutationResponse;
    setModels((current) => [...current, payload.model]);
    return payload.model;
  }, []);

  const updateModel = useCallback(
    async (modelId: string, input: CustomModelInput) => {
      const response = await apiFetch(
        `/api/models/custom/${encodeURIComponent(modelId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!response.ok) throw new Error(await readError(response));
      const payload = (await response.json()) as CustomModelMutationResponse;
      setModels((current) =>
        current.map((item) => (item.id === modelId ? payload.model : item)),
      );
      return payload.model;
    },
    [],
  );

  const deleteModel = useCallback(async (modelId: string) => {
    const response = await apiFetch(
      `/api/models/custom/${encodeURIComponent(modelId)}`,
      { method: "DELETE" },
    );
    if (!response.ok) throw new Error(await readError(response));
    setModels((current) => current.filter((item) => item.id !== modelId));
  }, []);

  return {
    models,
    loaded,
    reload,
    createModel,
    updateModel,
    deleteModel,
  };
}
