// 模块说明：角色设定图库加载与删除（跨会话复用设定图）。
"use client";

import { useCallback, useState } from "react";
import { apiFetch } from "../lib/api-client";

export type CharacterLibraryAsset = {
  id: string;
  name: string;
  modelId: string;
  provider: string;
  prompt: string;
  createdAt: string;
  dataUrl?: string;
};

type CharacterLibraryResponse = {
  assets: CharacterLibraryAsset[];
};

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; detail?: unknown };
    if (typeof payload.detail === "string") return payload.detail;
    if (typeof payload.error === "string") return payload.error;
  } catch {
    // 非 JSON 错误使用状态码兜底。
  }
  return `角色库请求失败（HTTP ${response.status}）`;
}

export function useCharacterLibrary() {
  const [assets, setAssets] = useState<CharacterLibraryAsset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoaded(false);
    setError("");
    try {
      const response = await apiFetch("/api/media/library", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const payload = (await response.json()) as CharacterLibraryResponse;
      setAssets(Array.isArray(payload.assets) ? payload.assets : []);
    } catch (error) {
      setError(error instanceof Error ? error.message : "角色库加载失败，请重试。");
    } finally {
      setLoaded(true);
    }
  }, []);

  const deleteAsset = useCallback(async (assetId: string) => {
    setError("");
    try {
      const response = await apiFetch(`/api/media/library/${encodeURIComponent(assetId)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(await readError(response));
      setAssets((current) => current.filter((item) => item.id !== assetId));
    } catch (error) {
      setError(error instanceof Error ? error.message : "删除失败，请重试。");
    }
  }, []);

  return { assets, loaded, error, reload, deleteAsset };
}
