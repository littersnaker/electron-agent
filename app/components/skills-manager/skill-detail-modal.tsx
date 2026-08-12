"use client";
/**
 * Skill 详情弹窗：查看完整描述、标签、来源与启用方式。
 *
 * 点击卡片任意位置打开；复制按钮可快速拿到 skill id，
 * 便于配置到 agents/<agent>/agent.yaml 的 skills 列表。
 */
import { useState } from "react";
import { apiFetch } from "../../lib/api-client";
import {
  AppleButton,
  AppleModalCloseButton,
  AppleSwitch,
} from "../ui/AppleModalControls";
import type { InstalledSkill } from "./skill-card";

interface SkillDetailModalProps {
  /** 当前查看的 Skill */
  skill: InstalledSkill;
  /** 关闭弹窗的回调 */
  onClose: () => void;
  /** 保存启用配置成功后的回调（用于刷新列表） */
  onConfigSaved: () => void;
}

/** 可绑定的 Agent 列表。 */
const AGENT_OPTIONS = [
  { id: "coding", label: "Code Agent" },
  { id: "commerce", label: "Commerce Agent" },
  { id: "media", label: "Media Agent" },
  { id: "qa", label: "QA Agent" },
];

/** 把 ISO 时间格式化为本地可读字符串。 */
function formatDate(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Skill 详情弹窗。 */
export default function SkillDetailModal({
  skill,
  onClose,
  onConfigSaved,
}: SkillDetailModalProps) {
  const [copied, setCopied] = useState(false);
  const [enabled, setEnabled] = useState(Boolean(skill.enabled));
  const [agentIds, setAgentIds] = useState<string[]>(skill.agentIds ?? []);
  const [saving, setSaving] = useState(false);
  const [configError, setConfigError] = useState("");

  /** 复制 skill id 到剪贴板并给出短暂反馈。 */
  const copySkillId = async () => {
    try {
      await navigator.clipboard.writeText(skill.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板不可用时静默忽略，不阻塞弹窗。
    }
  };

  /** 切换某个 Agent 的绑定状态。 */
  const toggleAgent = (agentId: string) => {
    setAgentIds((current) =>
      current.includes(agentId)
        ? current.filter((item) => item !== agentId)
        : [...current, agentId],
    );
  };

  /** 保存启用配置到后端。 */
  const saveConfig = async () => {
    setSaving(true);
    setConfigError("");
    try {
      const response = await apiFetch(`/api/skills/${skill.id}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, agentIds }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        detail?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || payload.detail || "保存失败");
      }
      onConfigSaved();
    } catch (caught) {
      setConfigError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center px-6">
      <button
        type="button"
        aria-label="关闭 Skill 详情"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
        style={{
          background: "rgba(7, 8, 12, 0.38)",
          backdropFilter: "blur(18px) saturate(125%)",
          WebkitBackdropFilter: "blur(18px) saturate(125%)",
          cursor: "pointer",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-detail-title"
        className="relative max-h-[86vh] w-[520px] max-w-full overflow-hidden rounded-[24px] border"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--glass-solid) 98%, transparent), color-mix(in srgb, var(--glass-strong) 96%, transparent))",
          borderColor: "var(--border-strong)",
          boxShadow:
            "0 34px 100px rgba(15,23,42,0.35), inset 0 1px 0 rgba(255,255,255,0.28)",
          backdropFilter: "blur(36px) saturate(155%)",
          WebkitBackdropFilter: "blur(36px) saturate(155%)",
        }}
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3
                id="skill-detail-title"
                className="truncate text-[17px] font-semibold tracking-[-0.01em]"
                style={{ color: "var(--text-primary)" }}
              >
                {skill.name}
              </h3>
              <span
                className="shrink-0 rounded-[7px] border px-1.5 py-0.5 text-[10px]"
                style={{
                  borderColor: "var(--border)",
                  color: "var(--text-tertiary)",
                }}
              >
                v{skill.version}
              </span>
            </div>
            <p
              className="mt-1 text-[11px]"
              style={{ color: "var(--text-tertiary)" }}
            >
              {skill.sourceFormat} · 安装于 {formatDate(skill.installedAt)}
            </p>
          </div>
          <AppleModalCloseButton onClick={onClose} />
        </header>

        <div className="max-h-[64vh] overflow-y-auto px-6 pb-6">
          {/* 完整描述 */}
          <section className="mb-5">
            <h4
              className="mb-1.5 text-[11px] font-semibold"
              style={{ color: "var(--text-secondary)" }}
            >
              描述
            </h4>
            <p
              className="whitespace-pre-wrap text-[12px] leading-5"
              style={{ color: "var(--text-secondary)" }}
            >
              {skill.description || "（无描述）"}
            </p>
          </section>

          {/* Skill ID + 复制 */}
          <section className="mb-5">
            <h4
              className="mb-1.5 text-[11px] font-semibold"
              style={{ color: "var(--text-secondary)" }}
            >
              Skill ID
            </h4>
            <div className="flex items-center gap-2">
              <code
                className="min-w-0 flex-1 truncate rounded-[9px] border px-2.5 py-1.5 text-[11px]"
                style={{
                  background: "var(--glass-black)",
                  borderColor: "var(--border)",
                  color: "var(--text-primary)",
                }}
              >
                {skill.id}
              </code>
              <AppleButton
                type="button"
                variant="secondary"
                size="xs"
                onClick={() => void copySkillId()}
                style={{ cursor: "pointer" }}
              >
                {copied ? "已复制" : "复制"}
              </AppleButton>
            </div>
          </section>

          {/* 来源 */}
          <section className="mb-5">
            <h4
              className="mb-1.5 text-[11px] font-semibold"
              style={{ color: "var(--text-secondary)" }}
            >
              来源
            </h4>
            <p
              className="break-all text-[12px] leading-5"
              style={{ color: "var(--text-tertiary)" }}
            >
              {skill.sourceUrl || "本地来源"}
            </p>
          </section>

          {/* 文件状态 */}
          <section className="mb-5">
            <h4
              className="mb-1.5 text-[11px] font-semibold"
              style={{ color: "var(--text-secondary)" }}
            >
              文件状态
            </h4>
            <p
              className="text-[12px]"
              style={{
                color: skill.filesExist ? "#30d158" : "#ff9f0a",
              }}
            >
              {skill.filesExist
                ? "文件完整，可正常使用"
                : "文件缺失，重启后自动从数据库恢复"}
              {typeof skill.hitCount === "number" && skill.hitCount > 0
                ? ` · 已被 Agent 使用 ${skill.hitCount} 次`
                : ""}
            </p>
          </section>

          {/* 启用配置 */}
          <section className="mb-5">
            <h4
              className="mb-1.5 text-[11px] font-semibold"
              style={{ color: "var(--text-secondary)" }}
            >
              启用配置
            </h4>
            <div
              className="rounded-[14px] border px-4 py-3"
              style={{
                background: "var(--glass-soft)",
                borderColor: "var(--border)",
              }}
            >
              <div className="flex items-center justify-between">
                <span
                  className="text-[12px]"
                  style={{ color: "var(--text-secondary)" }}
                >
                  启用 Skill（同时最多 50 个）
                </span>
                <AppleSwitch
                  checked={enabled}
                  ariaLabel={`启用 Skill ${skill.name}`}
                  onChange={() => setEnabled((current) => !current)}
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {AGENT_OPTIONS.map((agent) => {
                  const checked = agentIds.includes(agent.id);
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => toggleAgent(agent.id)}
                      className="flex items-center gap-2 rounded-[10px] border px-2.5 py-2 text-[11px] transition-colors"
                      style={{
                        borderColor: checked
                          ? "rgba(10,132,255,0.35)"
                          : "var(--border)",
                        background: checked
                          ? "rgba(10,132,255,0.08)"
                          : "var(--glass-black)",
                        color: checked
                          ? "var(--accent-blue)"
                          : "var(--text-secondary)",
                        cursor: "pointer",
                      }}
                    >
                      <span
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border"
                        style={{
                          borderColor: checked
                            ? "var(--accent-blue)"
                            : "var(--border-strong)",
                          background: checked ? "var(--accent-blue)" : undefined,
                          color: "#ffffff",
                        }}
                      >
                        {checked && (
                          <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none">
                            <path
                              d="M5 10.5 8.5 14 15 6.5"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </span>
                      {agent.label}
                    </button>
                  );
                })}
              </div>
              {configError && (
                <p
                  className="mt-2 text-[11px]"
                  style={{ color: "#ff6961" }}
                >
                  {configError}
                </p>
              )}
              <div className="mt-3 flex justify-end">
                <AppleButton
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={saving}
                  onClick={() => void saveConfig()}
                  style={{ cursor: "pointer" }}
                >
                  {saving ? "保存中…" : "保存配置"}
                </AppleButton>
              </div>
            </div>
          </section>

          {/* 启用方式说明 */}
          <section
            className="rounded-[14px] border px-4 py-3.5"
            style={{
              background: "var(--glass-soft)",
              borderColor: "var(--border)",
            }}
          >
            <h4
              className="mb-1.5 text-[11px] font-semibold"
              style={{ color: "var(--text-secondary)" }}
            >
              如何让 Agent 使用这个 Skill
            </h4>
            <ul
              className="list-disc space-y-1.5 pl-4 text-[11px] leading-5"
              style={{ color: "var(--text-tertiary)" }}
            >
              <li>
                固定启用：把 skill id（{skill.id}）加入
                agents/&lt;agent&gt;/agent.yaml 的 skills 列表，该 Agent
                每次任务都会加载它。
              </li>
              <li>
                动态启用：给 skill 的 skill.yaml 添加 tags（如
                gsap、react），任务文本提到对应关键词时会自动注入（每个任务最多 2 个）。
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
