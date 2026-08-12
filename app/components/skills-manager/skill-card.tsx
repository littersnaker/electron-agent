"use client";
/**
 * Skill 卡片：网格布局中的单个 Skill 展示单元。
 *
 * 包含名称、版本、描述、来源、安装时间与卸载入口；
 * 全部使用主题 CSS 变量，深色/浅色模式自动适配。
 */

export interface InstalledSkill {
  id: string;
  name: string;
  version: string;
  description: string;
  sourceUrl: string;
  sourceFormat: string;
  installedAt: string;
  updatedAt: string;
  filesExist: boolean;
  enabled?: boolean;
  agentIds?: string[];
  hitCount?: number;
}

interface SkillCardProps {
  /** 当前 Skill 数据 */
  skill: InstalledSkill;
  /** 是否正在卸载该 Skill */
  uninstalling: boolean;
  /** 点击卡片查看详情的回调 */
  onView: (skill: InstalledSkill) => void;
  /** 切换启用状态的回调 */
  onToggle: (skill: InstalledSkill) => void;
  /** 点击卸载按钮的回调 */
  onUninstall: (skill: InstalledSkill) => void;
}

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

/** 单张 Skill 卡片。 */
export default function SkillCard({
  skill,
  uninstalling,
  onView,
  onToggle,
  onUninstall,
}: SkillCardProps) {
  const isEnabled = Boolean(skill.enabled && skill.agentIds?.length);

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={() => onView(skill)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onView(skill);
        }
      }}
      className="flex min-w-0 cursor-pointer flex-col rounded-[18px] border p-4 transition-all duration-200 hover:-translate-y-0.5"
      style={{
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--glass) 92%, white 8%), var(--glass-soft))",
        borderColor: "var(--border)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3
            className="truncate text-[14px] font-semibold tracking-[-0.01em]"
            style={{ color: "var(--text-primary)" }}
          >
            {skill.name}
          </h3>
          <span
            className="mt-1 inline-block rounded-[7px] border px-1.5 py-0.5 text-[10px]"
            style={{
              borderColor: isEnabled
                ? "rgba(48,209,88,0.28)"
                : "var(--border)",
              background: isEnabled ? "rgba(48,209,88,0.08)" : undefined,
              color: isEnabled ? "#30d158" : "var(--text-tertiary)",
            }}
          >
            {isEnabled ? "已启用" : "未启用"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className="rounded-[8px] border px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              borderColor: "var(--border)",
              color: "var(--text-tertiary)",
            }}
          >
            v{skill.version}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={isEnabled}
            aria-label={`切换 ${skill.name} 启用状态`}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(skill);
            }}
            className="relative h-[20px] w-[34px] rounded-full border transition-colors duration-200"
            style={{
              background: isEnabled ? "#30d158" : "var(--glass-active)",
              borderColor: isEnabled
                ? "rgba(48,209,88,0.4)"
                : "var(--border-strong)",
              cursor: "pointer",
              boxShadow: isEnabled
                ? "inset 0 1px 2px rgba(0,0,0,0.18)"
                : "inset 0 1px 2px rgba(0,0,0,0.12)",
            }}
          >
            <span
              className="absolute top-[2px] h-[14px] w-[14px] rounded-full transition-all duration-200"
              style={{
                left: isEnabled ? "17px" : "2px",
                background: "#ffffff",
                boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
              }}
            />
          </button>
        </div>
      </div>

      {skill.description && (
        <p
          className="mt-2 line-clamp-3 min-h-[48px] text-[12px] leading-[16px]"
          style={{ color: "var(--text-secondary)" }}
        >
          {skill.description}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        <span
          className="rounded-[7px] border px-1.5 py-0.5 text-[10px]"
          style={{
            borderColor: "var(--border)",
            color: "var(--text-tertiary)",
          }}
        >
          {skill.sourceFormat}
        </span>
        {!skill.filesExist && (
          <span
            className="rounded-[7px] border px-1.5 py-0.5 text-[10px]"
            style={{
              borderColor: "rgba(255,149,0,0.28)",
              background: "rgba(255,149,0,0.08)",
              color: "#ff9f0a",
            }}
          >
            文件缺失，重启自动恢复
          </span>
        )}
      </div>

      <div className="mt-3 min-w-0 flex-1">
        <p
          className="truncate text-[11px]"
          style={{ color: "var(--text-tertiary)" }}
          title={skill.sourceUrl}
        >
          {skill.sourceUrl || "本地来源"}
        </p>
        <p
          className="mt-0.5 text-[11px]"
          style={{ color: "var(--text-tertiary)" }}
        >
          安装于 {formatDate(skill.installedAt)}
          {typeof skill.hitCount === "number" && skill.hitCount > 0
            ? ` · 已使用 ${skill.hitCount} 次`
            : ""}
        </p>
      </div>

      <div className="mt-3 flex justify-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
        <button
          type="button"
          disabled={uninstalling}
          onClick={(event) => {
            event.stopPropagation();
            onUninstall(skill);
          }}
          className="flex h-7 items-center gap-1.5 rounded-[9px] border px-2.5 text-[11px] font-medium transition-all duration-200 hover:brightness-110 active:scale-[0.95] disabled:pointer-events-none disabled:opacity-40"
          style={{
            background: "rgba(255,69,58,0.08)",
            borderColor: "rgba(255,69,58,0.22)",
            color: "#ff453a",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
            cursor: "pointer",
          }}
        >
          <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none">
            <path
              d="M4.5 6.2h11M8.2 6.2V4.8c0-.5.4-.9.9-.9h1.8c.5 0 .9.4.9.9v1.4M6.4 6.2l.5 8.1c0 .6.5 1.1 1.1 1.1h4c.6 0 1.1-.5 1.1-1.1l.5-8.1M8.5 8.8v4.4M11.5 8.8v4.4"
              stroke="currentColor"
              strokeWidth="1.35"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {uninstalling ? "卸载中…" : "卸载"}
        </button>
      </div>
    </article>
  );
}
