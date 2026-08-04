// 模块说明：模型选择器；聊天模式支持新增、修改和删除 SQLite 自定义模型。
"use client";

import { useEffect, useRef, useState } from "react";
import type { ModelOption } from "../constants/modelList";
import type { CustomModelInput } from "../lib/llm/custom-models";
import CustomModelModal from "./CustomModelModal";

interface Props {
  models: readonly ModelOption[];
  selectedModel: string;
  onSelect: (modelId: string) => void;
  onCreateCustomModel?: (input: CustomModelInput) => Promise<void>;
  onUpdateCustomModel?: (
    modelId: string,
    input: CustomModelInput,
  ) => Promise<void>;
  onDeleteCustomModel?: (modelId: string) => Promise<void>;
}

const COLORS = {
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  textSubtle: "var(--text-tertiary)",
  material: "var(--glass)",
  materialStrong: "var(--glass-solid)",
  border: "var(--border)",
  blue: "var(--accent-blue)",
  selection: "var(--selection-bg)",
  selectionBorder: "var(--selection-border)",
};

export default function ModelSelector({
  models,
  selectedModel,
  onSelect,
  onCreateCustomModel,
  onUpdateCustomModel,
  onDeleteCustomModel,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [isAbove, setIsAbove] = useState(true);
  const [editingModel, setEditingModel] = useState<ModelOption | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [actionError, setActionError] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  const current =
    models.find((model) => model.id === selectedModel) ?? models[0];
  if (!current) return null;

  const toggleOpen = () => {
    if (!isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setIsAbove(window.innerHeight - rect.bottom < 390);
    }
    setActionError("");
    setIsOpen((value) => !value);
  };

  const deleteModel = async (model: ModelOption) => {
    if (!onDeleteCustomModel || !model.isCustom) return;
    const confirmed = window.confirm(`确认删除模型“${model.name}”吗？`);
    if (!confirmed) return;

    setActionError("");
    try {
      await onDeleteCustomModel(model.id);
      if (selectedModel === model.id) onSelect("auto");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "删除模型失败");
    }
  };

  const openCreateModal = () => {
    setIsOpen(false);
    setShowCreateModal(true);
  };

  const openEditModal = (model: ModelOption) => {
    setIsOpen(false);
    setEditingModel(model);
  };

  return (
    <>
      <div className="relative h-9 w-[230px]" ref={dropdownRef}>
        <div ref={containerRef}>
          <button
            type="button"
            onClick={toggleOpen}
            className="flex h-9 w-full items-center justify-between gap-2 rounded-[11px] border px-3 text-left transition-all active:scale-[0.99]"
            style={{
              background: isOpen ? "var(--glass-hover)" : COLORS.material,
              borderColor: isOpen ? COLORS.selectionBorder : COLORS.border,
              color: COLORS.text,
            }}
            aria-expanded={isOpen}
          >
            <div className="min-w-0">
              <div className="truncate text-[11px] font-medium">
                {current.name}
              </div>
              <div
                className="truncate text-[9px]"
                style={{ color: COLORS.textSubtle }}
              >
                {current.provider}
              </div>
            </div>
            <svg
              className={`h-3.5 w-3.5 shrink-0 transition-transform ${
                isOpen ? "rotate-180" : ""
              }`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 20 20"
              style={{ color: COLORS.textSubtle }}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.6"
                d="m5.5 7.5 4.5 4.5 4.5-4.5"
              />
            </svg>
          </button>
        </div>

        {isOpen ? (
          <div
            className={`absolute z-50 w-[360px] overflow-hidden rounded-[16px] border p-1.5 ${
              isAbove ? "bottom-full mb-2" : "top-full mt-2"
            }`}
            style={{
              right: 0,
              maxHeight: "382px",
              background: COLORS.materialStrong,
              borderColor: COLORS.border,
              boxShadow: "var(--shadow-card)",
              backdropFilter: "blur(32px) saturate(150%)",
            }}
          >
            <div className="max-h-[310px] overflow-y-auto py-0.5">
              {models.map((model) => {
                const selected = model.id === selectedModel;
                return (
                  <div
                    key={model.id}
                    className="mb-0.5 flex items-stretch rounded-[10px]"
                    style={{
                      background: selected
                        ? COLORS.selection
                        : "transparent",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(model.id);
                        setIsOpen(false);
                      }}
                      className="min-w-0 flex-1 px-3 py-2.5 text-left transition-colors hover:bg-[var(--glass-hover)]"
                      style={{
                        color: selected ? COLORS.text : COLORS.textMuted,
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[12px] font-medium">
                          {model.name}
                        </span>
                        <span
                          className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px]"
                          style={{
                            background: "var(--accent-blue-soft)",
                            color: COLORS.blue,
                          }}
                        >
                          {model.isCustom ? "自定义" : model.provider}
                        </span>
                      </div>
                      <div
                        className="mt-1 truncate text-[10px] leading-4"
                        style={{ color: COLORS.textSubtle }}
                      >
                        {model.description}
                      </div>
                    </button>

                    {model.isCustom &&
                    onUpdateCustomModel &&
                    onDeleteCustomModel ? (
                      <div className="flex shrink-0 items-center gap-1 pr-2 text-[10px]">
                        <button
                          type="button"
                          onClick={() => openEditModal(model)}
                          className="rounded-lg px-2 py-1  hover:bg-[var(--glass-hover)]"
                          title="修改模型"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteModel(model)}
                          className="rounded-lg px-2 py-1 text-red-400 hover:bg-[var(--glass-hover)]"
                          title="删除模型"
                        >
                          删除
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {onCreateCustomModel ? (
              <div
                className="border-t p-1.5"
                style={{ borderColor: COLORS.border }}
              >
                <button
                  type="button"
                  onClick={openCreateModal}
                  className="flex h-9 w-full items-center justify-center rounded-[10px] text-[11px] font-medium hover:bg-[var(--glass-hover)]"
                  style={{ color: COLORS.blue }}
                >
                  ＋ 添加模型
                </button>
                {actionError ? (
                  <p className="px-2 pb-1 text-[10px] text-red-400">
                    {actionError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {showCreateModal && onCreateCustomModel ? (
        <CustomModelModal
          onClose={() => setShowCreateModal(false)}
          onSave={onCreateCustomModel}
        />
      ) : null}
      {editingModel?.customModel && onUpdateCustomModel ? (
        <CustomModelModal
          initial={editingModel.customModel}
          onClose={() => setEditingModel(null)}
          onSave={(input) => onUpdateCustomModel(editingModel.id, input)}
        />
      ) : null}
    </>
  );
}
