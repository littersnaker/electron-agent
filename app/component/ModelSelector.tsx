"use client";

import { useEffect, useRef, useState } from "react";

interface Model {
  id: string;
  name: string;
}

interface Props {
  models: Model[];
  selectedModel: string;
  onSelect: (modelId: string) => void;
}

const COLORS = {
  text: "#f5f5f7",
  textMuted: "rgba(235, 235, 245, 0.62)",
  textSubtle: "rgba(235, 235, 245, 0.34)",
  material: "rgba(255, 255, 255, 0.055)",
  materialStrong: "rgba(35, 35, 38, 0.94)",
  border: "rgba(255, 255, 255, 0.095)",
  blue: "#0a84ff",
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

  useEffect(() => {
    if (!isOpen || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setIsAbove(window.innerHeight - rect.bottom < 310);
  }, [isOpen]);

  const current = models.find((model) => model.id === selectedModel) ?? models[0];

  if (!current) return null;

  return (
    <div
      className="relative h-9 w-[218px]"
      ref={dropdownRef}
    >
      <div ref={containerRef}>
        <button
          type="button"
          onClick={() => setIsOpen((value) => !value)}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-[11px] border px-3 text-left transition-all active:scale-[0.99]"
          style={{
            background: isOpen ? "rgba(255,255,255,0.085)" : COLORS.material,
            borderColor: isOpen ? "rgba(10,132,255,0.4)" : COLORS.border,
            color: COLORS.text,
            boxShadow: isOpen
              ? "0 0 0 3px rgba(10,132,255,0.09), inset 0 1px 0 rgba(255,255,255,0.05)"
              : "inset 0 1px 0 rgba(255,255,255,0.035)",
          }}
          aria-expanded={isOpen}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px]"
              style={{ background: "rgba(10,132,255,0.13)", color: "#64b5ff" }}
            >
              <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none">
                <path
                  d="M10 2.8c.45 3.35 2.35 5.25 5.7 5.7-3.35.45-5.25 2.35-5.7 5.7-.45-3.35-2.35-5.25-5.7-5.7 3.35-.45 5.25-2.35 5.7-5.7Z"
                  fill="currentColor"
                />
              </svg>
            </span>
            <span className="truncate text-[11px] font-medium">{current.name}</span>
          </div>
          <svg
            className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${
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
          className={`absolute z-50 w-[280px] overflow-hidden rounded-[16px] border p-1.5 ${
            isAbove ? "bottom-full mb-2" : "top-full mt-2"
          }`}
          style={{
            right: 0,
            maxHeight: "292px",
            background: COLORS.materialStrong,
            borderColor: COLORS.border,
            boxShadow:
              "0 26px 70px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.06)",
            backdropFilter: "blur(32px) saturate(150%)",
            WebkitBackdropFilter: "blur(32px) saturate(150%)",
          }}
        >
          <div className="max-h-[278px] overflow-y-auto py-0.5">
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
                  className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06]"
                  style={{
                    background: selected ? "rgba(10,132,255,0.12)" : "transparent",
                    color: selected ? COLORS.text : COLORS.textMuted,
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                    {model.name}
                  </span>
                  {selected && (
                    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" style={{ color: COLORS.blue }}>
                      <path
                        d="m4.5 10.3 3.1 3.1 7.9-7.9"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
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
