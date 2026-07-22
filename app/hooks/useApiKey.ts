"use client";

import { useCallback, useEffect, useState } from "react";

export function useApiKey() {
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch("/api/config");
        const { hasDefaultKey } = (await response.json()) as {
          hasDefaultKey: boolean;
        };
        const savedKey = localStorage.getItem("DASHSCOPE_API_KEY") || "";

        setApiKey(savedKey);
        if (!hasDefaultKey && !savedKey) setShowKeyModal(true);
      } catch (error) {
        console.error("无法读取 API Key 配置", error);
      }
    };

    void checkAuth();
  }, []);

  const handleSaveKey = useCallback((key?: string) => {
    if (key) {
      localStorage.setItem("DASHSCOPE_API_KEY", key);
      setApiKey(key);
    }
    setShowKeyModal(false);
  }, []);

  return {
    apiKey,
    showKeyModal,
    openKeyModal: () => setShowKeyModal(true),
    handleSaveKey,
  };
}
