"use client";
/**
 * 外部 Skill 管理弹窗：安装 / 列表 / 卸载。
 *
 * 安装地址支持：外部生态标准的 SKILL.md / skill.yaml 直链，或 GitHub
 * 仓库标识（owner/repo[/path]，含 references/scripts 等附加文件）。
 * 安装后由后端写入 SQLite 持久化仓库并导出到 user 级 Skill 目录，
 * 重启后可自动恢复。
 */
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { apiFetch } from "../../lib/api-client";
import {
  AppleButton,
  AppleModalCloseButton,
} from "../ui/AppleModalControls";

interface InstalledSkill {
  id: string;
  name: string;
  version: string;
  description: string;
  sourceUrl: string;
  sourceFormat: string;
  installedAt: string;
  updatedAt: string;
  filesExist: boolean;
}

interface SkillsManagerModalProps {
  onClose: () => void;
}

const COLORS = {
  border: "var(--border)",
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  textTertiary: "var(--text-tertiary)",
};

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

export default function SkillsManagerModal({
  onClose,
}: SkillsManagerModalProps) {
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await apiFetch("/api/skills", {
        method: "GET",
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`加载失败（HTTP ${response.status}）`);
      }
      const payload = (await response.json()) as { skills?: InstalledSkill[] };
      setSkills(payload.skills ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const installSkill = async (event: FormEvent) => {
    event.preventDefault();
    const target = url.trim();
    if (!target) {
      setError("请输入 Skill 安装地址（SKILL.md 直链或 owner/repo/路径）");
      return;
    }
    setInstalling(true);
    setError("");
    try {
      const response = await apiFetch("/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: target }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        detail?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || payload.detail || "安装失败");
      }
      setUrl("");
      await loadSkills();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "安装失败");
    } finally {
      setInstalling(false);
    }
  };

  const uninstallSkill = async (skill: InstalledSkill) => {
    const confirmed = window.confirm(
      `确认卸载 Skill「${skill.name}」？\n卸载后会同时删除本地文件，可通过重新安装恢复。`,
    );
    if (!confirmed) return;
    setUninstallingId(skill.id);
    setError("");
    try {
      const response = await apiFetch(`/api/skills/${skill.id}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        detail?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || payload.detail || "卸载失败");
      }
      await loadSkills();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "卸载失败");
    } finally {
      setUninstallingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center px-4 py-8">
      <button
        type="button"
        aria-label="关闭 Skills 管理弹窗"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
        style={{
          background: "rgba(7, 8, 12, 0.34)",
          backdropFilter: "blur(20px) saturate(125%)",
          WebkitBackdropFilter: "blur(20px) saturate(125%)",
        }}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="skills-manager-title"
        className="relative max-h-[90vh] w-[640px] max-w-full overflow-hidden rounded-[28px] border"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--glass-solid) 98%, transparent), color-mix(in srgb, var(--glass-strong) 96%, transparent))",
          borderColor: COLORS.border,
          boxShadow:
            "0 34px 100px rgba(15,23,42,0.24), inset 0 1px 0 rgba(255,255,255,0.32)",
          backdropFilter: "blur(36px) saturate(155%)",
          WebkitBackdropFilter: "blur(36px) saturate(155%)",
        }}
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-3 pt-6">
          <div>
            <h2
              id="skills-manager-title"
              className="text-[19px] font-semibold tracking-[-0.02em]"
              style={{ color: COLORS.text }}
            >
              Skills 管理
            </h2>
            <p className="mt-2 text-[12px] leading-5" style={{ color: COLORS.textMuted }}>
              支持 SKILL.md 直链或 GitHub 仓库（owner/repo/路径），附加文件
              一并安装；安装记录保存在本地数据库，重启后自动恢复。
            </p>
          </div>
          <AppleModalCloseButton onClick={onClose} />
        </header>

        <div className="max-h-[68vh] overflow-y-auto px-6 pb-5">
          {error && (
            <div
              className="mb-4 rounded-[12px] border px-3.5 py-2.5 text-[12px] leading-5"
              style={{
                background: "rgba(255,69,58,0.08)",
                borderColor: "rgba(255,69,58,0.18)",
                color: "#ff6961",
              }}
            >
              {error}
            </div>
          )}

          <form
            onSubmit={(event) => void installSkill(event)}
            className="mb-5 flex items-center gap-2.5"
          >
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="owner/repo/路径 或 https://.../SKILL.md"
              disabled={installing}
              className="h-9 min-w-0 flex-1 rounded-[10px] border px-3 text-[12px] outline-none transition-colors"
              style={{
                background: "var(--glass)",
                borderColor: "var(--border)",
                color: "var(--text-primary)",
              }}
            />
            <AppleButton
              type="submit"
              variant="primary"
              size="sm"
              disabled={installing}
            >
              {installing ? "安装中…" : "安装"}
            </AppleButton>
          </form>

          {loading ? (
            <div
              className="rounded-[14px] border px-4 py-6 text-center text-[12px]"
              style={{ borderColor: "var(--border)", color: COLORS.textTertiary }}
            >
              正在加载已安装的 Skills…
            </div>
          ) : skills.length === 0 ? (
            <div
              className="rounded-[14px] border px-4 py-6 text-center text-[12px]"
              style={{ borderColor: "var(--border)", color: COLORS.textTertiary }}
            >
              暂无已安装的 Skills，粘贴上方地址即可安装。
            </div>
          ) : (
            <ul className="space-y-2.5">
              {skills.map((skill) => (
                <li
                  key={skill.id}
                  className="rounded-[14px] border px-4 py-3"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className="truncate text-[13px] font-semibold"
                          style={{ color: COLORS.text }}
                        >
                          {skill.name}
                        </span>
                        <span
                          className="shrink-0 rounded-[6px] border px-1.5 py-0.5 text-[10px]"
                          style={{
                            borderColor: "var(--border)",
                            color: COLORS.textTertiary,
                          }}
                        >
                          v{skill.version}
                        </span>
                        {!skill.filesExist && (
                          <span
                            className="shrink-0 rounded-[6px] border px-1.5 py-0.5 text-[10px]"
                            style={{
                              borderColor: "rgba(255,149,0,0.25)",
                              color: "#ff9f0a",
                              background: "rgba(255,149,0,0.08)",
                            }}
                          >
                            文件缺失，重启自动恢复
                          </span>
                        )}
                      </div>
                      {skill.description && (
                        <p
                          className="mt-1 line-clamp-2 text-[12px] leading-5"
                          style={{ color: COLORS.textMuted }}
                        >
                          {skill.description}
                        </p>
                      )}
                      <p
                        className="mt-1.5 truncate text-[11px]"
                        style={{ color: COLORS.textTertiary }}
                      >
                        来源：{skill.sourceUrl}
                      </p>
                      <p
                        className="mt-0.5 text-[11px]"
                        style={{ color: COLORS.textTertiary }}
                      >
                        安装时间：{formatDate(skill.installedAt)} · 格式：
                        {skill.sourceFormat}
                      </p>
                    </div>
                    <AppleButton
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={uninstallingId === skill.id}
                      onClick={() => void uninstallSkill(skill)}
                      style={{ color: "#ff6961", flexShrink: 0 }}
                    >
                      {uninstallingId === skill.id ? "卸载中…" : "卸载"}
                    </AppleButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
