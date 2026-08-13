// 模块说明：跨重启保存聊天模型与媒体模型选择，并迁移旧版模型 ID。
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AUTO_MODEL_ID,
  isKnownModelId,
  normalizeModelId,
} from "../lib/llm/registry/models";
import {
  DEFAULT_MEDIA_MODEL_ID,
  getMediaModelDefinition,
} from "../lib/media/catalog";

const CHAT_MODEL_STORAGE_KEY = "agent-workspace:selected-chat-model:v2";
const MEDIA_MODEL_STORAGE_KEY = "agent-workspace:selected-media-model:v2";

/** 读取纯浏览器模式或旧 Electron Origin 中的模型选择。 */
function readLocalSelection(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return window.localStorage.getItem(key)?.trim() || fallback;
}

/** 校验并迁移聊天模型 ID。 */
function normalizeChatModel(value: string | undefined): string {
  const normalized = normalizeModelId(value?.trim() || AUTO_MODEL_ID);
  return isKnownModelId(normalized) || normalized.startsWith("custom:")
    ? normalized
    : AUTO_MODEL_ID;
}

/** 校验媒体模型 ID，删除注册表中已经不存在的旧选项；自定义媒体模型放行。 */
function normalizeMediaModel(value: string | undefined): string {
  const normalized = value?.trim() || DEFAULT_MEDIA_MODEL_ID;
  if (normalized.startsWith("custom:")) return normalized;
  return getMediaModelDefinition(normalized)
    ? normalized
    : DEFAULT_MEDIA_MODEL_ID;
}

/** 管理模型选择，并同时保存到 Electron 固定偏好文件与 localStorage 后备。 */
export function useModelSelection() {
  const [selectedChatModel, setSelectedChatModelState] = useState(() =>
    normalizeChatModel(readLocalSelection(CHAT_MODEL_STORAGE_KEY, AUTO_MODEL_ID)),
  );
  const [selectedMediaModel, setSelectedMediaModelState] = useState(() =>
    normalizeMediaModel(
      readLocalSelection(MEDIA_MODEL_STORAGE_KEY, DEFAULT_MEDIA_MODEL_ID),
    ),
  );

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const localChat = normalizeChatModel(
        readLocalSelection(CHAT_MODEL_STORAGE_KEY, AUTO_MODEL_ID),
      );
      const localMedia = normalizeMediaModel(
        readLocalSelection(MEDIA_MODEL_STORAGE_KEY, DEFAULT_MEDIA_MODEL_ID),
      );
      const preferences = window.electronAPI?.preferences
        ? await window.electronAPI.preferences.read().catch(() => ({}))
        : {};
      const chat = normalizeChatModel(preferences.selectedChatModel || localChat);
      const media = normalizeMediaModel(
        preferences.selectedMediaModel || localMedia,
      );
      if (cancelled) return;

      setSelectedChatModelState(chat);
      setSelectedMediaModelState(media);
      window.localStorage.setItem(CHAT_MODEL_STORAGE_KEY, chat);
      window.localStorage.setItem(MEDIA_MODEL_STORAGE_KEY, media);
      if (window.electronAPI?.preferences) {
        void window.electronAPI.preferences.write({
          selectedChatModel: chat,
          selectedMediaModel: media,
        });
      }
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  const setSelectedChatModel = useCallback((value: string) => {
    const normalized = normalizeChatModel(value);
    setSelectedChatModelState(normalized);
    window.localStorage.setItem(CHAT_MODEL_STORAGE_KEY, normalized);
    void window.electronAPI?.preferences.write({
      selectedChatModel: normalized,
    });
  }, []);

  const setSelectedMediaModel = useCallback((value: string) => {
    const normalized = normalizeMediaModel(value);
    setSelectedMediaModelState(normalized);
    window.localStorage.setItem(MEDIA_MODEL_STORAGE_KEY, normalized);
    void window.electronAPI?.preferences.write({
      selectedMediaModel: normalized,
    });
  }, []);

  return {
    selectedChatModel,
    selectedMediaModel,
    setSelectedChatModel,
    setSelectedMediaModel,
  };
}
