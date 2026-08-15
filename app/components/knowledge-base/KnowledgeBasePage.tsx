"use client";
/**
 * 知识库管理独立页面：Jina Key 配置、文档上传、列表、删除与重建索引。
 *
 * 布局沿用 Skills 管理页的 Apple 风格（玻璃卡片 + 深浅色主题）；
 * Jina Key 优先写入 Electron 主进程安全凭证文件，纯浏览器开发模式
 * 回退到 localStorage，保证重启后仍能读到。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ThemeMode } from "../../constants/theme";
import { getThemeVariables } from "../../constants/theme";
import { apiFetch } from "../../lib/api-client";
import CustomTitleBar from "../CustomTitleBar";
import { JinaKeyCard, SettingsCard } from "./knowledge-config-cards";
import { KnowledgeDocumentList } from "./knowledge-document-list";
import {
  ACCEPT_EXTENSIONS,
  FREE_TOKEN_QUOTA,
  JINA_STORAGE_KEY,
  type KnowledgeDocument,
  type KnowledgeStatus,
  type ToastData,
} from "./knowledge-types";

interface KnowledgeBasePageProps {
  /** 当前主题模式 */
  theme: ThemeMode;
  /** 切换主题的回调 */
  onToggleTheme: () => void;
  /** 返回工作台的回调 */
  onBack: () => void;
  /** 是否隐藏页面（切页时保持挂载，仅切换 display） */
  hidden?: boolean;
}

/** 知识库管理主页面。 */
export default function KnowledgeBasePage({
  theme,
  onToggleTheme,
  onBack,
  hidden = false,
}: KnowledgeBasePageProps) {
  const [jinaKey, setJinaKey] = useState("");
  const [keySaving, setKeySaving] = useState(false);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [selectedFileName, setSelectedFileName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /** 展示一次性提示，4 秒后自动消失。 */
  const showToast = useCallback((kind: ToastData["kind"], message: string) => {
    setToast({ kind, message });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  /** 从 Electron 安全凭证读取 Jina Key，纯浏览器模式回退 localStorage。 */
  const loadKey = useCallback(async () => {
    let value = window.localStorage.getItem(JINA_STORAGE_KEY)?.trim() ?? "";
    try {
      const store = await window.electronAPI?.credentials?.read();
      const electronValue = store?.[JINA_STORAGE_KEY]?.trim() ?? "";
      if (electronValue) value = electronValue;
    } catch {
      // 读取失败时继续使用 localStorage 兜底值。
    }
    setJinaKey(value);
  }, []);

  /** 加载知识库状态与文档列表。 */
  const loadData = useCallback(async () => {
    try {
      const [statusResponse, docsResponse] = await Promise.all([
        apiFetch("/api/knowledge/status", { method: "GET", cache: "no-store" }),
        apiFetch("/api/knowledge/documents", {
          method: "GET",
          cache: "no-store",
        }),
      ]);
      if (statusResponse.ok) {
        setStatus((await statusResponse.json()) as KnowledgeStatus);
      }
      if (docsResponse.ok) {
        const payload = (await docsResponse.json()) as {
          documents?: KnowledgeDocument[];
        };
        setDocuments(payload.documents ?? []);
      }
    } catch {
      // 状态加载失败仅静默保留旧数据，操作按钮会单独反馈错误。
    }
  }, []);

  useEffect(() => {
    // 通过 Promise 链延迟执行，避免在 effect 同步体内触发 setState。
    let cancelled = false;
    void Promise.resolve()
      .then(() => loadKey())
      .then(() => {
        if (!cancelled) return loadData();
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [loadKey, loadData]);

  /** 保存 Jina Key 到 Electron 安全凭证。 */
  const saveKey = async () => {
    const value = jinaKey.trim();
    if (!value) {
      showToast("error", "请输入 Jina API Key");
      return;
    }
    setKeySaving(true);
    try {
      // Electron 存在时写入安全凭证；浏览器开发模式至少落 localStorage。
      if (window.electronAPI?.credentials) {
        const store = (await window.electronAPI.credentials.read()) ?? {};
        await window.electronAPI.credentials.write({
          ...store,
          [JINA_STORAGE_KEY]: value,
        });
      }
      window.localStorage.setItem(JINA_STORAGE_KEY, value);
      showToast("success", "Jina API Key 已保存");
      await loadData();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "保存失败";
      showToast("error", message);
    } finally {
      setKeySaving(false);
    }
  };

  /** 上传知识库文档并触发单文档索引。 */
  const uploadDocument = async (event: FormEvent) => {
    event.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await apiFetch("/api/knowledge/documents", {
        method: "POST",
        headers: { "x-jina-api-key": jinaKey.trim() },
        body: form,
      });
      const payload = (await response.json()) as {
        document?: KnowledgeDocument;
        index?: { ok?: boolean; error?: string };
        detail?: string;
      };
      if (!response.ok) {
        throw new Error(payload.detail || "上传失败");
      }
      if (payload.index?.ok === false) {
        showToast("error", `文件已保存，但索引失败：${payload.index.error || ""}`);
      } else {
        showToast("success", `已上传并索引「${payload.document?.filename ?? ""}」`);
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
      setSelectedFileName("");
      await loadData();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "上传失败";
      showToast("error", message);
    } finally {
      setUploading(false);
    }
  };

  /** 删除知识库文档及其向量块。 */
  const deleteDocument = async (documentId: string) => {
    setDeletingId(documentId);
    try {
      const response = await apiFetch(`/api/knowledge/documents/${documentId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const payload = (await response.json()) as { detail?: string };
        throw new Error(payload.detail || "删除失败");
      }
      showToast("success", "文档已删除");
      await loadData();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "删除失败";
      showToast("error", message);
    } finally {
      setDeletingId(null);
    }
  };

  /** 后台重建整个知识库索引。 */
  const reindex = async () => {
    setReindexing(true);
    try {
      const response = await apiFetch("/api/knowledge/reindex", {
        method: "POST",
        headers: { "x-jina-api-key": jinaKey.trim() },
      });
      if (!response.ok) {
        const payload = (await response.json()) as { detail?: string };
        throw new Error(payload.detail || "重建失败");
      }
      showToast("success", "已开始后台重建，稍后刷新可见结果");
      window.setTimeout(() => void loadData(), 1500);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "重建失败";
      showToast("error", message);
    } finally {
      setReindexing(false);
    }
  };

  const remainingTokens = useMemo(() => {
    const used = status?.usage?.totalTokens ?? 0;
    return Math.max(0, FREE_TOKEN_QUOTA - used);
  }, [status]);

  return (
    <main
      data-theme={theme}
      className="theme-transition flex h-screen flex-col overflow-hidden"
      style={{
        ...getThemeVariables(theme),
        display: hidden ? "none" : undefined,
        background:
          "radial-gradient(circle at 72% 12%, var(--app-glow-blue), transparent 28%), radial-gradient(circle at 45% 95%, var(--app-glow-purple), transparent 30%), var(--app-bg)",
        color: "var(--text-primary)",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI', sans-serif",
      }}
    >
      <CustomTitleBar theme={theme} onToggleTheme={onToggleTheme} />

      <div className="mx-auto flex min-h-0 w-full max-w-[1240px] flex-1 flex-col overflow-y-auto px-6 pb-5 pt-6 lg:px-10">
        <header className="mb-5 flex shrink-0 items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={onBack}
              aria-label="返回工作台"
              className="mt-0.5 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-all duration-200 hover:bg-[var(--glass-hover)] hover:border-[var(--border-strong)] active:scale-[0.94]"
              style={{
                background: "var(--glass)",
                borderColor: "var(--border-strong)",
                color: "var(--accent-blue)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14)",
                cursor: "pointer",
              }}
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
                <path
                  d="M12.2 4.5 6.7 10l5.5 5.5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <div>
              <h1
                className="text-[22px] font-semibold tracking-[-0.02em]"
                style={{ color: "var(--text-primary)" }}
              >
                知识库
              </h1>
              <p className="mt-1 text-[12px] leading-5" style={{ color: "var(--text-secondary)" }}>
                上传 .md / .txt / .pdf / .docx 文档，QA 问答会自动检索并引用来源。
              </p>
            </div>
          </div>
        </header>

        <div className="grid w-full min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <section className="flex w-full min-w-0 flex-col gap-4">
            <JinaKeyCard
              value={jinaKey}
              onChange={setJinaKey}
              saving={keySaving}
              onSave={() => void saveKey()}
            />
            <SettingsCard status={status} remainingTokens={remainingTokens} />
          </section>

          <section className="flex w-full min-w-0 flex-col gap-4">
            <form
              onSubmit={(event) => void uploadDocument(event)}
              className="flex w-full min-w-0 shrink-0 items-center gap-2.5 rounded-[18px] border px-4 py-3.5"
              style={{
                background:
                  "linear-gradient(180deg, color-mix(in srgb, var(--glass) 94%, white 6%), var(--glass-soft))",
                borderColor: "var(--border)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1)",
              }}
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none">
                <path
                  d="M10 13.5V4M6.5 8 10 4l3.5 4M4.5 15h11"
                  stroke="currentColor"
                  strokeWidth="1.45"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <input
                ref={fileInputRef}
                type="file"
                name="document"
                accept={ACCEPT_EXTENSIONS}
                className="hidden"
                onChange={(event) => setSelectedFileName(event.target.files?.[0]?.name ?? "")}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-[10px] border px-3 text-[12px] font-medium transition-all duration-150 hover:bg-[var(--glass-hover)] hover:border-[var(--border-strong)] active:scale-[0.98] disabled:opacity-50"
                style={{
                  background: "var(--glass-black)",
                  borderColor: "var(--border)",
                  color: "var(--text-primary)",
                }}
              >
                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
                  <path
                    d="M10 13.5V4M6.5 8 10 4l3.5 4M4.5 15h11"
                    stroke="currentColor"
                    strokeWidth="1.45"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                选择文件
              </button>
              <span
                className="h-9 min-w-0 flex-1 truncate rounded-[10px] border px-3 text-[12px] leading-9"
                style={{
                  borderColor: "var(--border)",
                  background: "var(--glass-black)",
                  color: selectedFileName ? "var(--text-primary)" : "var(--text-tertiary)",
                }}
                title={selectedFileName || ""}
              >
                {selectedFileName || "未选择任何文件"}
              </span>
              <button
                type="submit"
                disabled={uploading}
                className="h-9 shrink-0 cursor-pointer rounded-[10px] px-4 text-[12px] font-medium transition-all hover:opacity-90 hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: "var(--accent-blue)", color: "#ffffff" }}
              >
                {uploading ? (
                  <>
                    <svg
                      viewBox="0 0 20 20"
                      className="h-3.5 w-3.5 animate-spin"
                      fill="none"
                      aria-hidden="true"
                    >
                      <circle
                        cx="10"
                        cy="10"
                        r="7"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeDasharray="30 14"
                        strokeLinecap="round"
                      />
                    </svg>
                    上传中…
                  </>
                ) : (
                  "上传并索引"
                )}
              </button>
            </form>

            {uploading && (
              <div
                className="flex shrink-0 items-center gap-2 rounded-[12px] border px-3 py-2 text-[11px]"
                style={{
                  borderColor: "rgba(48,209,88,0.25)",
                  background: "rgba(48,209,88,0.06)",
                  color: "var(--text-secondary)",
                }}
              >
                <svg
                  viewBox="0 0 20 20"
                  className="h-3.5 w-3.5 animate-spin"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    cx="10"
                    cy="10"
                    r="7"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeDasharray="30 14"
                    strokeLinecap="round"
                  />
                </svg>
                正在上传并索引：文档切块与向量化中，请稍候…
              </div>
            )}

            <div className="flex shrink-0 items-center justify-between">
              <h2 className="text-[13px] font-semibold">文档列表（{documents.length}）</h2>
              <button
                type="button"
                onClick={() => void reindex()}
                disabled={reindexing || uploading}
                className="h-8 cursor-pointer rounded-[10px] border px-3 text-[11px] font-medium transition-all duration-150 hover:bg-[var(--glass-hover)] hover:border-[var(--border-strong)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  background: "var(--glass)",
                  borderColor: "var(--border)",
                  color: "var(--text-secondary)",
                }}
              >
                {reindexing ? "重建中…" : "重建全部索引"}
              </button>
            </div>

            <div className="space-y-2.5 pr-1 lg:max-h-[calc(100vh-330px)] lg:overflow-y-auto">
              <KnowledgeDocumentList
                documents={documents}
                deletingId={deletingId}
                onDelete={(documentId) => void deleteDocument(documentId)}
              />
            </div>
          </section>
        </div>
      </div>

      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
          <div
            className="rounded-[14px] border px-4 py-2.5 text-[12px] shadow-2xl"
            style={{
              background: "var(--glass)",
              borderColor:
                toast.kind === "success" ? "rgba(48,209,88,0.28)" : "rgba(255,69,58,0.28)",
              color: toast.kind === "success" ? "#34d97b" : "#ff6961",
              backdropFilter: "blur(24px) saturate(130%)",
            }}
          >
            {toast.message}
          </div>
        </div>
      )}
    </main>
  );
}
