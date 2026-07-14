// src/components/ModelSelector.tsx
import { useState, useRef, useEffect } from "react";

// 沿用你现有的配色系统
const T = {
  surface: "#16161f",
  surfaceHover: "#1d1d2a",
  border: "#26263a",
  fg: "#ededf2",
  accent: "#8b5cf6",
};

interface Model {
  id: string;
  name: string;
}

interface Props {
  models: Model[];
  selectedModel: string;
  onSelect: (modelId: string) => void;
}

export default function ModelSelector({ models, selectedModel, onSelect }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const current = models.find((m) => m.id === selectedModel) || models[0];

  return (
    <div className="relative w-64 h-8" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 h-8 rounded-lg border text-sm transition-all duration-200"
        style={{
          background: T.surface,
          borderColor: isOpen ? T.accent : T.border,
          color: T.fg,
        }}
      >
        <span className="truncate">{current.name}</span>
        <svg 
          className={`w-4 h-4 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`} 
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div 
          className="absolute z-50 w-full mt-2 py-1 rounded-lg border shadow-xl animate-in fade-in zoom-in-95 duration-150"
          style={{ background: T.surface, borderColor: T.border }}
        >
          {models.map((model) => (
            <button
              key={model.id}
              onClick={() => {
                onSelect(model.id);
                setIsOpen(false);
              }}
              className="w-full text-left px-4 py-3 hover:bg-[#1d1d2a] transition-colors group"
            >
              <div className="text-sm font-medium text-white group-hover:text-purple-400">
                {model.name}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}