"use client";
/**
 * 模块职责：助手思考中的骨架屏。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { useEffect, useState } from "react";
import { COLORS } from "./tool-activity-panel";
export function ThinkingSkeleton({ statusText }: { statusText?: string }) {
  const [lineCount, setLineCount] = useState(2);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setLineCount((previous) => (previous < 4 ? previous + 1 : previous));
    }, 700);
    return () => window.clearInterval(timer);
  }, []);

  const widths = ["78%", "96%", "84%", "62%"];

  return (
    <div className="w-full max-w-xl select-none py-1">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="relative flex h-2.5 w-2.5">
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-40"
            style={{ background: COLORS.blue }}
          />
          <span
            className="relative inline-flex h-2.5 w-2.5 rounded-full"
            style={{ background: COLORS.blue }}
          />
        </span>
        <span
          className="text-[12px] font-medium"
          style={{ color: COLORS.textMuted }}
        >
          {statusText || "正在分析请求…"}
        </span>
      </div>
      <div className="space-y-2.5">
        {Array.from({ length: lineCount }).map((_, index) => (
          <div
            key={index}
            className="h-2.5 animate-pulse rounded-full transition-all duration-300"
            style={{ width: widths[index], background: COLORS.materialStrong }}
          />
        ))}
      </div>
    </div>
  );
}
