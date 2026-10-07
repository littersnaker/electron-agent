/** 模块说明：审批卡片按 approvalKind 的图标与风险说明映射。 */
import type { ReactElement } from "react";

/** 按 approvalKind 区分的图标与风险说明（统一 SVG，替代 emoji）。 */
export const APPROVAL_KIND_META: Record<string, { icon: ReactElement; purpose: string }> = {
  command_run: {
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
        <path d="M5 6.5h14v11H5z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
        <path
          d="m8 10 2 2-2 2M12.5 14h3.5"
          stroke="currentColor"
          strokeWidth="1.55"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
    purpose: "该命令属于安装/初始化类操作，会下载并执行第三方代码。",
  },
  browser_run: {
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.55" />
        <path
          d="M3.5 12h17M12 3.5c2.6 2.3 3.9 5.1 3.9 8.5s-1.3 6.2-3.9 8.5c-2.6-2.3-3.9-5.1-3.9-8.5S9.4 5.8 12 3.5Z"
          stroke="currentColor"
          strokeWidth="1.4"
        />
      </svg>
    ),
    purpose: "Agent 将在内置浏览器中打开并操作真实页面，可能触发页面上的实际副作用。",
  },
  workspace_write: {
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
        <path
          d="m14.5 4.5 5 5L8 21H3v-5z"
          stroke="currentColor"
          strokeWidth="1.55"
          strokeLinejoin="round"
        />
        <path d="m12.5 6.5 5 5" stroke="currentColor" strokeWidth="1.55" />
      </svg>
    ),
    purpose: "该操作会修改工作区文件。",
  },
  comic_storyboard: {
    icon: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
        <rect
          x="3.5"
          y="4.5"
          width="17"
          height="15"
          rx="2"
          stroke="currentColor"
          strokeWidth="1.55"
        />
        <path d="M3.5 8.5h17" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="m10 11.5 4.5 2.5-4.5 2.5z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    ),
    purpose: "确认后将批量生成图片与视频，消耗模型额度。",
  },
};
