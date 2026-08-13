"use client";
/**
 * 模块职责：创建项目后的初始化选项弹窗（git init / README / 前端骨架）。
 * 用户选完目录后弹出；勾选的选项会随 createProject 请求发给后端执行。
 */
import { useState } from "react";

export type ProjectInitOption = "git" | "readme" | "skeleton";

const OPTIONS: ReadonlyArray<{
  id: ProjectInitOption;
  label: string;
  description: string;
}> = [
  {
    id: "git",
    label: "git init",
    description: "在目录中初始化 Git 仓库，方便后续提交与回滚",
  },
  {
    id: "readme",
    label: "生成 README.md",
    description: "写入项目名、创建时间和快速开始说明",
  },
  {
    id: "skeleton",
    label: "前端项目骨架",
    description: "生成最小 Vite + React + TypeScript 骨架（package.json / src）",
  },
];

export function ProjectInitModal({
  folderName,
  onConfirm,
  onCancel,
}: {
  folderName: string;
  onConfirm: (options: ProjectInitOption[]) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<ProjectInitOption[]>([]);

  const toggle = (id: ProjectInitOption) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div
        className="absolute inset-0"
        style={{ background: "rgba(0,0,0,0.4)" }}
        onClick={onCancel}
      />
      <div
        className="relative w-full max-w-md overflow-hidden rounded-[20px] border shadow-2xl"
        style={{
          background: "var(--glass-solid)",
          borderColor: "var(--border)",
          color: "var(--text-primary)",
        }}
      >
        <div className="px-5 pb-4 pt-5">
          <h2 className="text-[16px] font-semibold">初始化项目</h2>
          <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
            目录 <span className="font-mono text-[var(--text-secondary)]">{folderName}</span>{" "}
            创建后，可选执行以下初始化：
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-2 px-5 pb-4">
          {OPTIONS.map((option) => {
            const checked = selected.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => toggle(option.id)}
                className="flex w-full items-start gap-3 rounded-[13px] border px-3 py-2.5 text-left transition-colors hover:bg-[var(--glass-hover)]"
                style={{
                  borderColor: checked
                    ? "var(--accent-blue-border-strong)"
                    : "var(--border)",
                  background: checked ? "var(--accent-blue-soft)" : "var(--glass-soft)",
                }}
              >
                <span
                  className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border"
                  style={{
                    borderColor: checked
                      ? "var(--accent-blue)"
                      : "var(--border-strong)",
                    background: checked ? "var(--accent-blue)" : "transparent",
                  }}
                >
                  {checked && (
                    <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none">
                      <path
                        d="m2.5 6 2.5 2.5 4.5-5"
                        stroke="white"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-[12px] font-semibold">
                    {option.label}
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-4 text-[var(--text-tertiary)]">
                    {option.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div
          className="flex justify-end gap-2 border-t px-5 py-4"
          style={{
            background: "var(--glass-solid)",
            borderColor: "var(--border)",
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            className="h-9 rounded-xl border px-4 text-[11px]"
            style={{ borderColor: "var(--border)" }}
          >
            跳过
          </button>
          <button
            type="button"
            onClick={() => onConfirm(selected)}
            className="h-9 rounded-xl bg-[var(--accent-blue)] px-4 text-[11px] font-semibold text-white"
          >
            创建项目{selected.length > 0 ? `（${selected.length} 项）` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
