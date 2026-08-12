"use client";
/**
 * Skills 管理独立页面：安装 / 列表 / 卸载。
 *
 * 布局采用全页卡片网格（区别于弹窗的纵向列表），支持 Apple 风格
 * 深浅色主题；卸载确认使用自定义弹窗，操作结果通过 Toast 反馈。
 */
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { ThemeMode } from "../../constants/theme";
import { getThemeVariables } from "../../constants/theme";
import { apiFetch } from "../../lib/api-client";
import CustomTitleBar from "../CustomTitleBar";
import { AppleButton } from "../ui/AppleModalControls";
import ConfirmDialog from "./confirm-dialog";
import SkillCard, { type InstalledSkill } from "./skill-card";
import SkillDetailModal from "./skill-detail-modal";
import Toast, { type ToastData } from "./toast";

interface SkillsManagerPageProps {
  /** 当前主题模式 */
  theme: ThemeMode;
  /** 切换主题的回调 */
  onToggleTheme: () => void;
  /** 正在运行的 Agent 数量 */
  runningAgentCount: number;
  /** 返回工作台的回调 */
  onBack: () => void;
  /** 是否隐藏页面（切页时保持挂载，仅切换 display） */
  hidden?: boolean;
}

interface UninstallFailure {
  path?: string;
  error?: string;
}

/** 卸载确认弹窗的状态目标。 */
interface ConfirmTarget {
  skill: InstalledSkill;
}

/** Skills 管理主页面。 */
export default function SkillsManagerPage({
  theme,
  onToggleTheme,
  runningAgentCount,
  onBack,
  hidden = false,
}: SkillsManagerPageProps) {
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);
  const [detailTarget, setDetailTarget] = useState<InstalledSkill | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);

  /** 从后端加载已安装 Skills 列表。 */
  const loadSkills = useCallback(async () => {
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
      const message = caught instanceof Error ? caught.message : "加载失败";
      setError(message);
      setToast({ kind: "error", message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/skills", {
      method: "GET",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`加载失败（HTTP ${response.status}）`);
        }
        const payload = (await response.json()) as { skills?: InstalledSkill[] };
        return payload.skills ?? [];
      })
      .then((items) => {
        if (!cancelled) setSkills(items);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        const message = caught instanceof Error ? caught.message : "加载失败";
        setError(message);
        setToast({ kind: "error", message });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 校验并安装外部 Skill（支持直链与 GitHub 仓库批量安装）。 */
  const installSkill = async (event: FormEvent) => {
    event.preventDefault();
    const target = url.trim();
    if (!target) {
      setError("请输入 Skill 安装地址（SKILL.md 直链或 owner/repo/路径）");
      return;
    }
    setInstalling(true);
    setError("");
    setSuccess("");
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
        installed?: InstalledSkill[];
        failed?: UninstallFailure[];
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || payload.detail || "安装失败");
      }
      const installedCount = payload.installed?.length ?? 0;
      if (installedCount === 1 && payload.installed?.[0]) {
        const message = `已安装 Skill「${payload.installed[0].name}」`;
        setSuccess(message);
        setToast({ kind: "success", message });
      } else if (installedCount > 1) {
        const message = `已安装 ${installedCount} 个 Skill`;
        setSuccess(message);
        setToast({ kind: "success", message });
      }
      const failedCount = payload.failed?.length ?? 0;
      if (failedCount > 0) {
        const firstFailure = payload.failed?.[0];
        const message = `${failedCount} 个 Skill 安装失败：${
          firstFailure?.path || ""
        } ${firstFailure?.error || ""}`.trim();
        setError(message);
        setToast({ kind: "error", message });
      }
      setUrl("");
      await loadSkills();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "安装失败";
      setError(message);
      setToast({ kind: "error", message });
    } finally {
      setInstalling(false);
    }
  };

  /** 确认弹窗确认后执行卸载。 */
  const confirmUninstall = async () => {
    if (!confirmTarget) return;
    const skill = confirmTarget.skill;
    setConfirmTarget(null);
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
      const message = `已卸载 Skill「${skill.name}」`;
      setToast({ kind: "success", message });
      await loadSkills();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "卸载失败";
      setError(message);
      setToast({ kind: "error", message });
    } finally {
      setUninstallingId(null);
    }
  };

  /** 切换 Skill 的总启用开关。 */
  const toggleSkill = async (skill: InstalledSkill) => {
    const nextEnabled = !skill.enabled;
    try {
      const response = await apiFetch(`/api/skills/${skill.id}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: nextEnabled,
          agentIds: skill.agentIds ?? [],
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        error?: string;
        detail?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || payload.detail || "操作失败");
      }
      setToast({
        kind: "success",
        message: nextEnabled
          ? `已启用「${skill.name}」`
          : `已停用「${skill.name}」`,
      });
      await loadSkills();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "操作失败";
      setError(message);
      setToast({ kind: "error", message });
    }
  };

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
      <CustomTitleBar
        theme={theme}
        onToggleTheme={onToggleTheme}
        runningAgentCount={runningAgentCount}
      />

      <div className="mx-auto flex min-h-0 w-full max-w-[1240px] flex-1 flex-col px-6 pb-5 pt-6 lg:px-10">
          {/* 页面头部：返回 + 标题 */}
          <header className="mb-5 flex shrink-0 items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <button
                type="button"
                onClick={onBack}
                aria-label="返回工作台"
                className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-all duration-200 hover:bg-[var(--glass-hover)] active:scale-[0.94]"
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
                  Skills 管理
                </h1>
                <p
                  className="mt-1 text-[12px] leading-5"
                  style={{ color: "var(--text-secondary)" }}
                >
                  支持 SKILL.md 直链或 GitHub 仓库批量安装；安装记录保存在本地数据库，重启后自动恢复。
                </p>
              </div>
            </div>
          </header>

          {/* 安装区 */}
          <form
            onSubmit={(event) => void installSkill(event)}
            className="mb-4 flex shrink-0 items-center gap-2.5 rounded-[18px] border px-4 py-3.5"
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
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="owner/repo/路径 或 https://.../SKILL.md"
              disabled={installing}
              className="h-9 min-w-0 flex-1 rounded-[10px] border bg-[var(--glass-black)] px-3 text-[12px] outline-none transition-colors placeholder:text-[var(--text-tertiary)]"
              style={{
                borderColor: "var(--border)",
                color: "var(--text-primary)",
              }}
            />
            <AppleButton
              type="submit"
              variant="primary"
              size="sm"
              disabled={installing}
              style={{ cursor: "pointer" }}
            >
              {installing ? "安装中…" : "安装"}
            </AppleButton>
          </form>

          {/* 状态提示条 */}
          {error && (
            <div
              className="mb-3 shrink-0 rounded-[12px] border px-3.5 py-2.5 text-[12px] leading-5"
              style={{
                background: "rgba(255,69,58,0.08)",
                borderColor: "rgba(255,69,58,0.18)",
                color: "#ff6961",
              }}
            >
              {error}
            </div>
          )}
          {success && !error && (
            <div
              className="mb-3 shrink-0 rounded-[12px] border px-3.5 py-2.5 text-[12px] leading-5"
              style={{
                background: "rgba(48,209,88,0.08)",
                borderColor: "rgba(48,209,88,0.2)",
                color: "#30d158",
              }}
            >
              {success}
            </div>
          )}

          {/* 统计 + 网格列表 */}
          <div className="mb-3 flex shrink-0 items-center justify-between">
            <span
              className="text-[12px] font-medium"
              style={{ color: "var(--text-secondary)" }}
            >
              已安装 {skills.length} 个 Skill
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {loading ? (
              <div
                className="rounded-[18px] border px-4 py-12 text-center text-[12px]"
                style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
              >
                正在加载已安装的 Skills…
              </div>
            ) : skills.length === 0 ? (
              <div
                className="rounded-[18px] border px-4 py-12 text-center text-[12px]"
                style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
              >
                暂无已安装的 Skills，在上方粘贴地址即可安装。
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {skills.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    uninstalling={uninstallingId === skill.id}
                    onView={setDetailTarget}
                    onToggle={(target) => void toggleSkill(target)}
                    onUninstall={(target) => setConfirmTarget({ skill: target })}
                  />
                ))}
              </div>
            )}
          </div>
      </div>

      {confirmTarget && (
        <ConfirmDialog
          title="卸载 Skill"
          message={`确定要卸载「${confirmTarget.skill.name}」吗？卸载后会同时删除本地文件，可通过重新安装恢复。`}
          confirmLabel="卸载"
          cancelLabel="取消"
          danger
          onConfirm={() => void confirmUninstall()}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
      {detailTarget && (
        <SkillDetailModal
          skill={detailTarget}
          onClose={() => setDetailTarget(null)}
          onConfigSaved={() => {
            setToast({ kind: "success", message: "Skill 配置已保存" });
            void loadSkills();
          }}
        />
      )}
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </main>
  );
}
