"use client";
// 模块说明：等待模型响应时沿用 ThoughtLine，避免生成模拟进度。
import ThoughtLine from "./ThoughtLine";
export function ThinkingSkeleton({
  statusText,
  working = true,
}: {
  statusText?: string;
  working?: boolean;
}) {
  return (
    <ThoughtLine
      label={statusText || "正在思考…"}
      doneLabel="暂无回复"
      working={working}
      collapsible={false}
      showTimer={working}
    />
  );
}
