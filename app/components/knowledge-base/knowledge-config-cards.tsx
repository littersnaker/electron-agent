"use client";
/**
 * 知识库左侧配置卡片：Jina API Key 输入与检索配置概览。
 */
import type { KnowledgeStatus } from "./knowledge-types";
import { formatTokens } from "./knowledge-types";

interface JinaKeyCardProps {
  /** 当前输入框中的 Key 值 */
  value: string;
  /** 输入变化回调 */
  onChange: (value: string) => void;
  /** 是否正在保存 */
  saving: boolean;
  /** 点击保存按钮的回调 */
  onSave: () => void;
}

/** Jina API Key 配置卡片。 */
export function JinaKeyCard({ value, onChange, saving, onSave }: JinaKeyCardProps) {
  return (
    <div
      className="rounded-[18px] border p-4"
      style={{
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--glass) 94%, white 6%), var(--glass-soft))",
        borderColor: "var(--border)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1)",
      }}
    >
      <h2 className="text-[13px] font-semibold">Jina API Key</h2>
      <p className="mt-1 text-[11px] leading-4" style={{ color: "var(--text-tertiary)" }}>
        免费额度 10 万 Token（非商用），embedding 与重排共用。
      </p>
      <input
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="jina_xxxxxxxx"
        className="mt-3 h-9 w-full rounded-[10px] border bg-[var(--glass-black)] px-3 text-[12px] outline-none transition-colors placeholder:text-[var(--text-tertiary)]"
        style={{ borderColor: "var(--border)", color: "var(--text-primary)" }}
      />
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="mt-2.5 h-9 w-full cursor-pointer rounded-[10px] text-[12px] font-medium transition-all hover:opacity-90 hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
        style={{ background: "var(--accent-blue)", color: "#ffffff" }}
      >
        {saving ? "保存中…" : "保存 Key"}
      </button>
    </div>
  );
}

interface SettingsCardProps {
  /** 知识库配置状态 */
  status: KnowledgeStatus | null;
  /** 免费额度剩余 Token 数 */
  remainingTokens: number;
}

/** 检索配置与额度概览卡片。 */
export function SettingsCard({ status, remainingTokens }: SettingsCardProps) {
  return (
    <div
      className="rounded-[18px] border p-4"
      style={{
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--glass) 94%, white 6%), var(--glass-soft))",
        borderColor: "var(--border)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1)",
      }}
    >
      <h2 className="text-[13px] font-semibold">检索配置</h2>
      <dl className="mt-3 space-y-2 text-[11px]">
        <div className="flex justify-between">
          <dt style={{ color: "var(--text-tertiary)" }}>向量模型</dt>
          <dd className="truncate pl-3">{status?.embeddingModel ?? "—"}</dd>
        </div>
        <div className="flex justify-between">
          <dt style={{ color: "var(--text-tertiary)" }}>重排模型</dt>
          <dd className="truncate pl-3">{status?.rerankModel ?? "—"}</dd>
        </div>
        <div className="flex justify-between">
          <dt style={{ color: "var(--text-tertiary)" }}>召回 / 精排</dt>
          <dd>{status ? `${status.recallK} / ${status.topK}` : "—"}</dd>
        </div>
        <div className="flex justify-between">
          <dt style={{ color: "var(--text-tertiary)" }}>父子检索</dt>
          <dd>{status?.parentChildEnabled ? "已开启" : "已关闭"}</dd>
        </div>
        <div className="flex justify-between">
          <dt style={{ color: "var(--text-tertiary)" }}>Token 消耗</dt>
          <dd>{status ? formatTokens(status.usage.totalTokens) : "—"}</dd>
        </div>
        <div className="flex justify-between">
          <dt style={{ color: "var(--text-tertiary)" }}>免费额度剩余</dt>
          <dd>{status ? formatTokens(remainingTokens) : "—"}</dd>
        </div>
      </dl>
      {status && !status.hasApiKey && (
        <p
          className="mt-3 rounded-[10px] border px-3 py-2 text-[11px] leading-4"
          style={{
            borderColor: "rgba(255,196,0,0.28)",
            background: "rgba(255,196,0,0.08)",
            color: "#f0c648",
          }}
        >
          尚未配置 Key：问答与代码检索会自动回退为关键词检索。
        </p>
      )}
    </div>
  );
}
