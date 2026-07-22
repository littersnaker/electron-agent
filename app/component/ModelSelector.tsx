"use client";

import { useEffect, useRef, useState } from "react";
import type { ModelOption } from "../const/modelList";

interface Props {
  models: readonly ModelOption[];
  selectedModel: string;
  onSelect: (modelId: string) => void;
}

const COLORS = {
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  textSubtle: "var(--text-tertiary)",
  material: "var(--glass)",
  materialStrong: "var(--glass-solid)",
  border: "var(--border)",
  blue: "var(--accent-blue)",
};

export default function ModelSelector({
  models,
  selectedModel,
  onSelect,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [isAbove, setIsAbove] = useState(true);
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
      setIsAbove(window.innerHeight - rect.bottom < 330);
    }
    setIsOpen((value) => !value);
  };

  return (
    <div className="relative h-9 w-[230px]" ref={dropdownRef}>
      <div ref={containerRef}>
        <button
          type="button"
          onClick={toggleOpen}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-[11px] border px-3 text-left transition-all active:scale-[0.99]"
          style={{
            background: isOpen ? "var(--glass-hover)" : COLORS.material,
            borderColor: isOpen ? "rgba(10,132,255,0.4)" : COLORS.border,
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

      {isOpen && (
        <div
          className={`absolute z-50 w-[320px] overflow-hidden rounded-[16px] border p-1.5 ${
            isAbove ? "bottom-full mb-2" : "top-full mt-2"
          }`}
          style={{
            right: 0,
            maxHeight: "322px",
            background: COLORS.materialStrong,
            borderColor: COLORS.border,
            boxShadow: "var(--shadow-card)",
            backdropFilter: "blur(32px) saturate(150%)",
          }}
        >
          <div className="max-h-[306px] overflow-y-auto py-0.5">
            {models.map((model) => {
              const selected = model.id === selectedModel;
              return (
                <button
                  type="button"
                  key={model.id}
                  onClick={() => {
                    onSelect(model.id);
                    setIsOpen(false);
                  }}
                  className="flex w-full items-start gap-2 rounded-[10px] px-3 py-2.5 text-left transition-colors hover:bg-[var(--glass-hover)]"
                  style={{
                    background: selected
                      ? "rgba(10,132,255,0.12)"
                      : "transparent",
                    color: selected ? COLORS.text : COLORS.textMuted,
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[12px] font-medium">
                        {model.name}
                      </span>
                      <span
                        className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px]"
                        style={{
                          background: "rgba(10,132,255,0.1)",
                          color: COLORS.blue,
                        }}
                      >
                        {model.provider}
                      </span>
                    </div>
                    <div
                      className="mt-1 text-[10px] leading-4"
                      style={{ color: COLORS.textSubtle }}
                    >
                      {model.description}
                    </div>
                  </div>
                  {selected && (
                    <span style={{ color: COLORS.blue }}>✓</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
