// 模块说明：角色设定图库管理弹窗（网格角色卡 + 删除）。
"use client";

import { useEffect, useRef, useState } from "react";
import type { CharacterLibraryAsset } from "../../hooks/useCharacterLibrary";
import { AppleButton, AppleModalCloseButton } from "../ui/AppleModalControls";

interface CharacterLibraryModalProps {
  open: boolean;
  assets: CharacterLibraryAsset[];
  loaded: boolean;
  error: string;
  onDelete: (assetId: string) => Promise<void>;
  onReload: () => Promise<void>;
  onClose: () => void;
}

/** 角色设定图库：跨会话复用设定图，删除后下次生成会重新出图并入库。 */
export default function CharacterLibraryModal({
  open,
  assets,
  loaded,
  error,
  onDelete,
  onReload,
  onClose,
}: CharacterLibraryModalProps) {
  const [deletingId, setDeletingId] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('button[aria-label="关闭弹窗"]')?.focus();
    void onReload();
    return () => dialog.close();
  }, [open, onReload]);
  const close = () => {
    dialogRef.current?.close();
    onClose();
  };
  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="character-library-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent px-4 py-10 open:flex backdrop:bg-transparent"
    >
      <button
        type="button"
        aria-label="关闭角色库"
        tabIndex={-1}
        onClick={close}
        className="absolute inset-0 cursor-pointer"
        style={{
          background: "rgba(7, 8, 12, 0.34)",
          backdropFilter: "blur(20px) saturate(125%)",
          WebkitBackdropFilter: "blur(20px) saturate(125%)",
        }}
      />

      <section
        className="relative flex max-h-[76vh] w-full max-w-155 flex-col overflow-hidden rounded-[28px] border"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--glass-solid) 98%, transparent), color-mix(in srgb, var(--glass-strong) 96%, transparent))",
          borderColor: "var(--border)",
          boxShadow: "0 34px 100px rgba(15,23,42,0.24), inset 0 1px 0 rgba(255,255,255,0.32)",
          backdropFilter: "blur(36px) saturate(155%)",
          WebkitBackdropFilter: "blur(36px) saturate(155%)",
        }}
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6">
          <div className="min-w-0 flex-1">
            <h2
              id="character-library-title"
              className="text-[18px] font-semibold tracking-tight text-(--text-primary)"
            >
              角色库
            </h2>
            <p className="mt-1 max-w-120 text-[12px] leading-5 text-(--text-tertiary)">
              已保存的角色设定图会自动复用。角色描述或出图模型变化时生成新图；删除后下次会重新生成。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <AppleButton
              variant="ghost"
              disabled={!loaded || Boolean(deletingId)}
              onClick={() => void onReload()}
            >
              刷新
            </AppleButton>
            <AppleModalCloseButton onClick={close} />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {error && (
            <p role="alert" className="mb-3 text-[12px] text-(--accent-red)">
              {error}
            </p>
          )}
          {!loaded && (
            <p role="status" className="mb-3 text-[12px] text-(--text-tertiary)">
              正在加载角色库…
            </p>
          )}
          {loaded && !error && assets.length === 0 ? (
            <div className="rounded-[16px] border px-4 py-6 text-center text-[12px] text-(--text-tertiary)">
              角色库还是空的。跑一次漫剧后，生成的角色设定图会自动入库。
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {assets.map((asset) => (
                <div
                  key={asset.id}
                  className="overflow-hidden rounded-[16px] border"
                  style={{
                    background: "color-mix(in srgb, var(--glass-soft) 92%, transparent)",
                    borderColor: "var(--border)",
                  }}
                >
                  <div
                    className="flex h-[150px] items-center justify-center overflow-hidden"
                    style={{ background: "color-mix(in srgb, var(--app-bg) 65%, transparent)" }}
                  >
                    {asset.dataUrl ? (
                      <img
                        src={asset.dataUrl}
                        alt={asset.name}
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <span className="text-[11px] text-(--text-tertiary)">预览不可用</span>
                    )}
                  </div>
                  <div className="space-y-1 px-3 py-2">
                    <div className="truncate text-[12px] font-semibold text-(--text-primary)">
                      {asset.name}
                    </div>
                    <div className="truncate text-[10px] text-(--text-tertiary)">
                      {asset.modelId} · {new Date(asset.createdAt).toLocaleDateString()}
                    </div>
                    <button
                      type="button"
                      aria-label={`删除角色 ${asset.name}`}
                      disabled={!loaded || Boolean(deletingId)}
                      onClick={() => {
                        setDeletingId(asset.id);
                        void onDelete(asset.id).finally(() => setDeletingId(""));
                      }}
                      className="mt-1 w-full rounded-[8px] border px-2 py-1 text-[10px] font-semibold text-(--accent-red) transition-all active:scale-[0.98] disabled:opacity-40"
                      style={{
                        borderColor: "color-mix(in srgb, var(--accent-red) 35%, var(--border))",
                      }}
                    >
                      {deletingId === asset.id ? "删除中…" : "删除"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </dialog>
  );
}
